import type { ShoppingItem } from '../llm/gemini-client.js';
import { McpAuthError, type SwiggyOAuth } from '../mcp/swiggy-oauth.js';
import type { OrderIntakeService } from './order-intake-service.js';
import type { OrderStore } from './order-store.js';
import type {
  DeliveryAddress,
  DraftOrder,
  McpAuthState,
  OrderJob,
  PendingItem,
  ResolvedDraftItem,
  ResolvedSkuOption,
  TransportMessage,
} from './types.js';
import type { SwiggyOrderWorkerInterface } from './swiggy-order-worker.js';

export interface OrderRuntimeMetrics {
  messagesReceived: number;
  ignoredMessages: number;
  draftsCreated: number;
  jobsQueued: number;
  jobsProcessed: number;
  jobsFailed: number;
  searchesPerformed: number;
  productsAdded: number;
  voiceNotesProcessed: number;
  errors: number;
}

interface SendBotMessageInput {
  chatId: string;
  senderId: string;
  text: string;
  replyToMessageId?: string;
  draftOrderId?: string;
  jobId?: string;
  eventType: string;
}

interface SendBotMessageResult {
  id?: string;
}

type SendBotMessage = (input: SendBotMessageInput) => Promise<SendBotMessageResult>;
type DownloadVoiceMedia = (message: TransportMessage) => Promise<{ buffer: Buffer; mimetype: string }>;
type LogFn = (message: string) => void;

const CONFIRM_WORDS = new Set([
  'yes', 'y', 'ya', 'yeah', 'yup', 'ok', 'okay', 'okey', 'confirm', 'go', 'place',
]);

const CANCEL_WORDS = new Set([
  'no', 'cancel', 'stop', 'abort', 'nope',
]);

const PENDING_ITEM_TTL_MS = 24 * 60 * 60 * 1000;
// Plain-text compile window: only count this sender's text messages from the
// last 4h, max 5 of them. Voice notes are unbounded (24h TTL still applies).
const TEXT_COMPILE_WINDOW_MS = 4 * 60 * 60 * 1000;
const TEXT_COMPILE_LIMIT = 5;
// If a draft is older than this when a new `order:` arrives, prompt the user
// rather than silently appending — they may have walked away and forgotten.
const STALE_DRAFT_THRESHOLD_MS = 30 * 60 * 1000;

export class OrderOrchestrator {
  private drainingQueue = false;

  constructor(
    private readonly store: OrderStore,
    private readonly intake: OrderIntakeService,
    private readonly worker: SwiggyOrderWorkerInterface,
    private readonly oauth: SwiggyOAuth,
    private readonly sendBotMessage: SendBotMessage,
    private readonly downloadVoiceMedia: DownloadVoiceMedia,
    private readonly metrics: OrderRuntimeMetrics,
    private readonly log: LogFn,
  ) {}

  async recoverAndResume() {
    const interruptedJobs = this.store.recoverInterruptedJobs();
    for (const job of interruptedJobs) {
      this.store.recordEvent({
        chatId: job.chatId,
        senderId: job.senderId,
        draftOrderId: job.draftOrderId,
        jobId: job.id,
        direction: 'system',
        eventType: 'job.recovered_as_failed',
        text: 'Marked as failed after process restart.',
      });
      this.metrics.jobsFailed += 1;
    }

    await this.drainQueue();
  }

  async handleMessage(message: TransportMessage) {
    const body = message.body.trim();
    const normalizedBody = body.toLowerCase();

    if (message.isVoiceNote) {
      await this.accumulateVoiceNote(message);
      return;
    }

    if (normalizedBody === '!login') {
      await this.handleLogin(message);
      return;
    }

    if (normalizedBody.startsWith('!paste:') || normalizedBody.startsWith('!paste ')) {
      const rest = body.slice(normalizedBody.startsWith('!paste:') ? '!paste:'.length : '!paste '.length).trim();
      await this.handlePasteCallback(message, rest);
      return;
    }

    if (normalizedBody === '!logout') {
      await this.handleLogout(message);
      return;
    }

    if (normalizedBody === '!status') {
      await this.handleStatus(message);
      return;
    }

    if (normalizedBody === '!help' || normalizedBody === '!commands') {
      await this.handleHelp(message);
      return;
    }

    if (normalizedBody === '!address' || normalizedBody.startsWith('!address ') || normalizedBody.startsWith('!address:')) {
      await this.handleAddressCommand(message, body);
      return;
    }

    if (normalizedBody === '!pick' || normalizedBody.startsWith('!pick ') || normalizedBody.startsWith('!pick:')) {
      await this.handlePickCommand(message, body);
      return;
    }

    if (normalizedBody === '!alias' || normalizedBody.startsWith('!alias ') || normalizedBody.startsWith('!alias:')) {
      await this.handleAliasCommand(message, body);
      return;
    }

    if (normalizedBody === '!qty' || normalizedBody.startsWith('!qty ') || normalizedBody.startsWith('!qty:')) {
      await this.handleQtyCommand(message, body);
      return;
    }

    if (normalizedBody.startsWith('order:')) {
      await this.handleTextOrder(message, body.slice('order:'.length).trim(), 'order');
      return;
    }

    if (normalizedBody.startsWith('add:')) {
      await this.handleTextOrder(message, body.slice('add:'.length).trim(), 'add');
      return;
    }

    if (normalizedBody === 'order') {
      await this.compileDraftFromPending(message);
      return;
    }

    if (this.isControlReply(normalizedBody)) {
      const handled = await this.handleControlReply(message, body);
      if (!handled) {
        this.metrics.ignoredMessages += 1;
      }
      return;
    }

    if (body.length > 0) {
      this.accumulateTextMessage(message, body);
      return;
    }

    this.metrics.ignoredMessages += 1;
  }

  private isControlReply(normalizedBody: string): boolean {
    return (
      CONFIRM_WORDS.has(normalizedBody) ||
      CANCEL_WORDS.has(normalizedBody) ||
      normalizedBody.startsWith('edit:')
    );
  }

  private async accumulateVoiceNote(message: TransportMessage) {
    try {
      const media = await this.downloadVoiceMedia(message);
      const transcription = await this.intake.transcribeVoice(media.buffer, media.mimetype);
      this.metrics.voiceNotesProcessed += 1;

      this.store.addPendingItem({
        chatId: message.chatId,
        senderId: message.senderId,
        messageId: message.id,
        sourceType: 'voice',
        rawInput: transcription,
        transcription,
      });

      this.store.recordEvent({
        chatId: message.chatId,
        senderId: message.senderId,
        direction: 'system',
        eventType: 'pending.voice_accumulated',
        messageId: message.id,
        text: transcription,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.metrics.errors += 1;
      this.log(`Voice transcription failed for ${message.senderId}: ${errorMessage}`);
      this.store.recordEvent({
        chatId: message.chatId,
        senderId: message.senderId,
        direction: 'system',
        eventType: 'pending.voice_failed',
        messageId: message.id,
        text: errorMessage,
      });
    }
  }

  private accumulateTextMessage(message: TransportMessage, body: string) {
    this.store.addPendingItem({
      chatId: message.chatId,
      senderId: message.senderId,
      messageId: message.id,
      sourceType: 'text',
      rawInput: body,
    });

    this.store.recordEvent({
      chatId: message.chatId,
      senderId: message.senderId,
      direction: 'system',
      eventType: 'pending.text_accumulated',
      messageId: message.id,
      text: body,
    });
  }

  private async compileDraftFromPending(message: TransportMessage) {
    this.store.deleteStalePendingItems(message.chatId, PENDING_ITEM_TTL_MS);
    const pending = this.store.getPendingForCompile(
      message.chatId,
      message.senderId,
      TEXT_COMPILE_WINDOW_MS,
      TEXT_COMPILE_LIMIT,
    );

    if (pending.length === 0) {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: 'Nothing queued yet. Send voice notes or plain text (e.g. "dal, atta") first, then type `order`. Or send `order: <items>` directly.',
        replyToMessageId: message.id,
        eventType: 'draft.rejected.no_pending',
      });
      return;
    }

    const activeDraft = this.store.getActiveDraft(message.chatId, message.senderId);
    if (activeDraft && activeDraft.status !== 'pending_confirmation') {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: this.buildActiveJobBlocker(activeDraft),
        replyToMessageId: message.id,
        draftOrderId: activeDraft.id,
        eventType: 'draft.rejected.active_job',
      });
      return;
    }

    const combinedTranscription = this.combineTranscriptions(pending);
    const pendingSourceType: 'voice' | 'text' = pending.some((p) => p.sourceType === 'voice') ? 'voice' : 'text';
    const hasVoiceTranscription = pending.some((p) => p.sourceType === 'voice');

    // Stale-draft prompt — same UX as `order:` against an old draft.
    if (activeDraft && Date.now() - activeDraft.updatedAt >= STALE_DRAFT_THRESHOLD_MS) {
      const minsAgo = Math.round((Date.now() - activeDraft.updatedAt) / 60000);
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: `You have a draft from ~${minsAgo} min ago (${activeDraft.parsedItems.length} item${activeDraft.parsedItems.length === 1 ? '' : 's'}). Reply \`cancel\` to discard it, then send \`order\` again to compile pending items into a fresh draft.`,
        replyToMessageId: message.id,
        draftOrderId: activeDraft.id,
        eventType: 'draft.stale_prompt',
      });
      return;
    }

    try {
      const parsedItems = await this.intake.parseText(this.applyAliases(message.chatId, combinedTranscription));
      if (parsedItems.length === 0) {
        await this.sendBotMessage({
          chatId: message.chatId,
          senderId: message.senderId,
          text: `Compiled pending: "${combinedTranscription}". I could not turn that into a draft order. Reply \`cancel\` to clear, or send more items.`,
          replyToMessageId: message.id,
          eventType: 'draft.rejected.pending_unparsed',
        });
        return;
      }

      // Fresh active draft → merge new pending items in.
      if (activeDraft) {
        await this.mergeNewItemsIntoDraft(message, activeDraft, combinedTranscription, parsedItems);
        // Clear pending after successful merge so next `order` doesn't double-add.
        this.store.clearPendingItems(message.chatId);
        return;
      }

      const draft = this.store.createDraft({
        chatId: message.chatId,
        senderId: message.senderId,
        sourceType: pendingSourceType,
        rawInput: combinedTranscription,
        transcription: hasVoiceTranscription ? combinedTranscription : undefined,
        parsedItems,
        sourceMessageId: message.id,
      });

      this.store.recordEvent({
        chatId: draft.chatId,
        senderId: draft.senderId,
        draftOrderId: draft.id,
        direction: 'system',
        eventType: 'draft.created_from_pending',
        text: combinedTranscription,
      });

      this.metrics.draftsCreated += 1;
      await this.resolveAndShowDraft(draft, message);
    } catch (error) {
      await this.handleParseFailure(message, error, 'voice');
    }
  }

  private combineTranscriptions(pending: PendingItem[]): string {
    return pending
      .map((item) => item.transcription || item.rawInput)
      .filter((text) => Boolean(text && text.trim()))
      .join('\n');
  }

  private async handleTextOrder(message: TransportMessage, rawOrderText: string, mode: 'order' | 'add' = 'order') {
    if (!rawOrderText) {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: mode === 'add'
          ? 'Use `add: <items>` to append items to your draft.'
          : 'Use `order: <items>` so I can create a draft.',
        replyToMessageId: message.id,
        eventType: 'draft.rejected.empty_order',
      });
      return;
    }

    const activeDraft = this.store.getActiveDraft(message.chatId, message.senderId);
    if (activeDraft && activeDraft.status !== 'pending_confirmation') {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: this.buildActiveJobBlocker(activeDraft),
        replyToMessageId: message.id,
        draftOrderId: activeDraft.id,
        eventType: 'draft.rejected.active_job',
      });
      return;
    }

    // Stale-draft prompt — only triggers for `order:`. `add:` always appends.
    if (mode === 'order' && activeDraft && Date.now() - activeDraft.updatedAt >= STALE_DRAFT_THRESHOLD_MS) {
      const minsAgo = Math.round((Date.now() - activeDraft.updatedAt) / 60000);
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: `You have a draft from ~${minsAgo} min ago (${activeDraft.parsedItems.length} item${activeDraft.parsedItems.length === 1 ? '' : 's'}). Send \`add: ${rawOrderText}\` to append, or \`cancel\` first to start fresh.`,
        replyToMessageId: message.id,
        draftOrderId: activeDraft.id,
        eventType: 'draft.stale_prompt',
      });
      return;
    }

    try {
      const parsedItems = await this.intake.parseText(this.applyAliases(message.chatId, rawOrderText));
      if (parsedItems.length === 0) {
        await this.sendBotMessage({
          chatId: message.chatId,
          senderId: message.senderId,
          text: mode === 'add'
            ? 'I could not parse any items from that. Try `add: 2 milk, bread`.'
            : 'I could not parse any items from that order. Try `order: 2 milk, bread`.',
          replyToMessageId: message.id,
          eventType: 'draft.rejected.unparsed',
        });
        return;
      }

      // Active fresh draft (or any draft when mode='add'): merge new items.
      if (activeDraft) {
        await this.mergeNewItemsIntoDraft(message, activeDraft, rawOrderText, parsedItems);
        return;
      }

      const draft = this.store.createDraft({
        chatId: message.chatId,
        senderId: message.senderId,
        sourceType: 'text',
        rawInput: rawOrderText,
        parsedItems,
        sourceMessageId: message.id,
      });

      this.store.recordEvent({
        chatId: draft.chatId,
        senderId: draft.senderId,
        draftOrderId: draft.id,
        direction: 'system',
        eventType: 'draft.created',
        text: rawOrderText,
      });

      this.metrics.draftsCreated += 1;
      await this.resolveAndShowDraft(draft, message);
    } catch (error) {
      await this.handleParseFailure(message, error, 'text');
    }
  }

  private async handleControlReply(message: TransportMessage, originalBody: string): Promise<boolean> {
    const activeDraft = this.store.getActiveDraft(message.chatId, message.senderId);
    if (!activeDraft) {
      return false;
    }

    const relatedJob = this.store.getJobByDraftId(activeDraft.id);
    if (!this.replyTargetsMatch(message, activeDraft, relatedJob)) {
      return false;
    }

    const normalizedBody = originalBody.trim().toLowerCase();

    if (CONFIRM_WORDS.has(normalizedBody)) {
      await this.confirmDraft(activeDraft, message);
      return true;
    }

    if (CANCEL_WORDS.has(normalizedBody)) {
      await this.cancelDraft(activeDraft, relatedJob, message);
      return true;
    }

    if (normalizedBody.startsWith('edit:')) {
      const replacementText = originalBody.slice(originalBody.toLowerCase().indexOf('edit:') + 'edit:'.length).trim();
      await this.editDraft(activeDraft, replacementText, message);
      return true;
    }

    return false;
  }

  private async confirmDraft(draft: DraftOrder, message: TransportMessage) {
    if (draft.status === 'queued') {
      await this.sendBotMessage({
        chatId: draft.chatId,
        senderId: draft.senderId,
        text: 'This draft is already queued.',
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        eventType: 'job.already_queued',
      });
      return;
    }

    if (draft.status === 'processing') {
      await this.sendBotMessage({
        chatId: draft.chatId,
        senderId: draft.senderId,
        text: 'This order is already being processed.',
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        eventType: 'job.already_processing',
      });
      return;
    }

    if (!draft.resolvedItems || !draft.deliveryAddressId) {
      await this.sendBotMessage({
        chatId: draft.chatId,
        senderId: draft.senderId,
        text: 'This draft is not fully resolved yet. Reply `edit: <items>` to re-parse, or `cancel` to clear.',
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        eventType: 'draft.confirm_rejected.unresolved',
      });
      return;
    }

    const placeable = draft.resolvedItems.some(
      (item) => item.selectedIndex >= 0 && item.options[item.selectedIndex],
    );
    if (!placeable) {
      await this.sendBotMessage({
        chatId: draft.chatId,
        senderId: draft.senderId,
        text: 'None of these items matched on Swiggy. Reply `edit: <items>` to retry or `cancel` to clear.',
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        eventType: 'draft.confirm_rejected.no_matches',
      });
      return;
    }

    const queuedNotice = await this.sendBotMessage({
      chatId: draft.chatId,
      senderId: draft.senderId,
      text: 'Draft confirmed. I am queueing this order now.',
      replyToMessageId: message.id,
      draftOrderId: draft.id,
      eventType: 'job.queueing',
    });

    this.store.setDraftStatus(draft.id, 'queued');
    const job = this.store.createJobForDraft(draft, queuedNotice.id);
    const queueAhead = this.store.getQueuedJobCountAhead(job.id);

    this.store.clearPendingItems(draft.chatId);

    this.store.recordEvent({
      chatId: draft.chatId,
      senderId: draft.senderId,
      draftOrderId: draft.id,
      jobId: job.id,
      direction: 'system',
      eventType: 'job.queued',
      text: `Queued with ${queueAhead} job(s) ahead.`,
    });

    this.metrics.jobsQueued += 1;

    await this.sendBotMessage({
      chatId: draft.chatId,
      senderId: draft.senderId,
      text: `Order queued. Queue position: ${queueAhead + 1}. Reply \`cancel\` before it starts if you need to stop it.`,
      draftOrderId: draft.id,
      jobId: job.id,
      eventType: 'job.queued.confirmation',
    });

    void this.drainQueue();
  }

  private async cancelDraft(draft: DraftOrder, job: OrderJob | undefined, message: TransportMessage) {
    if (draft.status === 'processing' || job?.status === 'processing') {
      await this.sendBotMessage({
        chatId: draft.chatId,
        senderId: draft.senderId,
        text: 'This order is already running and can no longer be cancelled here.',
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        jobId: job?.id,
        eventType: 'job.cancel_rejected.processing',
      });
      return;
    }

    if (job?.status === 'queued') {
      const cancelled = this.store.cancelQueuedJob(job.id);
      if (!cancelled) {
        const latestJob = this.store.getJobById(job.id);
        if (latestJob?.status === 'processing') {
          await this.sendBotMessage({
            chatId: draft.chatId,
            senderId: draft.senderId,
            text: 'This order started processing before the cancellation landed, so it can no longer be cancelled here.',
            replyToMessageId: message.id,
            draftOrderId: draft.id,
            jobId: latestJob.id,
            eventType: 'job.cancel_rejected.raced',
          });
          return;
        }
      }

      this.store.recordEvent({
        chatId: draft.chatId,
        senderId: draft.senderId,
        draftOrderId: draft.id,
        jobId: job.id,
        direction: 'system',
        eventType: 'job.cancelled',
        text: 'Cancelled before execution.',
      });
    }

    this.store.cancelDraft(draft.id);
    const clearedPending = this.store.clearPendingItems(draft.chatId);

    this.store.recordEvent({
      chatId: draft.chatId,
      senderId: draft.senderId,
      draftOrderId: draft.id,
      jobId: job?.id,
      direction: 'system',
      eventType: 'draft.cancelled',
      text: `Cancelled by sender. Cleared ${clearedPending} pending item(s).`,
    });

    await this.sendBotMessage({
      chatId: draft.chatId,
      senderId: draft.senderId,
      text: 'Draft cleared. Nothing else will be queued from it.',
      replyToMessageId: message.id,
      draftOrderId: draft.id,
      jobId: job?.id,
      eventType: 'draft.cancelled.confirmation',
    });
  }

  private async editDraft(draft: DraftOrder, replacementText: string, message: TransportMessage) {
    if (draft.status !== 'pending_confirmation') {
      await this.sendBotMessage({
        chatId: draft.chatId,
        senderId: draft.senderId,
        text: 'You can only edit a draft before it is confirmed. Use `cancel` if the queued job has not started yet.',
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        eventType: 'draft.edit_rejected.status',
      });
      return;
    }

    if (!replacementText) {
      await this.sendBotMessage({
        chatId: draft.chatId,
        senderId: draft.senderId,
        text: 'Use `edit: <replacement order text>` to replace the draft.',
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        eventType: 'draft.edit_rejected.empty',
      });
      return;
    }

    try {
      const parsedItems = await this.intake.parseText(this.applyAliases(draft.chatId, replacementText));
      if (parsedItems.length === 0) {
        await this.sendBotMessage({
          chatId: draft.chatId,
          senderId: draft.senderId,
          text: 'I could not parse that edit, so the existing draft is unchanged.',
          replyToMessageId: message.id,
          draftOrderId: draft.id,
          eventType: 'draft.edit_rejected.unparsed',
        });
        return;
      }

      const updatedDraft = this.store.updateDraft({
        draftId: draft.id,
        chatId: draft.chatId,
        senderId: draft.senderId,
        sourceType: 'text',
        rawInput: replacementText,
        parsedItems,
        sourceMessageId: message.id,
      });

      this.store.recordEvent({
        chatId: updatedDraft.chatId,
        senderId: updatedDraft.senderId,
        draftOrderId: updatedDraft.id,
        direction: 'system',
        eventType: 'draft.edited',
        text: replacementText,
      });

      await this.resolveAndShowDraft(updatedDraft, message);
    } catch (error) {
      await this.handleParseFailure(message, error, 'text');
    }
  }

  private async handleLogin(message: TransportMessage) {
    try {
      const { authUrl, redirectUri } = await this.oauth.beginAuth();
      const text = [
        'Swiggy MCP login — open this URL on your phone or laptop:',
        '',
        authUrl,
        '',
        `After sign-in the browser will try to load ${redirectUri}?code=... and fail ("site can't be reached"). That is expected.`,
        'Copy the full URL from the address bar and reply:',
        '`!paste: <paste-full-url-here>`',
      ].join('\n');
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text,
        replyToMessageId: message.id,
        eventType: 'mcp.login.started',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.metrics.errors += 1;
      this.log(`MCP login init failed: ${errorMessage}`);
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: `Could not start Swiggy MCP login: ${errorMessage}`,
        replyToMessageId: message.id,
        eventType: 'mcp.login.failed',
      });
    }
  }

  private async handlePasteCallback(message: TransportMessage, pasted: string) {
    if (!pasted) {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: 'Use `!paste: <full callback URL>` including `?code=...&state=...`.',
        replyToMessageId: message.id,
        eventType: 'mcp.paste.empty',
      });
      return;
    }

    try {
      const { expiresAt } = await this.oauth.completeAuth(pasted);
      const daysLeft = Math.max(1, Math.round((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: `Swiggy MCP authenticated. Token valid for ~${daysLeft} day(s). Re-run \`!login\` when it expires.`,
        replyToMessageId: message.id,
        eventType: 'mcp.login.success',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.metrics.errors += 1;
      this.log(`MCP paste callback failed: ${errorMessage}`);
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: `Auth failed: ${errorMessage}`,
        replyToMessageId: message.id,
        eventType: 'mcp.login.paste_failed',
      });
    }
  }

  private async handleLogout(message: TransportMessage) {
    this.oauth.disconnect();
    await this.sendBotMessage({
      chatId: message.chatId,
      senderId: message.senderId,
      text: 'Swiggy MCP disconnected. Run `!login` to reconnect.',
      replyToMessageId: message.id,
      eventType: 'mcp.logout',
    });
  }

  private async handleHelp(message: TransportMessage) {
    const helpText = [
      'Commands:',
      '',
      'ESSENTIALS',
      '• voice note / text  → added to your list (24h)',
      '• order              → confirm your list as a draft',
      '• yes                → place it',
      '• no                 → cancel it',
      '• !address           → set delivery address (one-time)',
      '• !login             → connect Swiggy (re-run every ~5 days)',
      '',
      'MORE',
      '• order: <items>     → draft straight from text (skips the list)',
      '• add: <items>       → append items to your current draft',
      '• edit: <text>       → redo the whole draft',
      '• !pick <n> [m]      → swap item n\'s SKU (omit m to see options)',
      '• !qty <n> <q>       → set item n\'s quantity to q (e.g. !qty 2 3)',
      '• !address <n> | <fuzzy text> | clear',
      '• !alias <term> -> <canonical>   → teach me a new word (e.g. tamatar -> tomato)',
      '• !status            → queue / pending / auth / address / favorites',
      '• !logout            → disconnect Swiggy',
      '• !help              → this message',
      '',
      'Tip: Swiggy logins expire every 5 days. If orders fail with auth errors, run !login.',
    ].join('\n');

    await this.sendBotMessage({
      chatId: message.chatId,
      senderId: message.senderId,
      text: helpText,
      replyToMessageId: message.id,
      eventType: 'help.shown',
    });
  }

  private async handleStatus(message: TransportMessage) {
    const queueDepth = this.store.listQueuedJobs().length;
    const pendingCount = this.store.countPendingItems(message.chatId);
    const authState = this.store.getMcpAuth()?.state ?? 'disconnected';
    const lastCompleted = this.store.getLastCompletedJobAt(message.chatId);
    const favoritesCount = this.store.countFavorites(message.chatId);
    const home = this.store.getHomeAddress();

    const lastCompletedText = lastCompleted
      ? new Date(lastCompleted).toISOString()
      : 'never';

    const statusText = [
      'Status:',
      `• Queue depth: ${queueDepth}`,
      `• Pending items (this chat): ${pendingCount}`,
      `• Swiggy MCP auth: ${authState}`,
      `• Delivery address: ${home ? formatAddressLabel(home) : 'not set — run `!address`'}`,
      `• Last completed order: ${lastCompletedText}`,
      `• Favorites saved (this chat): ${favoritesCount}`,
    ].join('\n');

    await this.sendBotMessage({
      chatId: message.chatId,
      senderId: message.senderId,
      text: statusText,
      replyToMessageId: message.id,
      eventType: 'status.reported',
    });
  }

  private async drainQueue() {
    if (this.drainingQueue) {
      return;
    }

    this.drainingQueue = true;

    try {
      while (true) {
        const nextJob = this.store.getNextQueuedJob();
        if (!nextJob) {
          break;
        }

        const claimedJob = this.store.claimQueuedJob(nextJob.id);
        if (!claimedJob) {
          continue;
        }

        const draft = this.store.getDraftById(claimedJob.draftOrderId);
        if (!draft) {
          this.store.failJob(claimedJob.id, 'Draft missing for queued job.');
          this.metrics.jobsFailed += 1;
          continue;
        }

        this.store.setDraftStatus(draft.id, 'processing');
        this.store.recordEvent({
          chatId: draft.chatId,
          senderId: draft.senderId,
          draftOrderId: draft.id,
          jobId: claimedJob.id,
          direction: 'system',
          eventType: 'job.started',
          text: 'Worker started processing the order.',
        });

        await this.sendBotMessage({
          chatId: draft.chatId,
          senderId: draft.senderId,
          text: 'Starting your queued order now.',
          draftOrderId: draft.id,
          jobId: claimedJob.id,
          eventType: 'job.started.notice',
        });

        try {
          if (!claimedJob.resolvedItems || !claimedJob.deliveryAddressId) {
            const reason = 'Job is missing resolved items or delivery address. Re-create the draft.';
            this.store.failJob(claimedJob.id, reason);
            this.store.recordEvent({
              chatId: draft.chatId,
              senderId: draft.senderId,
              draftOrderId: draft.id,
              jobId: claimedJob.id,
              direction: 'system',
              eventType: 'job.failed',
              text: reason,
            });
            this.metrics.jobsFailed += 1;

            await this.sendBotMessage({
              chatId: draft.chatId,
              senderId: draft.senderId,
              text: `Order failed: ${reason}`,
              draftOrderId: draft.id,
              jobId: claimedJob.id,
              eventType: 'job.failed.notice',
            });
            continue;
          }

          const workerResult = await this.worker.placeResolvedOrder(
            claimedJob.chatId,
            claimedJob.deliveryAddressId,
            claimedJob.resolvedItems,
          );
          this.metrics.searchesPerformed += workerResult.searchCount;
          this.metrics.productsAdded += workerResult.addedItems.length;

          // Distinguish three outcomes:
          //   (1) fatal — nothing reached Swiggy (cart/checkout failed) → "Order failed"
          //   (2) partial — some items placed, some skipped → "Order placed partially"
          //   (3) clean — all items placed → existing success path
          const fatalReason = workerResult.fatalError
            || (workerResult.addedItems.length === 0 ? 'No items could be placed.' : null);

          if (fatalReason) {
            this.store.failJob(claimedJob.id, fatalReason, workerResult);
            this.store.recordEvent({
              chatId: draft.chatId,
              senderId: draft.senderId,
              draftOrderId: draft.id,
              jobId: claimedJob.id,
              direction: 'system',
              eventType: 'job.failed',
              text: fatalReason,
            });
            this.metrics.jobsFailed += 1;

            const failureLines = [`Order failed: ${fatalReason}`];
            if (workerResult.failedItems.length > 0) {
              failureLines.push('', 'Failed items:');
              workerResult.failedItems.forEach((f, i) => {
                failureLines.push(`  ${i + 1}. ${f.query} — ${f.reason}`);
              });
            }
            await this.sendBotMessage({
              chatId: draft.chatId,
              senderId: draft.senderId,
              text: failureLines.join('\n'),
              draftOrderId: draft.id,
              jobId: claimedJob.id,
              eventType: 'job.failed.notice',
            });

            continue;
          }

          if (!workerResult.success && workerResult.addedItems.length > 0) {
            // Partial success — some items placed, others skipped.
            this.store.completeJob(claimedJob.id, workerResult);
            this.store.recordEvent({
              chatId: draft.chatId,
              senderId: draft.senderId,
              draftOrderId: draft.id,
              jobId: claimedJob.id,
              direction: 'system',
              eventType: 'job.completed.partial',
              text: `Placed ${workerResult.addedItems.length} of ${workerResult.addedItems.length + workerResult.failedItems.length} items.`,
            });
            this.metrics.jobsProcessed += 1;

            const lines = [
              `⚠️ Order placed partially. ${workerResult.addedItems.length} item${workerResult.addedItems.length === 1 ? '' : 's'} ordered, ${workerResult.failedItems.length} skipped.`,
              '',
              'Placed at Swiggy:',
              ...workerResult.addedItems.map((a, i) => `  ${i + 1}. ${a.productName} x${a.quantity}`),
              '',
              'Skipped:',
              ...workerResult.failedItems.map((f, i) => `  ${i + 1}. ${f.query} — ${f.reason}`),
              '',
              'Re-order skipped items separately if you want them. Don\'t re-send the full list — Diet Coke etc. are already in your Swiggy order.',
            ];
            await this.sendBotMessage({
              chatId: draft.chatId,
              senderId: draft.senderId,
              text: lines.join('\n'),
              draftOrderId: draft.id,
              jobId: claimedJob.id,
              eventType: 'job.completed.partial.notice',
            });

            continue;
          }

          this.store.completeJob(claimedJob.id, workerResult);
          this.store.recordEvent({
            chatId: draft.chatId,
            senderId: draft.senderId,
            draftOrderId: draft.id,
            jobId: claimedJob.id,
            direction: 'system',
            eventType: 'job.completed',
            text: 'Worker finished processing the order.',
          });
          this.metrics.jobsProcessed += 1;

          await this.sendBotMessage({
            chatId: draft.chatId,
            senderId: draft.senderId,
            text: this.buildJobSummary(workerResult),
            draftOrderId: draft.id,
            jobId: claimedJob.id,
            eventType: 'job.completed.notice',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.store.failJob(claimedJob.id, message);
          this.store.recordEvent({
            chatId: draft.chatId,
            senderId: draft.senderId,
            draftOrderId: draft.id,
            jobId: claimedJob.id,
            direction: 'system',
            eventType: 'job.failed',
            text: message,
          });
          this.metrics.jobsFailed += 1;

          await this.sendBotMessage({
            chatId: draft.chatId,
            senderId: draft.senderId,
            text: `Order failed: ${message}`,
            draftOrderId: draft.id,
            jobId: claimedJob.id,
            eventType: 'job.failed.notice',
          });
        }
      }
    } finally {
      this.drainingQueue = false;
    }
  }

  // Append-and-resolve path — used when a fresh draft already exists and the
  // user sends more `order:` / `add:` items. Resolves only the new subset so
  // prior `!pick` / `!qty` choices on existing items are preserved.
  private async mergeNewItemsIntoDraft(
    message: TransportMessage,
    draft: DraftOrder,
    newRawText: string,
    newParsedItems: ShoppingItem[],
  ) {
    const home = this.store.getHomeAddress();

    if (!home) {
      const merged = this.store.appendDraftItems({
        draftId: draft.id,
        appendedParsedItems: newParsedItems,
        appendedResolvedItems: [],
        sourceMessageId: message.id,
        rawInputAddendum: newRawText,
      });
      this.store.recordEvent({
        chatId: merged.chatId,
        senderId: merged.senderId,
        draftOrderId: merged.id,
        direction: 'system',
        eventType: 'draft.merged.unresolved',
        text: newRawText,
      });
      await this.sendUnresolvedDraft(merged, message.id);
      return;
    }

    let newResolved: ResolvedDraftItem[];
    try {
      newResolved = await this.worker.resolveItems(
        draft.chatId,
        newParsedItems,
        home.id,
        (q, p) => this.intake.verifySku(q, p),
      );
    } catch (error) {
      await this.handleMcpError(message, draft, error, 'Could not resolve items on Swiggy');
      return;
    }

    const mergedResolvedSnapshot = [...(draft.resolvedItems ?? []), ...newResolved];
    const subtotalPaise = calcSubtotalPaise(mergedResolvedSnapshot);

    const merged = this.store.appendDraftItems({
      draftId: draft.id,
      appendedParsedItems: newParsedItems,
      appendedResolvedItems: newResolved,
      addressId: home.id,
      addressLabel: formatAddressLabel(home),
      subtotalPaise,
      sourceMessageId: message.id,
      rawInputAddendum: newRawText,
    });

    this.store.recordEvent({
      chatId: merged.chatId,
      senderId: merged.senderId,
      draftOrderId: merged.id,
      direction: 'system',
      eventType: 'draft.merged',
      text: newRawText,
    });

    await this.sendBotMessage({
      chatId: merged.chatId,
      senderId: merged.senderId,
      text: `Added ${newParsedItems.length} item${newParsedItems.length === 1 ? '' : 's'}.\n\n${this.buildDraftSummary(merged, home)}`,
      replyToMessageId: message.id,
      draftOrderId: merged.id,
      eventType: 'draft.merged.summary',
    }).then((sent) => {
      this.store.setDraftConfirmationMessage(merged.id, sent.id);
    });
  }

  private async resolveAndShowDraft(draft: DraftOrder, message: TransportMessage) {
    const home = this.store.getHomeAddress();
    if (!home) {
      await this.sendUnresolvedDraft(draft, message.id);
      return;
    }

    let resolvedItems: ResolvedDraftItem[];
    try {
      resolvedItems = await this.worker.resolveItems(
        draft.chatId,
        draft.parsedItems,
        home.id,
        (query, productName) => this.intake.verifySku(query, productName),
      );
    } catch (error) {
      await this.handleMcpError(message, draft, error, 'Could not resolve items on Swiggy');
      return;
    }

    const subtotalPaise = calcSubtotalPaise(resolvedItems);
    const label = formatAddressLabel(home);
    this.store.saveDraftResolution({
      draftId: draft.id,
      resolvedItems,
      addressId: home.id,
      addressLabel: label,
      subtotalPaise,
    });

    const refreshed = this.store.getDraftById(draft.id) ?? draft;
    await this.sendDraftSummary(refreshed, message.id, home);
  }

  private async sendDraftSummary(draft: DraftOrder, replyToMessageId: string, address?: DeliveryAddress) {
    const summaryMessage = await this.sendBotMessage({
      chatId: draft.chatId,
      senderId: draft.senderId,
      text: this.buildDraftSummary(draft, address),
      replyToMessageId,
      draftOrderId: draft.id,
      eventType: 'draft.summary',
    });

    this.store.setDraftConfirmationMessage(draft.id, summaryMessage.id);
  }

  private async sendUnresolvedDraft(draft: DraftOrder, replyToMessageId: string) {
    const summaryMessage = await this.sendBotMessage({
      chatId: draft.chatId,
      senderId: draft.senderId,
      text: this.buildUnresolvedDraftSummary(draft),
      replyToMessageId,
      draftOrderId: draft.id,
      eventType: 'draft.summary.unresolved',
    });

    this.store.setDraftConfirmationMessage(draft.id, summaryMessage.id);
  }

  private async handleMcpError(
    message: TransportMessage,
    draft: DraftOrder,
    error: unknown,
    prefix: string,
  ) {
    const reason = error instanceof Error ? error.message : String(error);
    this.metrics.errors += 1;
    this.log(`${prefix}: ${reason}`);

    const hint = error instanceof McpAuthError ? ' Run `!login` to reconnect.' : '';
    await this.sendBotMessage({
      chatId: draft.chatId,
      senderId: draft.senderId,
      text: `${prefix}: ${reason}.${hint}`,
      replyToMessageId: message.id,
      draftOrderId: draft.id,
      eventType: 'draft.resolve_failed',
    });
  }

  private async handleAddressCommand(message: TransportMessage, body: string) {
    const rest = body.replace(/^!address[:\s]*/i, '').trim();

    if (rest.toLowerCase() === 'clear') {
      this.store.clearHomeAddress();
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: 'Delivery address cleared. Reply `!address` to pick a new one.',
        replyToMessageId: message.id,
        eventType: 'address.cleared',
      });
      return;
    }

    let addresses: DeliveryAddress[];
    try {
      addresses = await this.worker.listAddresses();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const hint = error instanceof McpAuthError ? ' Run `!login`.' : '';
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: `Could not fetch Swiggy addresses: ${reason}.${hint}`,
        replyToMessageId: message.id,
        eventType: 'address.fetch_failed',
      });
      return;
    }

    if (addresses.length === 0) {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: 'No saved Swiggy addresses. Add one in the Swiggy app, then try `!address` again.',
        replyToMessageId: message.id,
        eventType: 'address.none_saved',
      });
      return;
    }

    if (rest) {
      const n = Number.parseInt(rest, 10);
      if (Number.isFinite(n) && n >= 1 && n <= addresses.length && /^\d+$/.test(rest)) {
        const chosen = addresses[n - 1]!;
        this.store.setHomeAddress(chosen);
        await this.sendBotMessage({
          chatId: message.chatId,
          senderId: message.senderId,
          text: `Delivery address pinned: ${formatAddressLabel(chosen)}.\n${formatAddressBody(chosen)}\n\nNow reply \`order\` to place one.`,
          replyToMessageId: message.id,
          eventType: 'address.pinned',
        });
        return;
      }

      // For short lists, just tell the user to pick a number — no need for LLM fuzzy match.
      if (addresses.length < 10) {
        await this.sendBotMessage({
          chatId: message.chatId,
          senderId: message.senderId,
          text: `Reply \`!address <n>\` where <n> is 1–${addresses.length}, or \`!address\` to see the list.`,
          replyToMessageId: message.id,
          eventType: 'address.invalid_index',
        });
        return;
      }

      // 10+ addresses → non-numeric input triggers Gemini fuzzy match.
      const descriptions = addresses.map((addr) => {
        const label = formatAddressLabel(addr);
        const bodyText = formatAddressBody(addr);
        return bodyText ? `${label} — ${bodyText}` : label;
      });
      let matchedIdx: number | null = null;
      try {
        matchedIdx = await this.intake.matchAddress(rest, descriptions);
      } catch (error) {
        this.log(`address match failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (matchedIdx !== null) {
        const chosen = addresses[matchedIdx - 1]!;
        this.store.setHomeAddress(chosen);
        await this.sendBotMessage({
          chatId: message.chatId,
          senderId: message.senderId,
          text: `Matched "${rest}" → ${formatAddressLabel(chosen)}.\n${formatAddressBody(chosen)}\n\nNow reply \`order\` to place one. \`!address\` to change.`,
          replyToMessageId: message.id,
          eventType: 'address.pinned',
        });
        return;
      }

      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: `No address clearly matches "${rest}". Reply \`!address\` to see the list, then \`!address <n>\` to pin by number, or refine your description.`,
        replyToMessageId: message.id,
        eventType: 'address.no_match',
      });
      return;
    }

    const home = this.store.getHomeAddress();
    const pinnedIdx = home ? addresses.findIndex((a) => a.id === home.id) : -1;
    const lines: string[] = [];
    lines.push(`Reply \`!address <n>\` (e.g. \`!address 1\`) to pin a delivery address.`);
    lines.push('');
    if (home) {
      lines.push(`Currently pinned: ${formatAddressLabel(home)}`);
      lines.push('');
    }
    lines.push(`Swiggy addresses (${addresses.length}):`);
    addresses.forEach((addr, idx) => {
      const marker = idx === pinnedIdx ? ' (pinned)' : '';
      const label = formatAddressLabel(addr);
      const bodyText = formatAddressBody(addr);
      const suffix = bodyText ? ` — ${bodyText}` : '';
      lines.push(`${idx + 1}. ${label}${marker}${suffix}`);
    });
    lines.push('');
    if (addresses.length >= 10) {
      lines.push('Or `!address <text>` to match by description (e.g. `!address home`). `!address clear` to unset.');
    } else {
      lines.push('`!address clear` to unset.');
    }

    await this.sendBotMessage({
      chatId: message.chatId,
      senderId: message.senderId,
      text: lines.join('\n'),
      replyToMessageId: message.id,
      eventType: 'address.list',
    });
  }

  private async handlePickCommand(message: TransportMessage, body: string) {
    const rest = body.replace(/^!pick[:\s]+/i, '').trim();
    const draft = this.store.getActiveDraft(message.chatId, message.senderId);

    if (!draft || draft.status !== 'pending_confirmation') {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: 'No draft waiting for confirmation. Send `order: <items>` or reply `order` after voice notes.',
        replyToMessageId: message.id,
        eventType: 'pick.no_draft',
      });
      return;
    }

    if (!draft.resolvedItems || draft.resolvedItems.length === 0) {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: 'This draft has no resolved items yet. Reply `edit: <items>` or `cancel`.',
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        eventType: 'pick.not_resolved',
      });
      return;
    }

    const tokens = rest.split(/\s+/).filter(Boolean);
    const itemIdx = tokens[0] ? Number.parseInt(tokens[0], 10) : NaN;

    if (!Number.isFinite(itemIdx) || itemIdx < 1 || itemIdx > draft.resolvedItems.length) {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: `Use \`!pick <n>\` where n is 1–${draft.resolvedItems.length} from the draft, then \`!pick <n> <m>\` to swap.`,
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        eventType: 'pick.invalid_item',
      });
      return;
    }

    const resolvedItem = draft.resolvedItems[itemIdx - 1]!;

    if (resolvedItem.options.length === 0) {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: `Item ${itemIdx} (${resolvedItem.query}) has no Swiggy matches. Reply \`edit: <items>\` to retry.`,
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        eventType: 'pick.no_options',
      });
      return;
    }

    if (tokens.length === 1) {
      const lines = [`Options for ${itemIdx}. ${resolvedItem.query}:`];
      resolvedItem.options.forEach((opt, idx) => {
        const marker = idx === resolvedItem.selectedIndex ? ' (selected)' : '';
        lines.push(`  ${idx + 1}. ${formatOptionWithPrice(opt)}${marker}`);
      });
      lines.push('');
      lines.push(`Reply \`!pick ${itemIdx} <m>\` to swap.`);
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: lines.join('\n'),
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        eventType: 'pick.options',
      });
      return;
    }

    const optionIdx = Number.parseInt(tokens[1]!, 10);
    if (!Number.isFinite(optionIdx) || optionIdx < 1 || optionIdx > resolvedItem.options.length) {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: `Pick between 1 and ${resolvedItem.options.length} for item ${itemIdx}.`,
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        eventType: 'pick.invalid_option',
      });
      return;
    }

    const updated = [...draft.resolvedItems];
    updated[itemIdx - 1] = { ...resolvedItem, selectedIndex: optionIdx - 1 };
    const subtotalPaise = calcSubtotalPaise(updated);
    this.store.saveDraftResolution({
      draftId: draft.id,
      resolvedItems: updated,
      addressId: draft.deliveryAddressId ?? '',
      addressLabel: draft.deliveryAddressLabel,
      subtotalPaise,
    });

    // Manual !pick is a strong preference signal — promote the swap to a
    // favorite immediately so next order auto-selects it without re-asking.
    const pickedOption = resolvedItem.options[optionIdx - 1]!;
    this.store.upsertFavorite({
      chatId: draft.chatId,
      normalizedQuery: resolvedItem.normalizedQuery,
      productId: pickedOption.spinId,
      productName: pickedOption.productName,
    });

    const refreshed = this.store.getDraftById(draft.id) ?? draft;
    const home = this.store.getHomeAddress();
    await this.sendBotMessage({
      chatId: message.chatId,
      senderId: message.senderId,
      text: this.buildDraftSummary(refreshed, home),
      replyToMessageId: message.id,
      draftOrderId: draft.id,
      eventType: 'pick.applied',
    });
  }

  private async handleQtyCommand(message: TransportMessage, body: string) {
    const rest = body.replace(/^!qty[:\s]+/i, '').trim();
    const draft = this.store.getActiveDraft(message.chatId, message.senderId);

    if (!draft || draft.status !== 'pending_confirmation') {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: 'No draft waiting for confirmation. Send `order: <items>` or reply `order` after voice notes.',
        replyToMessageId: message.id,
        eventType: 'qty.no_draft',
      });
      return;
    }

    if (!draft.resolvedItems || draft.resolvedItems.length === 0) {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: 'This draft has no resolved items yet. Reply `edit: <items>` or `cancel`.',
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        eventType: 'qty.not_resolved',
      });
      return;
    }

    const tokens = rest.split(/\s+/).filter(Boolean);
    const itemIdx = tokens[0] ? Number.parseInt(tokens[0], 10) : NaN;
    const newQty = tokens[1] ? Number.parseInt(tokens[1], 10) : NaN;

    if (
      !Number.isFinite(itemIdx) || itemIdx < 1 || itemIdx > draft.resolvedItems.length ||
      !Number.isFinite(newQty) || newQty < 1 || newQty > 99
    ) {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: `Use \`!qty <n> <quantity>\` where n is 1–${draft.resolvedItems.length} and quantity is 1–99 (e.g. \`!qty 2 3\`).`,
        replyToMessageId: message.id,
        draftOrderId: draft.id,
        eventType: 'qty.invalid',
      });
      return;
    }

    const resolvedItem = draft.resolvedItems[itemIdx - 1]!;
    const updated = [...draft.resolvedItems];
    updated[itemIdx - 1] = { ...resolvedItem, quantity: newQty };
    const subtotalPaise = calcSubtotalPaise(updated);
    this.store.saveDraftResolution({
      draftId: draft.id,
      resolvedItems: updated,
      addressId: draft.deliveryAddressId ?? '',
      addressLabel: draft.deliveryAddressLabel,
      subtotalPaise,
    });

    const refreshed = this.store.getDraftById(draft.id) ?? draft;
    const home = this.store.getHomeAddress();
    await this.sendBotMessage({
      chatId: message.chatId,
      senderId: message.senderId,
      text: this.buildDraftSummary(refreshed, home),
      replyToMessageId: message.id,
      draftOrderId: draft.id,
      eventType: 'qty.applied',
    });
  }

  private async handleAliasCommand(message: TransportMessage, body: string) {
    const rest = body.replace(/^!alias[:\s]*/i, '').trim();

    if (rest.length === 0) {
      const aliases = this.store.listAliases(message.chatId);
      const text = aliases.length === 0
        ? 'No aliases set for this chat. Add one with `!alias <term> -> <canonical>` (e.g. `!alias tamatar -> tomato`).'
        : ['Aliases for this chat:', ...aliases.map((a) => `• ${a.aliasTerm} → ${a.canonicalQuery}`), '', 'Add: `!alias <term> -> <canonical>`. Remove: `!alias <term> clear`.'].join('\n');
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text,
        replyToMessageId: message.id,
        eventType: 'alias.list',
      });
      return;
    }

    // Clear: "!alias <term> clear"
    const clearMatch = rest.match(/^(.+?)\s+clear$/i);
    if (clearMatch) {
      const term = clearMatch[1]!.trim();
      const removed = this.store.deleteAlias(message.chatId, term);
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: removed ? `Alias "${term}" removed.` : `No alias "${term}" to remove.`,
        replyToMessageId: message.id,
        eventType: removed ? 'alias.cleared' : 'alias.clear_missing',
      });
      return;
    }

    // Add/update: "!alias <term> -> <canonical>"
    const arrowMatch = rest.match(/^(.+?)\s*(?:->|=>)\s*(.+)$/);
    if (!arrowMatch) {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: 'Use `!alias <term> -> <canonical>` (e.g. `!alias tamatar -> tomato`), `!alias <term> clear`, or `!alias` to list.',
        replyToMessageId: message.id,
        eventType: 'alias.malformed',
      });
      return;
    }

    const term = arrowMatch[1]!.trim();
    const canonical = arrowMatch[2]!.trim();
    if (term.length === 0 || canonical.length === 0) {
      await this.sendBotMessage({
        chatId: message.chatId,
        senderId: message.senderId,
        text: 'Both term and canonical must be non-empty. e.g. `!alias tamatar -> tomato`.',
        replyToMessageId: message.id,
        eventType: 'alias.malformed',
      });
      return;
    }

    this.store.upsertAlias(message.chatId, term, canonical);
    await this.sendBotMessage({
      chatId: message.chatId,
      senderId: message.senderId,
      text: `Alias saved: "${term}" → "${canonical}". Future orders will substitute it before parsing.`,
      replyToMessageId: message.id,
      eventType: 'alias.saved',
    });
  }

  // Substitute saved alias terms in raw input before parsing. Word-boundary
  // case-insensitive so "tamatar" → "tomato" but "tamatari" stays untouched.
  private applyAliases(chatId: string, text: string): string {
    const aliases = this.store.listAliases(chatId);
    if (aliases.length === 0) return text;
    let result = text;
    for (const { aliasTerm, canonicalQuery } of aliases) {
      const escaped = aliasTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'gi');
      result = result.replace(re, canonicalQuery);
    }
    return result;
  }

  private async handleParseFailure(
    message: TransportMessage,
    error: unknown,
    source: 'text' | 'voice',
  ) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.metrics.errors += 1;
    this.log(`Order parse failure (${source}) for ${message.senderId}: ${errorMessage}`);

    const userText = /quota|rate|429/i.test(errorMessage)
      ? 'Hit Gemini rate limit. Wait a minute and try again.'
      : /api key|API_KEY/i.test(errorMessage)
      ? 'Gemini API key looks invalid. Open http://localhost:3000 → Setup to refresh it.'
      : "Couldn't reach the parser — try again in a sec.";

    await this.sendBotMessage({
      chatId: message.chatId,
      senderId: message.senderId,
      text: userText,
      replyToMessageId: message.id,
      eventType: 'draft.parse_failed',
    });
  }

  private replyTargetsMatch(message: TransportMessage, draft: DraftOrder, job: OrderJob | undefined): boolean {
    if (!message.replyToMessageId) {
      return true;
    }

    const validMessageIds = [
      draft.confirmationMessageId,
      draft.sourceMessageId,
      job?.queuedMessageId,
    ].filter((value): value is string => Boolean(value));

    return validMessageIds.includes(message.replyToMessageId);
  }

  private buildDraftSummary(draft: DraftOrder, address?: DeliveryAddress): string {
    const heardText = draft.transcription ? `I heard: "${draft.transcription}"\n\n` : '';
    const resolved = draft.resolvedItems;
    if (!resolved || resolved.length === 0) {
      return this.buildUnresolvedDraftSummary(draft);
    }

    const lines: string[] = [`${heardText}Draft order:`];
    resolved.forEach((item, idx) => {
      const opt = item.selectedIndex >= 0 ? item.options[item.selectedIndex] : undefined;
      const qty = item.quantity > 1 ? ` × ${item.quantity}` : '';
      if (!opt) {
        lines.push(`${idx + 1}. ${item.query}${qty} — ⚠ ${item.note ?? 'no match; will be skipped'}`);
        return;
      }
      const lineTotal =
        opt.priceOfferPaise !== undefined ? opt.priceOfferPaise * item.quantity : undefined;
      const priceText = lineTotal !== undefined ? ` — ${formatPaise(lineTotal)}` : '';
      const stockTag = opt.inStock ? '' : ' (out of stock)';
      const favTag = item.fromFavorite ? ' ⭐' : '';
      lines.push(`${idx + 1}. ${formatOption(opt)}${qty}${priceText}${stockTag}${favTag}`);
    });

    const subtotal = draft.subtotalPaise ?? calcSubtotalPaise(resolved);
    if (subtotal > 0) {
      lines.push('');
      lines.push(`Subtotal: ${formatPaise(subtotal)}`);
    }

    lines.push('');
    const addressText = address
      ? formatAddressLabel(address) + (formatAddressBody(address) ? ` — ${formatAddressBody(address)}` : '')
      : draft.deliveryAddressLabel ?? 'Unknown';
    lines.push(`Deliver to: ${addressText}`);

    lines.push('');
    lines.push('Reply `yes` to place, `!pick <n>` to swap an item, `edit: <items>` to redo, `cancel` to clear.');
    return lines.join('\n');
  }

  private buildUnresolvedDraftSummary(draft: DraftOrder): string {
    const lines = draft.parsedItems.map((item, index) => `${index + 1}. ${this.formatItem(item)}`);
    const heardText = draft.transcription ? `I heard: "${draft.transcription}"\n\n` : '';
    return `${heardText}Draft order (not yet resolved):\n${lines.join('\n')}\n\nSet \`!address\` first, then reply \`order\`.`;
  }

  private buildJobSummary(result: {
    addedItems: Array<{ query: string; quantity: number; productName: string }>;
    skippedItems: Array<{ query: string; quantity: number; reason: string }>;
    failedItems: Array<{ query: string; quantity: number; reason: string }>;
  }): string {
    const lines: string[] = ['Order finished.'];

    if (result.addedItems.length > 0) {
      lines.push('');
      lines.push('Added:');
      lines.push(
        ...result.addedItems.map(
          (item, index) =>
            `${index + 1}. ${item.productName} (for ${this.formatItem({ query: item.query, quantity: item.quantity })})`,
        ),
      );
    }

    if (result.skippedItems.length > 0) {
      lines.push('');
      lines.push('Skipped:');
      lines.push(
        ...result.skippedItems.map(
          (item, index) => `${index + 1}. ${this.formatItem(item)} - ${item.reason}`,
        ),
      );
    }

    if (result.failedItems.length > 0) {
      lines.push('');
      lines.push('Failed:');
      lines.push(
        ...result.failedItems.map(
          (item, index) => `${index + 1}. ${this.formatItem(item)} - ${item.reason}`,
        ),
      );
    }

    return lines.join('\n');
  }

  private buildActiveJobBlocker(draft: DraftOrder): string {
    if (draft.status === 'queued') {
      return 'You already have a queued order. Reply `cancel` before it starts, or wait for it to finish.';
    }

    return 'You already have an order in progress. Wait for it to finish before starting another.';
  }

  private formatItem(item: Pick<ShoppingItem, 'query' | 'quantity'>): string {
    return item.quantity > 1 ? `${item.query} x${item.quantity}` : item.query;
  }
}

function formatPaise(paise: number | undefined): string {
  if (paise === undefined || !Number.isFinite(paise)) return '';
  return `₹${(paise / 100).toFixed(2)}`;
}

function formatOption(opt: ResolvedSkuOption): string {
  const parts = [opt.productName];
  if (opt.packSize) parts.push(opt.packSize);
  return parts.filter(Boolean).join(' ');
}

function formatOptionWithPrice(opt: ResolvedSkuOption): string {
  const base = formatOption(opt);
  const price = opt.priceOfferPaise && opt.priceOfferPaise > 0
    ? formatPaise(opt.priceOfferPaise)
    : opt.priceMrpPaise && opt.priceMrpPaise > 0
    ? formatPaise(opt.priceMrpPaise)
    : null;
  const stockTag = opt.inStock === false ? ' (OOS)' : '';
  return price ? `${base} — ${price}${stockTag}` : `${base}${stockTag}`;
}

function formatAddressLabel(address: DeliveryAddress): string {
  return (
    address.label ||
    address.category ||
    address.addressLine ||
    address.locality ||
    address.id
  );
}

function formatAddressBody(address: DeliveryAddress): string {
  const parts = [
    address.addressLine,
    address.addressLine2,
    address.locality,
    address.city,
    address.postalCode,
  ].filter((v): v is string => Boolean(v && v.trim()));
  return parts.join(', ');
}

function calcSubtotalPaise(items: ResolvedDraftItem[]): number {
  let sum = 0;
  for (const item of items) {
    if (item.selectedIndex < 0) continue;
    const opt = item.options[item.selectedIndex];
    if (opt?.priceOfferPaise !== undefined) {
      sum += opt.priceOfferPaise * item.quantity;
    } else if (opt?.priceMrpPaise !== undefined) {
      sum += opt.priceMrpPaise * item.quantity;
    }
  }
  return sum;
}

export type { McpAuthState };

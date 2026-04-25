import { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import QRCode from 'qrcode';

// ---- Types mirrored from the old WAHAClient so downstream code stays put ----

export interface BaileysMessageMedia {
  url?: string;
  mimetype?: string;
  filename?: string;
}

export interface BaileysMessage {
  id: string;
  timestamp?: number;
  from?: string;
  to?: string;
  body?: string;
  fromMe?: boolean;
  hasMedia?: boolean;
  type?: 'chat' | 'image' | 'video' | 'audio' | 'ptt' | 'voice' | 'document' | 'sticker';
  participant?: string;
  mimetype?: string;
  mediaUrl?: string;
  media?: BaileysMessageMedia | null;
  replyTo?: string;
  quotedMessageId?: string;
}

export interface SessionStatus {
  name: string;
  status: 'STOPPED' | 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED';
  me?: {
    id: string;
    pushName?: string;
  };
}

export interface QRCodeResponse {
  value: string;
  mimetype?: string;
}

export interface SendMessageResponse {
  id?: string;
  timestamp?: number;
}

export interface BaileysGroupParticipant {
  id: string;
  phoneNumber: string;
  admin: string | null;
  displayName?: string;
}

export interface BaileysGroupSummary {
  id: string;
  subject: string;
  size: number;
  participants: BaileysGroupParticipant[];
}

type MessageHandler = (msg: BaileysMessage) => void | Promise<void>;
type StatusHandler = (status: SessionStatus) => void | Promise<void>;
type QrHandler = (dataUrl: string) => void | Promise<void>;

const MESSAGE_CACHE_CAP = 500;

export class BaileysClient {
  private readonly authDir: string;
  private readonly sessionName: string;
  private readonly logger: Logger;

  private sock: WASocket | null = null;
  private currentStatus: SessionStatus['status'] = 'STOPPED';
  private me: SessionStatus['me'];
  private currentQrDataUrl: string | null = null;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private groupCache: BaileysGroupSummary[] | null = null;

  // Cache inbound WAMessage keyed by message id so we can quote / mark-read / download media later.
  private readonly messageCache = new Map<string, WAMessage>();
  private readonly messageCacheOrder: string[] = [];

  // Sender ID → WhatsApp pushName, populated as we see messages. Lets the UI
  // show real names instead of cryptic @lid digits. Only senders who have
  // messaged the bot in this session are known; others stay anonymous.
  private readonly senderNames = new Map<string, string>();

  private readonly handlers = {
    message: [] as MessageHandler[],
    status: [] as StatusHandler[],
    qr: [] as QrHandler[],
  };

  constructor(opts: { authDir?: string; sessionName?: string } = {}) {
    this.authDir = path.resolve(opts.authDir || process.env.BAILEYS_AUTH_DIR || './data/baileys-auth');
    this.sessionName = opts.sessionName || 'default';
    this.logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' }) as unknown as Logger;
  }

  // ---- lifecycle ----

  async start(): Promise<SessionStatus> {
    // If a live socket already exists, we're either connecting or connected — don't stack a second one.
    if (this.sock) {
      return this.getSessionStatus();
    }

    this.stopping = false;
    this.setStatus('STARTING');

    await fs.mkdir(this.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as unknown as [number, number, number] }));

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger as unknown as Parameters<typeof makeCacheableSignalKeyStore>[1]),
      },
      logger: this.logger as unknown as Parameters<typeof makeWASocket>[0]['logger'],
      browser: Browsers.macOS('Ordering Bot'),
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      syncFullHistory: false,
      getMessage: async (key) => {
        if (key.id && this.messageCache.has(key.id)) {
          return this.messageCache.get(key.id)?.message ?? undefined;
        }
        return undefined;
      },
    });

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('connection.update', (update) => {
      void this.handleConnectionUpdate(update);
    });
    this.sock.ev.on('messages.upsert', ({ messages }) => {
      for (const raw of messages) {
        this.rememberMessage(raw);
        // Cache pushName by participant ID (for groups) or remoteJid (for DMs).
        const senderId = raw.key.participant || raw.key.remoteJid;
        const pushName = (raw.pushName || '').trim();
        if (senderId && pushName) {
          this.senderNames.set(senderId, pushName);
        }
        const normalized = this.normalizeIncoming(raw);
        if (!normalized) continue;
        for (const cb of this.handlers.message) {
          void cb(normalized);
        }
      }
    });

    return this.getSessionStatus();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.sock;
    this.sock = null;
    try {
      sock?.end(undefined);
    } catch {
      // best-effort
    }
    this.setStatus('STOPPED');
  }

  async logout(): Promise<void> {
    this.stopping = true;
    try {
      await this.sock?.logout();
    } catch {
      // ignore; we're wiping creds anyway
    }
    this.sock = null;
    try {
      await fs.rm(this.authDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    this.setStatus('STOPPED');
  }

  getSessionStatus(): SessionStatus {
    return {
      name: this.sessionName,
      status: this.currentStatus,
      me: this.me,
    };
  }

  getQRCode(): QRCodeResponse | null {
    if (!this.currentQrDataUrl) return null;
    return { value: this.currentQrDataUrl, mimetype: 'image/png' };
  }

  // ---- events ----

  onMessage(cb: MessageHandler) {
    this.handlers.message.push(cb);
  }

  onStatus(cb: StatusHandler) {
    this.handlers.status.push(cb);
  }

  onQr(cb: QrHandler) {
    this.handlers.qr.push(cb);
  }

  // ---- messaging ----

  async sendMessage(chatId: string, text: string): Promise<SendMessageResponse> {
    return this.sendInternal(chatId, text);
  }

  async replyMessage(chatId: string, text: string, quotedMessageId?: string): Promise<SendMessageResponse> {
    const quoted = quotedMessageId ? this.messageCache.get(quotedMessageId) : undefined;
    return this.sendInternal(chatId, text, quoted);
  }

  async sendSeen(chatId: string, messageIds?: string[]): Promise<void> {
    if (!this.sock || !messageIds || messageIds.length === 0) return;
    const keys: WAMessageKey[] = [];
    for (const id of messageIds) {
      const cached = this.messageCache.get(id);
      if (cached?.key) {
        keys.push(cached.key);
      } else {
        // Fallback — build a partial key. Baileys will try its best.
        keys.push({ id, remoteJid: this.toJid(chatId), fromMe: false });
      }
    }
    try {
      await this.sock.readMessages(keys);
    } catch {
      // non-fatal
    }
  }

  async downloadMediaWithInfo(source: {
    id?: string;
    media?: BaileysMessageMedia | null;
    mediaUrl?: string;
    mimetype?: string;
  }): Promise<{ buffer: Buffer; mimetype: string }> {
    const id = source.id;
    const cached = id ? this.messageCache.get(id) : undefined;
    if (!cached) {
      throw new Error(`Cannot download media: message ${id || '(no id)'} not in cache.`);
    }

    const buffer = await downloadMediaMessage(
      cached,
      'buffer',
      {},
      {
        logger: this.logger as unknown as Parameters<typeof downloadMediaMessage>[3] extends infer T
          ? T extends { logger: infer L }
            ? L
            : never
          : never,
        reuploadRequest: this.sock!.updateMediaMessage,
      },
    );

    const mimetype =
      cached.message?.audioMessage?.mimetype ||
      cached.message?.imageMessage?.mimetype ||
      cached.message?.videoMessage?.mimetype ||
      cached.message?.documentMessage?.mimetype ||
      source.media?.mimetype ||
      source.mimetype ||
      'application/octet-stream';

    return { buffer, mimetype };
  }

  async getGroups(opts: { forceRefresh?: boolean } = {}): Promise<BaileysGroupSummary[]> {
    if (!this.sock || this.currentStatus !== 'WORKING') {
      throw new Error('Session must be WORKING before listing groups.');
    }
    if (this.groupCache && !opts.forceRefresh) {
      return this.groupCache;
    }

    const groups = await this.sock.groupFetchAllParticipating();
    const summaries: BaileysGroupSummary[] = Object.values(groups).map((g) => ({
      id: g.id,
      subject: g.subject || g.id,
      size: g.participants?.length ?? 0,
      participants: (g.participants ?? []).map((p) => ({
        id: p.id,
        phoneNumber: (p.id || '').replace(/@.*$/, '').replace(/\D/g, ''),
        admin: (p.admin as string | null | undefined) ?? null,
        displayName: this.senderNames.get(p.id) || undefined,
      })),
    }));

    this.groupCache = summaries;
    return summaries;
  }

  static isVoiceNote(message: BaileysMessage): boolean {
    if (message.type === 'audio' || message.type === 'ptt' || message.type === 'voice') {
      return true;
    }
    const mimetype = message.media?.mimetype || message.mimetype || '';
    return mimetype.toLowerCase().startsWith('audio/');
  }

  // ---- internals ----

  private async sendInternal(
    chatId: string,
    text: string,
    quoted?: WAMessage,
  ): Promise<SendMessageResponse> {
    if (!this.sock) {
      throw new Error('Baileys socket is not connected. Call start() first.');
    }
    const jid = this.toJid(chatId);
    const sent = await this.sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
    const id = sent?.key?.id || undefined;
    if (sent) {
      this.rememberMessage(sent);
    }
    return { id, timestamp: Date.now() };
  }

  private toJid(chatId: string): string {
    if (chatId.endsWith('@g.us')) return chatId;
    if (chatId.endsWith('@s.whatsapp.net')) return chatId;
    if (chatId.endsWith('@c.us')) {
      return `${chatId.replace('@c.us', '')}@s.whatsapp.net`;
    }
    if (chatId.endsWith('@lid')) return chatId;
    // Bare number — assume DM.
    const digits = chatId.replace(/\D/g, '');
    return `${digits}@s.whatsapp.net`;
  }

  private async handleConnectionUpdate(update: {
    connection?: 'open' | 'close' | 'connecting';
    qr?: string;
    lastDisconnect?: { error?: Error | Boom };
  }) {
    if (update.qr) {
      try {
        const dataUrl = await QRCode.toDataURL(update.qr);
        this.currentQrDataUrl = dataUrl;
        this.setStatus('SCAN_QR_CODE');
        for (const cb of this.handlers.qr) {
          void cb(dataUrl);
        }
      } catch {
        // swallow — status update still fires
      }
    }

    if (update.connection === 'open') {
      this.currentQrDataUrl = null;
      this.groupCache = null;
      const user = this.sock?.user;
      this.me = user ? { id: user.id || '', pushName: user.name } : undefined;
      this.setStatus('WORKING');
    }

    if (update.connection === 'connecting') {
      if (this.currentStatus !== 'SCAN_QR_CODE') {
        this.setStatus('STARTING');
      }
    }

    if (update.connection === 'close') {
      // Drop the dead socket + its listeners before deciding what to do next.
      // Without this, start() sees a non-null sock and short-circuits → we stall in STARTING
      // forever on 515 (restartRequired — fires right after first pairing) and similar.
      const deadSock = this.sock;
      this.sock = null;
      try {
        deadSock?.ev.removeAllListeners('creds.update');
        deadSock?.ev.removeAllListeners('connection.update');
        deadSock?.ev.removeAllListeners('messages.upsert');
      } catch {
        // best-effort
      }

      const err = update.lastDisconnect?.error as Boom | undefined;
      const code = (err?.output?.statusCode as number | undefined) ?? undefined;
      const loggedOut = code === DisconnectReason.loggedOut;
      const reasonName = code != null ? (DisconnectReason[code] ?? String(code)) : 'unknown';
      this.logger.warn({ code, reasonName, loggedOut, stopping: this.stopping }, 'baileys connection closed');

      // Any non-loggedOut close here is treated as transient. 515 (restartRequired)
      // is especially common immediately after first pairing — WA requires a clean reconnect.
      if (loggedOut) {
        try {
          await fs.rm(this.authDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        this.setStatus('STOPPED');
        return;
      }

      if (this.stopping) {
        this.setStatus('STOPPED');
        return;
      }

      this.setStatus('STARTING');
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.start();
      }, code === DisconnectReason.restartRequired ? 250 : 2000);
    }
  }

  private rememberMessage(message: WAMessage) {
    const id = message.key?.id;
    if (!id) return;
    if (this.messageCache.has(id)) {
      // refresh existing entry (e.g. outbound → ack)
      this.messageCache.set(id, message);
      return;
    }
    this.messageCache.set(id, message);
    this.messageCacheOrder.push(id);
    if (this.messageCacheOrder.length > MESSAGE_CACHE_CAP) {
      const evicted = this.messageCacheOrder.shift();
      if (evicted) this.messageCache.delete(evicted);
    }
  }

  private normalizeIncoming(raw: WAMessage): BaileysMessage | null {
    const key = raw.key;
    if (!key?.remoteJid || !key.id) return null;

    const remoteJid = key.remoteJid;
    const fromMe = Boolean(key.fromMe);
    const isGroup = remoteJid.endsWith('@g.us');
    const selfJid = this.sock?.user?.id || '';

    // Group: participant is actual sender. DM: sender = remoteJid (unless fromMe → self).
    const participant = isGroup
      ? (key.participant || (raw.participant as string | undefined) || undefined)
      : (fromMe ? selfJid : remoteJid);

    // For DMs, `from` should carry the remote participant's jid (so downstream chatId extraction works).
    const from = isGroup ? remoteJid : (fromMe ? selfJid || remoteJid : remoteJid);
    const to = isGroup ? remoteJid : (fromMe ? remoteJid : selfJid || remoteJid);

    const message = raw.message;
    const { body, type, media, mimetype, replyTo } = this.extractContent(message);

    const timestampSec =
      typeof raw.messageTimestamp === 'number'
        ? raw.messageTimestamp
        : raw.messageTimestamp && typeof (raw.messageTimestamp as { toNumber?: () => number }).toNumber === 'function'
          ? (raw.messageTimestamp as { toNumber: () => number }).toNumber()
          : undefined;

    return {
      id: key.id,
      timestamp: timestampSec,
      from,
      to,
      body,
      fromMe,
      hasMedia: Boolean(media),
      type,
      participant,
      mimetype,
      media,
      replyTo,
      quotedMessageId: replyTo,
    };
  }

  private extractContent(message: proto.IMessage | null | undefined): {
    body: string;
    type: BaileysMessage['type'];
    media: BaileysMessageMedia | null;
    mimetype: string | undefined;
    replyTo: string | undefined;
  } {
    if (!message) {
      return { body: '', type: 'chat', media: null, mimetype: undefined, replyTo: undefined };
    }

    // Some messages are wrapped (e.g. ephemeral, viewOnce). Unwrap to inner.
    const inner =
      message.ephemeralMessage?.message ||
      message.viewOnceMessage?.message ||
      message.viewOnceMessageV2?.message ||
      message.viewOnceMessageV2Extension?.message ||
      message;

    if (inner.conversation) {
      return {
        body: inner.conversation,
        type: 'chat',
        media: null,
        mimetype: undefined,
        replyTo: undefined,
      };
    }

    if (inner.extendedTextMessage) {
      const ext = inner.extendedTextMessage;
      return {
        body: ext.text || '',
        type: 'chat',
        media: null,
        mimetype: undefined,
        replyTo: ext.contextInfo?.stanzaId || undefined,
      };
    }

    if (inner.audioMessage) {
      const a = inner.audioMessage;
      const isVoice = a.ptt === true;
      return {
        body: '',
        type: isVoice ? 'ptt' : 'audio',
        media: { mimetype: a.mimetype || undefined },
        mimetype: a.mimetype || undefined,
        replyTo: a.contextInfo?.stanzaId || undefined,
      };
    }

    if (inner.imageMessage) {
      const img = inner.imageMessage;
      return {
        body: img.caption || '',
        type: 'image',
        media: { mimetype: img.mimetype || undefined },
        mimetype: img.mimetype || undefined,
        replyTo: img.contextInfo?.stanzaId || undefined,
      };
    }

    if (inner.videoMessage) {
      const v = inner.videoMessage;
      return {
        body: v.caption || '',
        type: 'video',
        media: { mimetype: v.mimetype || undefined },
        mimetype: v.mimetype || undefined,
        replyTo: v.contextInfo?.stanzaId || undefined,
      };
    }

    if (inner.documentMessage) {
      const d = inner.documentMessage;
      return {
        body: d.caption || d.fileName || '',
        type: 'document',
        media: { mimetype: d.mimetype || undefined, filename: d.fileName || undefined },
        mimetype: d.mimetype || undefined,
        replyTo: d.contextInfo?.stanzaId || undefined,
      };
    }

    if (inner.stickerMessage) {
      return {
        body: '',
        type: 'sticker',
        media: { mimetype: inner.stickerMessage.mimetype || undefined },
        mimetype: inner.stickerMessage.mimetype || undefined,
        replyTo: inner.stickerMessage.contextInfo?.stanzaId || undefined,
      };
    }

    return { body: '', type: 'chat', media: null, mimetype: undefined, replyTo: undefined };
  }

  private setStatus(status: SessionStatus['status']) {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    const snapshot = this.getSessionStatus();
    for (const cb of this.handlers.status) {
      void cb(snapshot);
    }
  }
}

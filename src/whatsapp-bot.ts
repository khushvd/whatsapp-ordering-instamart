import express from 'express';
import { createServer } from 'http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import 'dotenv/config';

import { SwiggyMcpClient } from './mcp/swiggy-client.js';
import { SwiggyOAuth } from './mcp/swiggy-oauth.js';
import { validateGeminiApiKey } from './llm/gemini-client.js';
import { OrderIntakeService } from './orders/order-intake-service.js';
import { OrderOrchestrator, type OrderRuntimeMetrics } from './orders/order-orchestrator.js';
import { OrderStore } from './orders/order-store.js';
import { SwiggyOrderWorker } from './orders/swiggy-order-worker.js';
import type { TransportMessage } from './orders/types.js';
import {
  BaileysClient,
  type BaileysMessage,
  type SessionStatus,
} from './whatsapp/baileys-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const PORT_RETRY_LIMIT = 5; // try 3000..3004 before giving up
const PORT_FILE = path.resolve('./data/server.port');
const SESSION_NAME = process.env.SESSION_NAME || 'default';
const BAILEYS_AUTH_DIR = path.resolve(process.env.BAILEYS_AUTH_DIR || './data/baileys-auth');
const ORDER_DB_PATH = path.resolve(process.env.ORDER_DB_PATH || './data/orders.sqlite');
const SWIGGY_MCP_URL = process.env.SWIGGY_MCP_URL || 'https://mcp.swiggy.com/im';

const ENV_ALLOWED_GROUPS: string[] = (process.env.ALLOWED_GROUPS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const ENV_ALLOWED_SENDERS_RAW: string[] = (process.env.ALLOWED_GROUP_SENDERS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const ALLOWED_GROUPS: Set<string> = new Set();
const ALLOWED_GROUP_SENDERS: Set<string> = new Set();

const metrics: OrderRuntimeMetrics & { startTime: number } = {
  messagesReceived: 0,
  ignoredMessages: 0,
  draftsCreated: 0,
  jobsQueued: 0,
  jobsProcessed: 0,
  jobsFailed: 0,
  searchesPerformed: 0,
  productsAdded: 0,
  voiceNotesProcessed: 0,
  errors: 0,
  startTime: Date.now(),
};

const app = express();
app.use(express.json());

app.use((error: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  next(error);
});

const httpServer = createServer(app);
const io = new Server(httpServer);
app.use(express.static(path.join(__dirname, '../public')));

const baileys = new BaileysClient({ authDir: BAILEYS_AUTH_DIR, sessionName: SESSION_NAME });
const store = new OrderStore(ORDER_DB_PATH);
const intake = new OrderIntakeService(() => store.getGeminiApiKey() ?? process.env.GEMINI_API_KEY);
const oauth = new SwiggyOAuth(store);
const mcpClient = new SwiggyMcpClient(SWIGGY_MCP_URL, oauth);
const worker = new SwiggyOrderWorker(store, mcpClient);

const RECENT_OUTBOUND_IDS_CAP = 500;
const recentOutboundMessageIds: string[] = [];
const recentOutboundSet = new Set<string>();

function rememberOutboundMessageId(id?: string) {
  if (!id) return;
  if (recentOutboundSet.has(id)) return;

  recentOutboundSet.add(id);
  recentOutboundMessageIds.push(id);
  if (recentOutboundMessageIds.length > RECENT_OUTBOUND_IDS_CAP) {
    const evicted = recentOutboundMessageIds.shift();
    if (evicted) {
      recentOutboundSet.delete(evicted);
    }
  }
}

let currentSessionStatus: SessionStatus = {
  name: SESSION_NAME,
  status: 'STARTING',
};
let latestQrDataUrl: string | null = null;

function log(message: string) {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] ${message}`;
  console.log(formatted);
  io.emit('log', message);
}

const orchestrator = new OrderOrchestrator(
  store,
  intake,
  worker,
  oauth,
  async (input) => {
    try {
      if (input.replyToMessageId) {
        try {
          await baileys.sendSeen(input.chatId, [input.replyToMessageId]);
        } catch (error) {
          log(`sendSeen failed for ${input.chatId}: ${stringifyError(error)}`);
        }
      }

      const response = input.replyToMessageId
        ? await baileys.replyMessage(input.chatId, input.text, input.replyToMessageId)
        : await baileys.sendMessage(input.chatId, input.text);

      rememberOutboundMessageId(response.id);

      store.recordEvent({
        chatId: input.chatId,
        senderId: input.senderId,
        draftOrderId: input.draftOrderId,
        jobId: input.jobId,
        direction: 'outbound',
        eventType: input.eventType,
        messageId: response.id,
        text: input.text,
        payload: response as Record<string, unknown>,
      });

      return {
        id: response.id,
      };
    } catch (error) {
      metrics.errors += 1;
      store.recordEvent({
        chatId: input.chatId,
        senderId: input.senderId,
        draftOrderId: input.draftOrderId,
        jobId: input.jobId,
        direction: 'system',
        eventType: `${input.eventType}.error`,
        text: stringifyError(error),
      });
      throw error;
    }
  },
  async (message) =>
    baileys.downloadMediaWithInfo({
      id: message.id,
      mediaUrl: message.mediaUrl,
      mimetype: message.mimetype,
    }),
  metrics,
  log,
);

baileys.onStatus((status) => {
  const previous = currentSessionStatus.status;
  currentSessionStatus = status;
  io.emit('session-status', status);
  if (status.status === 'WORKING') {
    io.emit('ready');
    latestQrDataUrl = null;
  }
  if (status.status !== previous) {
    log(`Session status: ${previous} → ${status.status}`);
  }
});

baileys.onQr((dataUrl) => {
  latestQrDataUrl = dataUrl;
  io.emit('qr', dataUrl);
  log('Scan the QR in the dashboard to link WhatsApp.');
});

baileys.onMessage((raw) => {
  void handleIncomingMessage(raw);
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - metrics.startTime) / 1000),
    session: currentSessionStatus.status,
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', (_req, res) => {
  res.json({
    ...metrics,
    uptime: Math.floor((Date.now() - metrics.startTime) / 1000),
  });
});

app.get('/api/session-status', (_req, res) => {
  res.json({
    ...currentSessionStatus,
    qr: currentSessionStatus.status === 'SCAN_QR_CODE' ? latestQrDataUrl : null,
  });
});

app.post('/api/session/start', async (_req, res) => {
  try {
    const status = await baileys.start();
    res.json(status);
  } catch (error) {
    metrics.errors += 1;
    res.status(500).json({ error: stringifyError(error) });
  }
});

app.post('/api/session/stop', async (_req, res) => {
  try {
    await baileys.stop();
    res.json({ success: true });
  } catch (error) {
    metrics.errors += 1;
    res.status(500).json({ error: stringifyError(error) });
  }
});

app.post('/api/session/logout', async (_req, res) => {
  try {
    await baileys.logout();
    res.json({ success: true });
  } catch (error) {
    metrics.errors += 1;
    res.status(500).json({ error: stringifyError(error) });
  }
});

app.get('/api/config', (_req, res) => {
  const stored = store.getAppConfig();
  res.json({
    env: {
      groups: ENV_ALLOWED_GROUPS,
      senders: ENV_ALLOWED_SENDERS_RAW,
    },
    stored: stored
      ? {
          allowedGroups: stored.allowedGroups,
          allowedSenders: stored.allowedSenders,
          updatedAt: stored.updatedAt,
        }
      : null,
    effective: {
      groups: Array.from(ALLOWED_GROUPS),
      senders: Array.from(ALLOWED_GROUP_SENDERS),
    },
  });
});

app.post('/api/config', (req, res) => {
  const body = (req.body || {}) as { allowedGroups?: unknown; allowedSenders?: unknown };
  const rawGroups = Array.isArray(body.allowedGroups) ? body.allowedGroups : [];
  const rawSenders = Array.isArray(body.allowedSenders) ? body.allowedSenders : [];

  const allowedGroups = rawGroups
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);

  const allowedSenders = rawSenders
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);

  try {
    store.saveAppConfig({ allowedGroups, allowedSenders });
    const reloaded = reloadAllowLists();
    log(`Config saved. Allowed groups (${reloaded.source}): ${reloaded.groups.join(', ') || '(none)'}`);
    log(`Allowed senders (${reloaded.source}): ${reloaded.senders.join(', ') || '(none)'}`);
    res.json({
      success: true,
      effective: {
        groups: reloaded.groups,
        senders: reloaded.senders,
      },
    });
  } catch (error) {
    metrics.errors += 1;
    res.status(500).json({ error: stringifyError(error) });
  }
});

app.get('/api/mcp/status', (_req, res) => {
  const auth = store.getMcpAuth();
  const token = store.getMcpToken();
  const expiresAt = token?.expiresAt;
  const expiresInSeconds = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : null;

  res.json({
    state: auth?.state ?? 'disconnected',
    expiresAt,
    expiresInSeconds,
    lastUpdated: auth?.lastUpdated,
  });
});

app.get('/api/gemini-key', (_req, res) => {
  const stored = store.getGeminiApiKey();
  const env = process.env.GEMINI_API_KEY;
  res.json({
    isSet: Boolean(stored || env),
    source: stored ? 'stored' : env ? 'env' : null,
  });
});

app.post('/api/gemini-key', async (req, res) => {
  const body = (req.body || {}) as { key?: unknown };
  if (typeof body.key !== 'string' || body.key.trim().length === 0) {
    res.status(400).json({ ok: false, reason: 'Missing key. Paste your Gemini API key.' });
    return;
  }

  try {
    const result = await validateGeminiApiKey(body.key);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    store.setGeminiApiKey(body.key.trim());
    intake.resetClients();
    log('Gemini API key updated via UI.');
    res.json({ ok: true });
  } catch (error) {
    metrics.errors += 1;
    res.status(500).json({ ok: false, reason: stringifyError(error) });
  }
});

app.delete('/api/gemini-key', (_req, res) => {
  try {
    store.clearGeminiApiKey();
    intake.resetClients();
    log('Gemini API key cleared via UI.');
    res.json({ ok: true });
  } catch (error) {
    metrics.errors += 1;
    res.status(500).json({ ok: false, reason: stringifyError(error) });
  }
});

app.post('/api/mcp/begin-auth', async (_req, res) => {
  try {
    const { authUrl, redirectUri } = await oauth.beginAuth();
    res.json({ ok: true, authUrl, redirectUri });
  } catch (error) {
    metrics.errors += 1;
    res.status(500).json({ ok: false, reason: stringifyError(error) });
  }
});

app.post('/api/mcp/complete-auth', async (req, res) => {
  const body = (req.body || {}) as { callbackUrl?: unknown };
  if (typeof body.callbackUrl !== 'string' || body.callbackUrl.trim().length === 0) {
    res.status(400).json({ ok: false, reason: 'Paste the full callback URL from your browser.' });
    return;
  }

  try {
    const { expiresAt } = await oauth.completeAuth(body.callbackUrl.trim());
    log('Swiggy MCP authenticated via UI.');
    res.json({ ok: true, expiresAt });
  } catch (error) {
    metrics.errors += 1;
    res.status(400).json({ ok: false, reason: stringifyError(error) });
  }
});

app.post('/api/mcp/disconnect', (_req, res) => {
  try {
    oauth.disconnect();
    log('Swiggy MCP disconnected via UI.');
    res.json({ ok: true });
  } catch (error) {
    metrics.errors += 1;
    res.status(500).json({ ok: false, reason: stringifyError(error) });
  }
});

app.get('/api/groups', async (req, res) => {
  if (currentSessionStatus.status !== 'WORKING') {
    res.status(409).json({ error: 'Session must be WORKING to list groups.' });
    return;
  }

  try {
    const forceRefresh = req.query.refresh === 'true' || req.query.refresh === '1';
    const groups = await baileys.getGroups({ forceRefresh });
    res.json({ groups });
  } catch (error) {
    metrics.errors += 1;
    res.status(500).json({ error: stringifyError(error) });
  }
});

function listenWithRetry(startPort: number, attemptsLeft: number): void {
  const onError = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 1) {
      const next = startPort + 1;
      log(`Port ${startPort} is busy, trying ${next}...`);
      httpServer.removeListener('error', onError);
      listenWithRetry(next, attemptsLeft - 1);
      return;
    }
    log(`Failed to bind to port ${startPort}: ${err.message}`);
    process.exit(1);
  };
  httpServer.once('error', onError);
  httpServer.listen(startPort, async () => {
    httpServer.removeListener('error', onError);
    try {
      fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
      fs.writeFileSync(PORT_FILE, String(startPort), 'utf8');
    } catch (e) {
      log(`Could not write ${PORT_FILE}: ${e instanceof Error ? e.message : e}`);
    }
    log(`Server running at http://localhost:${startPort}`);
    log(`Baileys auth dir: ${BAILEYS_AUTH_DIR}`);
    log(`SQLite path: ${ORDER_DB_PATH}`);

    const reloaded = reloadAllowLists();
    log(`Allowed groups (${reloaded.source}): ${reloaded.groups.length > 0 ? reloaded.groups.join(', ') : '(none)'}`);
    log(`Allowed senders (${reloaded.source}): ${reloaded.senders.length > 0 ? reloaded.senders.join(', ') : '(none)'}`);

    await startup();
  });
}

listenWithRetry(PORT, PORT_RETRY_LIMIT);

process.on('SIGTERM', async () => {
  log('Received SIGTERM. Shutting down...');
  await shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('Received SIGINT. Shutting down...');
  await shutdown();
  process.exit(0);
});

async function startup() {
  await orchestrator.recoverAndResume();
  try {
    await baileys.start();
  } catch (error) {
    metrics.errors += 1;
    log(`Baileys start failed: ${stringifyError(error)}`);
  }
}

async function shutdown() {
  try {
    await baileys.stop();
  } catch (error) {
    log(`Baileys shutdown failed: ${stringifyError(error)}`);
  }

  try {
    await worker.close();
  } catch (error) {
    log(`Worker shutdown failed: ${stringifyError(error)}`);
  }

  try {
    store.close();
  } catch (error) {
    log(`Store shutdown failed: ${stringifyError(error)}`);
  }
}

async function handleIncomingMessage(rawMessage: BaileysMessage) {
  const message = normalizeIncomingMessage(rawMessage);
  if (!message) {
    log(`msg: drop (not normalizable) raw.from=${(rawMessage as any).from} raw.to=${(rawMessage as any).to}`);
    return;
  }

  log(`msg: chat=${message.chatId} sender=${message.senderId} fromMe=${message.fromMe} group=${message.isGroup} voice=${message.isVoiceNote} body="${(message.body || '').slice(0, 40)}"`);

  if (!message.body && !message.isVoiceNote) {
    const raw = rawMessage as unknown as Record<string, unknown>;
    const media = (raw.media as Record<string, unknown> | undefined) ?? undefined;
    log(`msg: empty body diag type=${String(raw.type)} mimetype=${String(raw.mimetype ?? media?.mimetype)} hasMedia=${String(raw.hasMedia)}`);
  }

  if (message.fromMe && recentOutboundSet.has(message.id)) {
    log('msg: drop (own echo)');
    return;
  }

  if (!message.isGroup) {
    log('msg: drop (not group)');
    metrics.ignoredMessages += 1;
    return;
  }

  if (!ALLOWED_GROUPS.has(message.chatId)) {
    log(`msg: drop (chat not allowed: ${message.chatId})`);
    metrics.ignoredMessages += 1;
    return;
  }

  if (!message.fromMe && !isAllowedSender(message.senderId)) {
    log(`msg: drop (sender not allowed: ${message.senderId})`);
    metrics.ignoredMessages += 1;
    return;
  }

  try {
    const recorded = store.recordInboundMessage(message, rawMessage as unknown as Record<string, unknown>);
    if (!recorded) {
      return;
    }

    metrics.messagesReceived += 1;
    await orchestrator.handleMessage(message);
  } catch (error) {
    metrics.errors += 1;
    log(`Message handling failed: ${stringifyError(error)}`);
  }
}

function normalizeIncomingMessage(message: BaileysMessage): TransportMessage | null {
  const chatId = normalizeChatId(extractChatId(message));
  if (!chatId) {
    return null;
  }

  const senderId = normalizeContactId(extractSenderId(message, chatId));
  if (!senderId) {
    return null;
  }

  return {
    id: message.id,
    timestampMs: normalizeTimestamp(message.timestamp),
    chatId,
    senderId,
    senderPhone: extractPhoneNumber(senderId),
    body: (message.body || '').trim(),
    type: message.type || 'chat',
    hasMedia: Boolean(message.hasMedia || message.media?.url || message.mediaUrl),
    isVoiceNote: BaileysClient.isVoiceNote(message),
    isGroup: chatId.endsWith('@g.us'),
    fromMe: Boolean(message.fromMe),
    mimetype: message.media?.mimetype || message.mimetype,
    mediaUrl: message.media?.url || message.mediaUrl,
    replyToMessageId: extractReplyToMessageId(message),
  };
}

function extractChatId(message: BaileysMessage): string {
  const from = normalizeContactId(message.from);
  const to = normalizeContactId(message.to);

  if (from.endsWith('@g.us')) {
    return from;
  }

  if (to.endsWith('@g.us')) {
    return to;
  }

  return from || to;
}

function extractSenderId(message: BaileysMessage, fallbackChatId: string): string {
  const rawMessage = message as BaileysMessage & {
    author?: string;
    participantId?: string;
  };

  return normalizeContactId(
    rawMessage.participant ||
      rawMessage.author ||
      rawMessage.participantId ||
      message.from ||
      fallbackChatId,
  );
}

function extractReplyToMessageId(message: BaileysMessage): string | undefined {
  const rawMessage = message as BaileysMessage & {
    context?: {
      quotedMessageId?: string;
    };
    replyToMessageId?: string;
  };

  return (
    message.replyTo ||
    message.quotedMessageId ||
    rawMessage.replyToMessageId ||
    rawMessage.context?.quotedMessageId
  );
}

function normalizeContactId(value?: string): string {
  if (!value) {
    return '';
  }

  return value
    .trim()
    .replace('@s.whatsapp.net', '@c.us')
    .replace(/:\d+(?=@)/, '');
}

function normalizeChatId(value?: string): string {
  return normalizeContactId(value);
}

function extractPhoneNumber(value?: string): string {
  return (value || '').replace(/@.*$/, '').replace(/\D/g, '');
}

function isAllowedSender(senderId: string): boolean {
  const normalizedSenderId = normalizeContactId(senderId);
  if (normalizedSenderId.endsWith('@lid')) {
    return true;
  }
  const senderPhone = extractPhoneNumber(normalizedSenderId);

  return ALLOWED_GROUP_SENDERS.has(normalizedSenderId) || ALLOWED_GROUP_SENDERS.has(senderPhone);
}

function expandSenderEntry(value: string): string[] {
  const normalized = normalizeContactId(value);
  const phone = extractPhoneNumber(normalized);
  return [normalized, phone].filter(Boolean);
}

function reloadAllowLists(): { groups: string[]; senders: string[]; source: 'env' | 'db' | 'merged' } {
  const stored = store.getAppConfig();

  const groups = new Set<string>();
  const senders = new Set<string>();

  for (const group of ENV_ALLOWED_GROUPS) {
    groups.add(group);
  }
  for (const raw of ENV_ALLOWED_SENDERS_RAW) {
    for (const expanded of expandSenderEntry(raw)) {
      senders.add(expanded);
    }
  }

  if (stored) {
    for (const group of stored.allowedGroups) {
      groups.add(group);
    }
    for (const raw of stored.allowedSenders) {
      for (const expanded of expandSenderEntry(raw)) {
        senders.add(expanded);
      }
    }
  }

  ALLOWED_GROUPS.clear();
  for (const g of groups) ALLOWED_GROUPS.add(g);
  ALLOWED_GROUP_SENDERS.clear();
  for (const s of senders) ALLOWED_GROUP_SENDERS.add(s);

  const source: 'env' | 'db' | 'merged' =
    stored && (ENV_ALLOWED_GROUPS.length || ENV_ALLOWED_SENDERS_RAW.length)
      ? 'merged'
      : stored
        ? 'db'
        : 'env';

  return {
    groups: Array.from(ALLOWED_GROUPS),
    senders: Array.from(ALLOWED_GROUP_SENDERS),
    source,
  };
}

function normalizeTimestamp(timestamp?: number): number {
  if (!timestamp) {
    return Date.now();
  }

  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

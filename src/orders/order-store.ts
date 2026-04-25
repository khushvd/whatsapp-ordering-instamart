import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type {
  DeliveryAddress,
  DraftOrder,
  DraftStatus,
  Favorite,
  JobStatus,
  OrderEvent,
  OrderJob,
  OrderWorkerResult,
  PendingItem,
  PendingItemSource,
  ResolvedDraftItem,
  SourceType,
  TransportMessage,
  McpAuthRecord,
  McpAuthState,
} from './types.js';
import type { ShoppingItem } from '../llm/gemini-client.js';

interface DraftRow {
  id: string;
  chat_id: string;
  sender_id: string;
  source_type: SourceType;
  raw_input: string;
  transcription: string | null;
  parsed_items_json: string;
  resolved_items_json: string | null;
  delivery_address_id: string | null;
  delivery_address_label: string | null;
  subtotal_paise: number | null;
  status: DraftStatus;
  source_message_id: string | null;
  confirmation_message_id: string | null;
  created_at: number;
  updated_at: number;
}

interface JobRow {
  id: string;
  draft_order_id: string;
  chat_id: string;
  sender_id: string;
  items_json: string;
  resolved_items_json: string | null;
  delivery_address_id: string | null;
  status: JobStatus;
  attempt_count: number;
  error_text: string | null;
  worker_result_json: string | null;
  queued_message_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface EventRow {
  id: number;
  chat_id: string;
  sender_id: string | null;
  draft_order_id: string | null;
  job_id: string | null;
  direction: 'inbound' | 'outbound' | 'system';
  event_type: string;
  message_id: string | null;
  text: string | null;
  payload_json: string | null;
  created_at: number;
}

export interface PersistedEventInput {
  chatId: string;
  senderId?: string;
  draftOrderId?: string;
  jobId?: string;
  direction: 'inbound' | 'outbound' | 'system';
  eventType: string;
  messageId?: string;
  text?: string;
  payload?: Record<string, unknown>;
}

export interface CreateDraftInput {
  chatId: string;
  senderId: string;
  sourceType: SourceType;
  rawInput: string;
  transcription?: string;
  parsedItems: ShoppingItem[];
  sourceMessageId?: string;
}

export interface UpdateDraftInput extends CreateDraftInput {
  draftId: string;
}

export class OrderStore {
  private db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initialize();
  }

  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS draft_orders (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        raw_input TEXT NOT NULL,
        transcription TEXT,
        parsed_items_json TEXT NOT NULL,
        status TEXT NOT NULL,
        source_message_id TEXT,
        confirmation_message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        draft_order_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        items_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_text TEXT,
        worker_result_json TEXT,
        queued_message_id TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        FOREIGN KEY (draft_order_id) REFERENCES draft_orders(id)
      );

      CREATE TABLE IF NOT EXISTS order_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        sender_id TEXT,
        draft_order_id TEXT,
        job_id TEXT,
        direction TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message_id TEXT,
        text TEXT,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_draft_orders_lookup
      ON draft_orders(chat_id, sender_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_jobs_status_created
      ON jobs(status, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_order_events_lookup
      ON order_events(chat_id, sender_id, created_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_order_events_inbound_message
      ON order_events(message_id)
      WHERE direction = 'inbound' AND message_id IS NOT NULL;

      DROP TABLE IF EXISTS favorites;
      CREATE TABLE IF NOT EXISTS favorites (
        chat_id TEXT NOT NULL,
        normalized_query TEXT NOT NULL,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        order_count INTEGER NOT NULL DEFAULT 1,
        last_ordered_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, normalized_query)
      );

      CREATE TABLE IF NOT EXISTS pending_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        message_id TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('voice', 'text')),
        raw_input TEXT NOT NULL,
        transcription TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pending_items_chat
      ON pending_items(chat_id, created_at ASC);

      DROP TABLE IF EXISTS zepto_auth;
      CREATE TABLE IF NOT EXISTS mcp_auth (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL CHECK (state IN ('authenticated', 'disconnected')),
        last_updated INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        scope TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_auth_flow (
        state TEXT PRIMARY KEY,
        code_verifier TEXT NOT NULL,
        client_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        allowed_groups_json TEXT NOT NULL DEFAULT '[]',
        allowed_senders_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_prefs (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        home_address_id TEXT,
        home_address_json TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aliases (
        chat_id TEXT NOT NULL,
        alias_term TEXT NOT NULL,
        canonical_query TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, alias_term)
      );
    `);

    this.ensureColumn('draft_orders', 'resolved_items_json', 'TEXT');
    this.ensureColumn('draft_orders', 'delivery_address_id', 'TEXT');
    this.ensureColumn('draft_orders', 'delivery_address_label', 'TEXT');
    this.ensureColumn('draft_orders', 'subtotal_paise', 'INTEGER');
    this.ensureColumn('jobs', 'resolved_items_json', 'TEXT');
    this.ensureColumn('jobs', 'delivery_address_id', 'TEXT');
    this.ensureColumn('app_config', 'gemini_api_key', 'TEXT');
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  getAppConfig(): { allowedGroups: string[]; allowedSenders: string[]; updatedAt: number } | undefined {
    const row = this.db.prepare(`
      SELECT allowed_groups_json, allowed_senders_json, updated_at FROM app_config WHERE id = 1
    `).get() as { allowed_groups_json: string; allowed_senders_json: string; updated_at: number } | undefined;

    if (!row) {
      return undefined;
    }

    try {
      return {
        allowedGroups: JSON.parse(row.allowed_groups_json) as string[],
        allowedSenders: JSON.parse(row.allowed_senders_json) as string[],
        updatedAt: row.updated_at,
      };
    } catch {
      return { allowedGroups: [], allowedSenders: [], updatedAt: row.updated_at };
    }
  }

  saveAppConfig(input: { allowedGroups: string[]; allowedSenders: string[] }): void {
    this.db.prepare(`
      INSERT INTO app_config (id, allowed_groups_json, allowed_senders_json, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        allowed_groups_json = excluded.allowed_groups_json,
        allowed_senders_json = excluded.allowed_senders_json,
        updated_at = excluded.updated_at
    `).run(
      JSON.stringify(input.allowedGroups),
      JSON.stringify(input.allowedSenders),
      Date.now(),
    );
  }

  getGeminiApiKey(): string | undefined {
    const row = this.db.prepare(`
      SELECT gemini_api_key FROM app_config WHERE id = 1
    `).get() as { gemini_api_key: string | null } | undefined;
    const value = row?.gemini_api_key ?? undefined;
    return value && value.trim().length > 0 ? value : undefined;
  }

  setGeminiApiKey(key: string): void {
    this.db.prepare(`
      INSERT INTO app_config (id, allowed_groups_json, allowed_senders_json, gemini_api_key, updated_at)
      VALUES (1, '[]', '[]', ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        gemini_api_key = excluded.gemini_api_key,
        updated_at = excluded.updated_at
    `).run(key, Date.now());
  }

  clearGeminiApiKey(): void {
    this.db.prepare(`
      UPDATE app_config SET gemini_api_key = NULL, updated_at = ? WHERE id = 1
    `).run(Date.now());
  }

  close() {
    this.db.close();
  }

  recordInboundMessage(message: TransportMessage, payload?: Record<string, unknown>): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO order_events (
        chat_id,
        sender_id,
        direction,
        event_type,
        message_id,
        text,
        payload_json,
        created_at
      ) VALUES (?, ?, 'inbound', 'message.received', ?, ?, ?, ?)
    `).run(
      message.chatId,
      message.senderId,
      message.id,
      message.body,
      payload ? JSON.stringify(payload) : null,
      Date.now(),
    );

    return Number(result.changes) > 0;
  }

  recordEvent(input: PersistedEventInput) {
    this.db.prepare(`
      INSERT INTO order_events (
        chat_id,
        sender_id,
        draft_order_id,
        job_id,
        direction,
        event_type,
        message_id,
        text,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.chatId,
      input.senderId ?? null,
      input.draftOrderId ?? null,
      input.jobId ?? null,
      input.direction,
      input.eventType,
      input.messageId ?? null,
      input.text ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
      Date.now(),
    );
  }

  getActiveDraft(chatId: string, senderId: string): DraftOrder | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM draft_orders
      WHERE chat_id = ?
        AND sender_id = ?
        AND status IN ('pending_confirmation', 'queued', 'processing')
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(chatId, senderId) as DraftRow | undefined;

    return row ? this.mapDraft(row) : undefined;
  }

  getDraftById(draftId: string): DraftOrder | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM draft_orders
      WHERE id = ?
      LIMIT 1
    `).get(draftId) as DraftRow | undefined;

    return row ? this.mapDraft(row) : undefined;
  }

  createDraft(input: CreateDraftInput): DraftOrder {
    const now = Date.now();
    const draftId = randomUUID();

    this.db.prepare(`
      INSERT INTO draft_orders (
        id,
        chat_id,
        sender_id,
        source_type,
        raw_input,
        transcription,
        parsed_items_json,
        status,
        source_message_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_confirmation', ?, ?, ?)
    `).run(
      draftId,
      input.chatId,
      input.senderId,
      input.sourceType,
      input.rawInput,
      input.transcription ?? null,
      JSON.stringify(input.parsedItems),
      input.sourceMessageId ?? null,
      now,
      now,
    );

    return this.getDraftById(draftId)!;
  }

  updateDraft(input: UpdateDraftInput): DraftOrder {
    const now = Date.now();

    this.db.prepare(`
      UPDATE draft_orders
      SET source_type = ?,
          raw_input = ?,
          transcription = ?,
          parsed_items_json = ?,
          resolved_items_json = NULL,
          delivery_address_id = NULL,
          delivery_address_label = NULL,
          subtotal_paise = NULL,
          status = 'pending_confirmation',
          source_message_id = ?,
          confirmation_message_id = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(
      input.sourceType,
      input.rawInput,
      input.transcription ?? null,
      JSON.stringify(input.parsedItems),
      input.sourceMessageId ?? null,
      now,
      input.draftId,
    );

    return this.getDraftById(input.draftId)!;
  }

  // Append new parsed items + their resolved counterparts to an existing
  // draft without re-resolving the items already in the cart. Preserves any
  // user `!pick` / `!qty` choices on prior items.
  appendDraftItems(input: {
    draftId: string;
    appendedParsedItems: ShoppingItem[];
    appendedResolvedItems: ResolvedDraftItem[];
    addressId?: string;
    addressLabel?: string;
    subtotalPaise?: number;
    sourceMessageId?: string;
    rawInputAddendum?: string;
  }): DraftOrder {
    const draft = this.getDraftById(input.draftId);
    if (!draft) {
      throw new Error(`appendDraftItems: draft ${input.draftId} not found`);
    }

    const mergedParsed = [...draft.parsedItems, ...input.appendedParsedItems];
    const mergedResolved = [
      ...(draft.resolvedItems ?? []),
      ...input.appendedResolvedItems,
    ];
    const mergedRawInput = input.rawInputAddendum
      ? `${draft.rawInput}\n${input.rawInputAddendum}`
      : draft.rawInput;
    const now = Date.now();

    this.db.prepare(`
      UPDATE draft_orders
      SET parsed_items_json = ?,
          resolved_items_json = ?,
          raw_input = ?,
          delivery_address_id = ?,
          delivery_address_label = ?,
          subtotal_paise = ?,
          source_message_id = ?,
          confirmation_message_id = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(mergedParsed),
      JSON.stringify(mergedResolved),
      mergedRawInput,
      input.addressId ?? draft.deliveryAddressId ?? null,
      input.addressLabel ?? draft.deliveryAddressLabel ?? null,
      input.subtotalPaise ?? draft.subtotalPaise ?? null,
      input.sourceMessageId ?? draft.sourceMessageId ?? null,
      now,
      input.draftId,
    );

    return this.getDraftById(input.draftId)!;
  }

  setDraftConfirmationMessage(draftId: string, confirmationMessageId?: string) {
    this.db.prepare(`
      UPDATE draft_orders
      SET confirmation_message_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(confirmationMessageId ?? null, Date.now(), draftId);
  }

  setDraftStatus(draftId: string, status: DraftStatus) {
    this.db.prepare(`
      UPDATE draft_orders
      SET status = ?,
          updated_at = ?
      WHERE id = ?
    `).run(status, Date.now(), draftId);
  }

  createJobForDraft(draft: DraftOrder, queuedMessageId?: string): OrderJob {
    const existing = this.getJobByDraftId(draft.id);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const jobId = randomUUID();

    this.db.prepare(`
      INSERT INTO jobs (
        id,
        draft_order_id,
        chat_id,
        sender_id,
        items_json,
        resolved_items_json,
        delivery_address_id,
        status,
        queued_message_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      jobId,
      draft.id,
      draft.chatId,
      draft.senderId,
      JSON.stringify(draft.parsedItems),
      draft.resolvedItems ? JSON.stringify(draft.resolvedItems) : null,
      draft.deliveryAddressId ?? null,
      queuedMessageId ?? null,
      now,
    );

    return this.getJobById(jobId)!;
  }

  saveDraftResolution(input: {
    draftId: string;
    resolvedItems: ResolvedDraftItem[];
    addressId: string;
    addressLabel?: string;
    subtotalPaise?: number;
  }): void {
    this.db.prepare(`
      UPDATE draft_orders
      SET resolved_items_json = ?,
          delivery_address_id = ?,
          delivery_address_label = ?,
          subtotal_paise = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(input.resolvedItems),
      input.addressId,
      input.addressLabel ?? null,
      input.subtotalPaise ?? null,
      Date.now(),
      input.draftId,
    );
  }

  clearDraftResolution(draftId: string): void {
    this.db.prepare(`
      UPDATE draft_orders
      SET resolved_items_json = NULL,
          delivery_address_id = NULL,
          delivery_address_label = NULL,
          subtotal_paise = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(Date.now(), draftId);
  }

  getHomeAddress(): DeliveryAddress | undefined {
    const row = this.db.prepare(`
      SELECT home_address_id, home_address_json FROM user_prefs WHERE id = 1
    `).get() as { home_address_id: string | null; home_address_json: string | null } | undefined;

    if (!row || !row.home_address_id) return undefined;

    if (row.home_address_json) {
      try {
        return JSON.parse(row.home_address_json) as DeliveryAddress;
      } catch {
        // fall through
      }
    }
    return { id: row.home_address_id };
  }

  setHomeAddress(address: DeliveryAddress): void {
    this.db.prepare(`
      INSERT INTO user_prefs (id, home_address_id, home_address_json, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        home_address_id = excluded.home_address_id,
        home_address_json = excluded.home_address_json,
        updated_at = excluded.updated_at
    `).run(address.id, JSON.stringify(address), Date.now());
  }

  clearHomeAddress(): void {
    this.db.prepare(`DELETE FROM user_prefs WHERE id = 1`).run();
  }

  getJobById(jobId: string): OrderJob | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM jobs
      WHERE id = ?
      LIMIT 1
    `).get(jobId) as JobRow | undefined;

    return row ? this.mapJob(row) : undefined;
  }

  getJobByDraftId(draftId: string): OrderJob | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM jobs
      WHERE draft_order_id = ?
      LIMIT 1
    `).get(draftId) as JobRow | undefined;

    return row ? this.mapJob(row) : undefined;
  }

  getNextQueuedJob(): OrderJob | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `).get() as JobRow | undefined;

    return row ? this.mapJob(row) : undefined;
  }

  claimQueuedJob(jobId: string): OrderJob | undefined {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'processing',
          attempt_count = attempt_count + 1,
          started_at = ?,
          error_text = NULL,
          finished_at = NULL
      WHERE id = ?
        AND status = 'queued'
    `).run(now, jobId);

    if (Number(result.changes) === 0) {
      return undefined;
    }

    return this.getJobById(jobId);
  }

  completeJob(jobId: string, workerResult: OrderWorkerResult) {
    const job = this.getJobById(jobId);
    if (!job) {
      return;
    }

    const finishedAt = Date.now();

    this.db.prepare(`
      UPDATE jobs
      SET status = 'completed',
          worker_result_json = ?,
          error_text = NULL,
          finished_at = ?
      WHERE id = ?
    `).run(JSON.stringify(workerResult), finishedAt, jobId);

    this.setDraftStatus(job.draftOrderId, 'completed');
  }

  failJob(jobId: string, errorText: string, workerResult?: OrderWorkerResult) {
    const job = this.getJobById(jobId);
    if (!job) {
      return;
    }

    const finishedAt = Date.now();

    this.db.prepare(`
      UPDATE jobs
      SET status = 'failed',
          worker_result_json = ?,
          error_text = ?,
          finished_at = ?
      WHERE id = ?
    `).run(workerResult ? JSON.stringify(workerResult) : null, errorText, finishedAt, jobId);

    this.setDraftStatus(job.draftOrderId, 'completed');
  }

  cancelDraft(draftId: string) {
    this.setDraftStatus(draftId, 'cancelled');
  }

  cancelQueuedJob(jobId: string, errorText: string = 'Cancelled before execution'): boolean {
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'cancelled',
          error_text = ?,
          finished_at = ?
      WHERE id = ?
        AND status = 'queued'
    `).run(errorText, Date.now(), jobId);

    return Number(result.changes) > 0;
  }

  getQueuedJobCountAhead(jobId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE status = 'queued'
        AND created_at < (
          SELECT created_at
          FROM jobs
          WHERE id = ?
        )
    `).get(jobId) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  recoverInterruptedJobs(): OrderJob[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM jobs
      WHERE status = 'processing'
      ORDER BY started_at ASC
    `).all() as unknown as JobRow[];

    const recovered: OrderJob[] = [];

    for (const row of rows) {
      this.db.prepare(`
        UPDATE jobs
        SET status = 'failed',
            error_text = ?,
            finished_at = ?
        WHERE id = ?
      `).run('Bot restarted while the job was processing. Manual review required.', Date.now(), row.id);

      this.setDraftStatus(row.draft_order_id, 'completed');
      recovered.push(this.mapJob(row));
    }

    return recovered;
  }

  listQueuedJobs(): OrderJob[] {
    return (this.db.prepare(`
      SELECT *
      FROM jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
    `).all() as unknown as JobRow[]).map((row) => this.mapJob(row));
  }

  private mapDraft(row: DraftRow): DraftOrder {
    return {
      id: row.id,
      chatId: row.chat_id,
      senderId: row.sender_id,
      sourceType: row.source_type,
      rawInput: row.raw_input,
      transcription: row.transcription ?? undefined,
      parsedItems: this.parseItems(row.parsed_items_json),
      resolvedItems: row.resolved_items_json
        ? (JSON.parse(row.resolved_items_json) as ResolvedDraftItem[])
        : undefined,
      deliveryAddressId: row.delivery_address_id ?? undefined,
      deliveryAddressLabel: row.delivery_address_label ?? undefined,
      subtotalPaise: row.subtotal_paise ?? undefined,
      status: row.status,
      sourceMessageId: row.source_message_id ?? undefined,
      confirmationMessageId: row.confirmation_message_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapJob(row: JobRow): OrderJob {
    return {
      id: row.id,
      draftOrderId: row.draft_order_id,
      chatId: row.chat_id,
      senderId: row.sender_id,
      items: this.parseItems(row.items_json),
      resolvedItems: row.resolved_items_json
        ? (JSON.parse(row.resolved_items_json) as ResolvedDraftItem[])
        : undefined,
      deliveryAddressId: row.delivery_address_id ?? undefined,
      status: row.status,
      attemptCount: row.attempt_count,
      errorText: row.error_text ?? undefined,
      workerResult: row.worker_result_json
        ? (JSON.parse(row.worker_result_json) as OrderWorkerResult)
        : undefined,
      queuedMessageId: row.queued_message_id ?? undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
    };
  }

  mapEvent(row: EventRow): OrderEvent {
    return {
      id: row.id,
      chatId: row.chat_id,
      senderId: row.sender_id ?? undefined,
      draftOrderId: row.draft_order_id ?? undefined,
      jobId: row.job_id ?? undefined,
      direction: row.direction,
      eventType: row.event_type,
      messageId: row.message_id ?? undefined,
      text: row.text ?? undefined,
      payload: row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : undefined,
      createdAt: row.created_at,
    };
  }

  private parseItems(json: string): ShoppingItem[] {
    const parsed = JSON.parse(json) as ShoppingItem[];
    return parsed.map((item) => ({
      query: item.query,
      quantity: item.quantity,
    }));
  }

  getFavorite(chatId: string, normalizedQuery: string): Favorite | undefined {
    const row = this.db.prepare(`
      SELECT chat_id, normalized_query, product_id, product_name, order_count, last_ordered_at
      FROM favorites
      WHERE chat_id = ? AND normalized_query = ?
      LIMIT 1
    `).get(chatId, normalizedQuery) as {
      chat_id: string;
      normalized_query: string;
      product_id: string;
      product_name: string;
      order_count: number;
      last_ordered_at: number;
    } | undefined;

    if (!row) {
      return undefined;
    }

    return {
      chatId: row.chat_id,
      normalizedQuery: row.normalized_query,
      productId: row.product_id,
      productName: row.product_name,
      orderCount: row.order_count,
      lastOrderedAt: row.last_ordered_at,
    };
  }

  upsertFavorite(input: {
    chatId: string;
    normalizedQuery: string;
    productId: string;
    productName: string;
  }): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO favorites (chat_id, normalized_query, product_id, product_name, order_count, last_ordered_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT (chat_id, normalized_query) DO UPDATE SET
        product_id = excluded.product_id,
        product_name = excluded.product_name,
        order_count = favorites.order_count + 1,
        last_ordered_at = excluded.last_ordered_at
    `).run(input.chatId, input.normalizedQuery, input.productId, input.productName, now);
  }

  deleteFavorite(chatId: string, normalizedQuery: string): void {
    this.db.prepare(`
      DELETE FROM favorites
      WHERE chat_id = ? AND normalized_query = ?
    `).run(chatId, normalizedQuery);
  }

  countFavorites(chatId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM favorites WHERE chat_id = ?
    `).get(chatId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  listAliases(chatId: string): Array<{ aliasTerm: string; canonicalQuery: string }> {
    const rows = this.db.prepare(`
      SELECT alias_term, canonical_query
      FROM aliases
      WHERE chat_id = ?
      ORDER BY alias_term ASC
    `).all(chatId) as Array<{ alias_term: string; canonical_query: string }>;
    return rows.map((r) => ({ aliasTerm: r.alias_term, canonicalQuery: r.canonical_query }));
  }

  upsertAlias(chatId: string, aliasTerm: string, canonicalQuery: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO aliases (chat_id, alias_term, canonical_query, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (chat_id, alias_term) DO UPDATE SET
        canonical_query = excluded.canonical_query
    `).run(chatId, aliasTerm.toLowerCase(), canonicalQuery, now);
  }

  deleteAlias(chatId: string, aliasTerm: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM aliases WHERE chat_id = ? AND alias_term = ?
    `).run(chatId, aliasTerm.toLowerCase());
    return Number(result.changes) > 0;
  }

  addPendingItem(input: {
    chatId: string;
    senderId: string;
    messageId?: string;
    sourceType: PendingItemSource;
    rawInput: string;
    transcription?: string;
  }): PendingItem {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO pending_items (chat_id, sender_id, message_id, source_type, raw_input, transcription, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.chatId,
      input.senderId,
      input.messageId ?? null,
      input.sourceType,
      input.rawInput,
      input.transcription ?? null,
      now,
    );

    return {
      id: Number(result.lastInsertRowid),
      chatId: input.chatId,
      senderId: input.senderId,
      messageId: input.messageId,
      sourceType: input.sourceType,
      rawInput: input.rawInput,
      transcription: input.transcription,
      createdAt: now,
    };
  }

  getPendingItems(chatId: string): PendingItem[] {
    const rows = this.db.prepare(`
      SELECT id, chat_id, sender_id, message_id, source_type, raw_input, transcription, created_at
      FROM pending_items
      WHERE chat_id = ?
      ORDER BY created_at ASC
    `).all(chatId) as Array<{
      id: number;
      chat_id: string;
      sender_id: string;
      message_id: string | null;
      source_type: PendingItemSource;
      raw_input: string;
      transcription: string | null;
      created_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      senderId: row.sender_id,
      messageId: row.message_id ?? undefined,
      sourceType: row.source_type,
      rawInput: row.raw_input,
      transcription: row.transcription ?? undefined,
      createdAt: row.created_at,
    }));
  }

  // Voice notes accumulate from any allowlisted sender (high-signal — speaker
  // explicitly recorded an order). Plain text only counts when sent by the
  // person typing `order`, within textWindowMs, capped at textLimit. This
  // stops chatter from other group members polluting the Gemini parse blob.
  getPendingForCompile(
    chatId: string,
    typerSenderId: string,
    textWindowMs: number,
    textLimit: number,
  ): PendingItem[] {
    type Row = {
      id: number;
      chat_id: string;
      sender_id: string;
      message_id: string | null;
      source_type: PendingItemSource;
      raw_input: string;
      transcription: string | null;
      created_at: number;
    };

    const voiceRows = this.db.prepare(`
      SELECT id, chat_id, sender_id, message_id, source_type, raw_input, transcription, created_at
      FROM pending_items
      WHERE chat_id = ? AND source_type = 'voice'
      ORDER BY created_at ASC
    `).all(chatId) as Row[];

    const textCutoff = Date.now() - textWindowMs;
    const textRows = this.db.prepare(`
      SELECT id, chat_id, sender_id, message_id, source_type, raw_input, transcription, created_at
      FROM pending_items
      WHERE chat_id = ? AND sender_id = ? AND source_type = 'text' AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(chatId, typerSenderId, textCutoff, textLimit) as Row[];

    const merged = [...voiceRows, ...textRows].sort((a, b) => a.created_at - b.created_at);

    return merged.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      senderId: row.sender_id,
      messageId: row.message_id ?? undefined,
      sourceType: row.source_type,
      rawInput: row.raw_input,
      transcription: row.transcription ?? undefined,
      createdAt: row.created_at,
    }));
  }

  countPendingItems(chatId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM pending_items WHERE chat_id = ?
    `).get(chatId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  clearPendingItems(chatId: string): number {
    const result = this.db.prepare(`
      DELETE FROM pending_items WHERE chat_id = ?
    `).run(chatId);
    return Number(result.changes);
  }

  deleteStalePendingItems(chatId: string, maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db.prepare(`
      DELETE FROM pending_items WHERE chat_id = ? AND created_at < ?
    `).run(chatId, cutoff);
    return Number(result.changes);
  }

  getMcpAuth(): McpAuthRecord | undefined {
    const row = this.db.prepare(`
      SELECT state, last_updated FROM mcp_auth WHERE id = 1
    `).get() as { state: McpAuthState; last_updated: number } | undefined;

    if (!row) {
      return undefined;
    }

    return {
      state: row.state,
      lastUpdated: row.last_updated,
    };
  }

  setMcpAuth(state: McpAuthState): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO mcp_auth (id, state, last_updated)
      VALUES (1, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        state = excluded.state,
        last_updated = excluded.last_updated
    `).run(state, now);
  }

  getMcpToken(): { accessToken: string; expiresAt: number; scope?: string } | undefined {
    const row = this.db.prepare(`
      SELECT access_token, expires_at, scope FROM mcp_tokens WHERE id = 1
    `).get() as { access_token: string; expires_at: number; scope: string | null } | undefined;

    if (!row) return undefined;
    return {
      accessToken: row.access_token,
      expiresAt: row.expires_at,
      scope: row.scope ?? undefined,
    };
  }

  saveMcpToken(input: { accessToken: string; expiresAt: number; scope?: string }): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO mcp_tokens (id, access_token, expires_at, scope, created_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        access_token = excluded.access_token,
        expires_at = excluded.expires_at,
        scope = excluded.scope,
        created_at = excluded.created_at
    `).run(input.accessToken, input.expiresAt, input.scope ?? null, now);
  }

  clearMcpToken(): void {
    this.db.prepare(`DELETE FROM mcp_tokens WHERE id = 1`).run();
  }

  saveMcpAuthFlow(input: { state: string; codeVerifier: string; clientId: string }): void {
    const now = Date.now();
    this.db.prepare(`
      DELETE FROM mcp_auth_flow WHERE created_at < ?
    `).run(now - 15 * 60_000);

    this.db.prepare(`
      INSERT INTO mcp_auth_flow (state, code_verifier, client_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.state, input.codeVerifier, input.clientId, now);
  }

  getMcpAuthFlow(state: string): { codeVerifier: string; clientId: string } | undefined {
    const row = this.db.prepare(`
      SELECT code_verifier, client_id FROM mcp_auth_flow WHERE state = ?
    `).get(state) as { code_verifier: string; client_id: string } | undefined;

    if (!row) return undefined;
    return { codeVerifier: row.code_verifier, clientId: row.client_id };
  }

  deleteMcpAuthFlow(state: string): void {
    this.db.prepare(`DELETE FROM mcp_auth_flow WHERE state = ?`).run(state);
  }

  getLastCompletedJobAt(chatId?: string): number | undefined {
    const row = chatId
      ? this.db.prepare(`
          SELECT finished_at FROM jobs
          WHERE status = 'completed' AND chat_id = ?
          ORDER BY finished_at DESC LIMIT 1
        `).get(chatId) as { finished_at: number | null } | undefined
      : this.db.prepare(`
          SELECT finished_at FROM jobs
          WHERE status = 'completed'
          ORDER BY finished_at DESC LIMIT 1
        `).get() as { finished_at: number | null } | undefined;

    return row?.finished_at ?? undefined;
  }
}

export function normalizeFavoriteQuery(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

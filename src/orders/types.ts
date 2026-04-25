import type { ShoppingItem } from '../llm/gemini-client.js';

export type DraftStatus =
  | 'pending_confirmation'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'cancelled';

export type JobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type SourceType = 'text' | 'voice';

export interface TransportMessage {
  id: string;
  timestampMs: number;
  chatId: string;
  senderId: string;
  senderPhone: string;
  body: string;
  type: string;
  hasMedia: boolean;
  isVoiceNote: boolean;
  isGroup: boolean;
  fromMe: boolean;
  mimetype?: string;
  mediaUrl?: string;
  replyToMessageId?: string;
}

export interface DraftOrder {
  id: string;
  chatId: string;
  senderId: string;
  sourceType: SourceType;
  rawInput: string;
  transcription?: string;
  parsedItems: ShoppingItem[];
  resolvedItems?: ResolvedDraftItem[];
  deliveryAddressId?: string;
  deliveryAddressLabel?: string;
  subtotalPaise?: number;
  status: DraftStatus;
  sourceMessageId?: string;
  confirmationMessageId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface OrderJob {
  id: string;
  draftOrderId: string;
  chatId: string;
  senderId: string;
  items: ShoppingItem[];
  resolvedItems?: ResolvedDraftItem[];
  deliveryAddressId?: string;
  status: JobStatus;
  attemptCount: number;
  errorText?: string;
  workerResult?: OrderWorkerResult;
  queuedMessageId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface OrderEvent {
  id: number;
  chatId: string;
  senderId?: string;
  draftOrderId?: string;
  jobId?: string;
  direction: 'inbound' | 'outbound' | 'system';
  eventType: string;
  messageId?: string;
  text?: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}

export interface WorkerAddedItem {
  query: string;
  quantity: number;
  productName: string;
  productId: string;
}

export interface WorkerSkippedItem {
  query: string;
  quantity: number;
  reason: string;
}

export interface WorkerFailedItem {
  query: string;
  quantity: number;
  reason: string;
}

export interface OrderWorkerResult {
  success: boolean;
  searchCount: number;
  addedItems: WorkerAddedItem[];
  skippedItems: WorkerSkippedItem[];
  failedItems: WorkerFailedItem[];
  retryCount?: number;
  restartCount?: number;
  fatalError?: string;
}

export interface VoiceOrderDraftInput {
  rawInput: string;
  transcription: string;
  parsedItems: ShoppingItem[];
}

export interface Favorite {
  chatId: string;
  normalizedQuery: string;
  productId: string;
  productName: string;
  orderCount: number;
  lastOrderedAt: number;
}

export type PendingItemSource = 'voice' | 'text';

export interface PendingItem {
  id: number;
  chatId: string;
  senderId: string;
  messageId?: string;
  sourceType: PendingItemSource;
  rawInput: string;
  transcription?: string;
  createdAt: number;
}

export type McpAuthState = 'authenticated' | 'disconnected';

export interface McpAuthRecord {
  state: McpAuthState;
  lastUpdated: number;
}

export interface DeliveryAddress {
  id: string;
  label?: string;
  addressLine?: string;
  addressLine2?: string;
  locality?: string;
  city?: string;
  postalCode?: string;
  category?: string;
  receiverName?: string;
  receiverPhone?: string;
}

export interface ResolvedSkuOption {
  spinId: string;
  productName: string;
  brand?: string;
  packSize?: string;
  priceOfferPaise?: number;
  priceMrpPaise?: number;
  imageUrl?: string;
  inStock: boolean;
}

export interface ResolvedDraftItem {
  query: string;
  quantity: number;
  normalizedQuery: string;
  fromFavorite: boolean;
  selectedIndex: number;
  options: ResolvedSkuOption[];
  note?: string;
}

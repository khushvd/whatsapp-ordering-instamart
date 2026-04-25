import type { ShoppingItem } from '../llm/gemini-client.js';
import { McpAuthError } from '../mcp/swiggy-oauth.js';
import type { SwiggyMcpClient } from '../mcp/swiggy-client.js';
import { normalizeFavoriteQuery } from './order-store.js';
import type { OrderStore } from './order-store.js';
import type {
  DeliveryAddress,
  OrderWorkerResult,
  ResolvedDraftItem,
  ResolvedSkuOption,
  WorkerAddedItem,
  WorkerFailedItem,
} from './types.js';

const MAX_OPTIONS_PER_ITEM = 5;
// Stage-1 token-overlap threshold for SKU auto-select. Below this we ask
// Gemini (Stage 2). Tuned conservatively — "Tomato" vs "Tomato Hybrid 1kg"
// scores ~0.5, "Tomato" vs "Brinjal Long" scores 0.
const SKU_MATCH_THRESHOLD = 0.5;

export type SkuVerifier = (query: string, productName: string) => Promise<boolean>;

export interface SwiggyOrderWorkerInterface {
  listAddresses(): Promise<DeliveryAddress[]>;
  resolveItems(
    chatId: string,
    items: ShoppingItem[],
    addressId: string,
    verifier?: SkuVerifier,
  ): Promise<ResolvedDraftItem[]>;
  searchAlternatives(addressId: string, query: string): Promise<ResolvedSkuOption[]>;
  placeResolvedOrder(
    chatId: string,
    addressId: string,
    items: ResolvedDraftItem[],
  ): Promise<OrderWorkerResult>;
  close(): Promise<void>;
}

export class SwiggyOrderWorker implements SwiggyOrderWorkerInterface {
  constructor(
    private readonly store: OrderStore,
    private readonly mcp: SwiggyMcpClient,
  ) {}

  async listAddresses(): Promise<DeliveryAddress[]> {
    const raw = await this.mcp.callTool('get_addresses', {});
    const parsed = unwrapToolResult(raw);
    return pickAddressList(parsed);
  }

  async resolveItems(
    chatId: string,
    items: ShoppingItem[],
    addressId: string,
    verifier?: SkuVerifier,
  ): Promise<ResolvedDraftItem[]> {
    const resolved: ResolvedDraftItem[] = [];

    for (const item of items) {
      const normalizedQuery = normalizeFavoriteQuery(item.query);
      const favorite = this.store.getFavorite(chatId, normalizedQuery);

      let searchOptions: ResolvedSkuOption[] = [];
      let searchError: string | undefined;

      try {
        searchOptions = await this.searchAlternatives(addressId, item.query);
      } catch (error) {
        if (error instanceof McpAuthError) throw error;
        searchError = formatError(error);
      }

      if (favorite) {
        const favIdx = searchOptions.findIndex((o) => o.spinId === favorite.productId);
        if (favIdx >= 0) {
          const favOption = searchOptions.splice(favIdx, 1)[0]!;
          searchOptions.unshift(favOption);
        } else {
          searchOptions.unshift({
            spinId: favorite.productId,
            productName: favorite.productName,
            inStock: true,
          });
        }

        resolved.push({
          query: item.query,
          quantity: item.quantity,
          normalizedQuery,
          fromFavorite: true,
          selectedIndex: 0,
          options: searchOptions.slice(0, MAX_OPTIONS_PER_ITEM),
          note: searchError ? `Favorite reused; search failed: ${searchError}` : undefined,
        });
        continue;
      }

      if (searchOptions.length === 0) {
        resolved.push({
          query: item.query,
          quantity: item.quantity,
          normalizedQuery,
          fromFavorite: false,
          selectedIndex: -1,
          options: [],
          note: searchError ?? 'No Swiggy product matched this search.',
        });
        continue;
      }

      // Two-stage match check on the top-ranked option:
      //   Stage 1 — token-overlap similarity. Most queries match obviously.
      //   Stage 2 — Gemini fuzzy verify on borderline cases. Catches the
      //   "tomato → brinjal" class of Swiggy-search mismatches.
      const top = searchOptions[0]!;
      const overlap = tokenOverlap(item.query, top.productName);
      let confident = overlap >= SKU_MATCH_THRESHOLD;
      if (!confident && verifier) {
        confident = await verifier(item.query, top.productName);
      }

      const trimmedOptions = searchOptions.slice(0, MAX_OPTIONS_PER_ITEM);
      resolved.push({
        query: item.query,
        quantity: item.quantity,
        normalizedQuery,
        fromFavorite: false,
        selectedIndex: confident ? 0 : -1,
        options: trimmedOptions,
        note: confident
          ? undefined
          : `Couldn't confidently match "${item.query}" — top result was "${top.productName}". Use !pick to choose.`,
      });
    }

    return resolved;
  }

  async searchAlternatives(addressId: string, query: string): Promise<ResolvedSkuOption[]> {
    const raw = await this.mcp.callTool('search_products', { addressId, query });
    const parsed = unwrapToolResult(raw);
    return pickVariants(parsed);
  }

  async placeResolvedOrder(
    chatId: string,
    addressId: string,
    items: ResolvedDraftItem[],
  ): Promise<OrderWorkerResult> {
    const failedItems: WorkerFailedItem[] = [];
    const cartItems: Array<{ spinId: string; quantity: number }> = [];
    const addedOnSuccess: Array<{ resolved: ResolvedDraftItem; option: ResolvedSkuOption }> = [];

    for (const resolved of items) {
      const option = selectOption(resolved);
      if (!option) {
        failedItems.push({
          query: resolved.query,
          quantity: resolved.quantity,
          reason: resolved.note ?? 'No Swiggy product resolved for this item.',
        });
        continue;
      }
      cartItems.push({ spinId: option.spinId, quantity: resolved.quantity });
      addedOnSuccess.push({ resolved, option });
    }

    if (cartItems.length === 0) {
      return {
        success: false,
        searchCount: 0,
        addedItems: [],
        skippedItems: [],
        failedItems,
        fatalError: 'No resolved items to place.',
      };
    }

    try {
      await this.updateCart(addressId, cartItems);
    } catch (error) {
      const reason = formatError(error);
      // Only invalidate favorites when the failure is plausibly SKU-class
      // (product gone / OOS / invalid SKU). Network blips, auth issues, and
      // generic 5xx should NOT wipe a SKU the user has reliably ordered.
      if (isSkuClassFailure(reason)) {
        this.invalidateFavorites(chatId, addedOnSuccess.map((a) => a.resolved));
      }
      return {
        success: false,
        searchCount: 0,
        addedItems: [],
        skippedItems: [],
        failedItems: [
          ...failedItems,
          ...addedOnSuccess.map(({ resolved }) => ({
            query: resolved.query,
            quantity: resolved.quantity,
            reason: `update_cart failed: ${reason}`,
          })),
        ],
        fatalError: `update_cart failed: ${reason}`,
      };
    }

    try {
      await this.checkout(addressId);
    } catch (error) {
      const reason = formatError(error);
      if (isSkuClassFailure(reason)) {
        this.invalidateFavorites(chatId, addedOnSuccess.map((a) => a.resolved));
      }
      return {
        success: false,
        searchCount: 0,
        addedItems: [],
        skippedItems: [],
        failedItems: [
          ...failedItems,
          ...addedOnSuccess.map(({ resolved }) => ({
            query: resolved.query,
            quantity: resolved.quantity,
            reason: `checkout failed: ${reason}`,
          })),
        ],
        fatalError: `checkout failed: ${reason}`,
      };
    }

    const addedItems: WorkerAddedItem[] = addedOnSuccess.map(({ resolved, option }) => {
      this.store.upsertFavorite({
        chatId,
        normalizedQuery: resolved.normalizedQuery,
        productId: option.spinId,
        productName: option.productName,
      });
      return {
        query: resolved.query,
        quantity: resolved.quantity,
        productName: option.productName,
        productId: option.spinId,
      };
    });

    return {
      success: failedItems.length === 0,
      searchCount: 0,
      addedItems,
      skippedItems: [],
      failedItems,
    };
  }

  async close(): Promise<void> {
    this.mcp.reset();
  }

  private async updateCart(
    selectedAddressId: string,
    items: Array<{ spinId: string; quantity: number }>,
  ): Promise<void> {
    const raw = await this.mcp.callTool('update_cart', { selectedAddressId, items });
    unwrapToolResult(raw);
  }

  private async checkout(addressId: string): Promise<void> {
    const raw = await this.mcp.callTool('checkout', { addressId });
    unwrapToolResult(raw);
  }

  private invalidateFavorites(chatId: string, resolved: ResolvedDraftItem[]) {
    for (const r of resolved) {
      if (r.fromFavorite) {
        this.store.deleteFavorite(chatId, r.normalizedQuery);
      }
    }
  }
}

function selectOption(resolved: ResolvedDraftItem): ResolvedSkuOption | undefined {
  if (resolved.selectedIndex < 0) return undefined;
  return resolved.options[resolved.selectedIndex];
}

function formatError(error: unknown): string {
  if (error instanceof McpAuthError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

// Word-set overlap (Jaccard) between query and product name.
// 0 = no shared words, 1 = identical word sets after normalization.
// Stop-words and pack-size noise are stripped so "Tomato" vs "Tomato Hybrid 1 kg"
// scores meaningfully > 0 instead of getting drowned out.
function tokenOverlap(query: string, productName: string): number {
  const a = wordSet(query);
  const b = wordSet(productName);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection += 1;
  }
  // Asymmetric: how much of the query is covered by the product name.
  // We care that the query's words appear in the SKU name, not the reverse.
  return intersection / a.size;
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'with',
  'kg', 'kgs', 'g', 'gm', 'gms', 'gram', 'grams',
  'l', 'ltr', 'ltrs', 'liter', 'liters', 'litre', 'litres', 'ml',
  'pcs', 'pc', 'piece', 'pieces', 'pack', 'pkt',
]);

function wordSet(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  return new Set(words);
}

// Conservative classifier — only invalidate favorites when the failure is
// plausibly the SKU itself. Network/auth/transient failures keep favorites
// intact so a single bad request doesn't wipe a reliable history.
function isSkuClassFailure(reason: string): boolean {
  return /sku.*not.*found|product.*not.*found|out.*of.*stock|invalid.*spin|invalid.*sku|item.*unavailable|product.*unavailable/i.test(reason);
}

function unwrapToolResult(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const wrapped = raw as {
    content?: Array<{ type?: string; text?: string } | undefined>;
    structuredContent?: unknown;
    isError?: boolean;
  };

  if (wrapped.isError) {
    const text = firstTextBlock(wrapped.content);
    throw new Error(text ?? 'MCP tool returned isError=true.');
  }

  if (wrapped.structuredContent !== undefined) {
    return wrapped.structuredContent;
  }

  const text = firstTextBlock(wrapped.content);
  if (typeof text === 'string') {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // fall through
      }
    }
    return { text };
  }

  return raw;
}

function firstTextBlock(
  content: Array<{ type?: string; text?: string } | undefined> | undefined,
): string | undefined {
  if (!content) return undefined;
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return undefined;
}

function pickAddressList(parsed: unknown): DeliveryAddress[] {
  const candidates = collectArrays(parsed, ['addresses', 'data', 'result', 'items']);
  for (const arr of candidates) {
    const mapped: DeliveryAddress[] = [];
    for (const a of arr) {
      if (!a || typeof a !== 'object') continue;
      const row = a as Record<string, unknown>;
      const id = firstString(row, ['id', 'addressId', 'address_id']);
      if (!id) continue;
      const entry: DeliveryAddress = { id };
      const label = firstString(row, ['addressTag', 'addressCategory', 'tag', 'label']);
      if (label) entry.label = label;
      const addressLine = firstString(row, ['addressLine', 'address_line_1', 'line1', 'flatNo']);
      if (addressLine) entry.addressLine = addressLine;
      const addressLine2 = firstString(row, ['addressLine2', 'address_line_2', 'line2']);
      if (addressLine2) entry.addressLine2 = addressLine2;
      const locality = firstString(row, ['locality', 'area', 'landmark']);
      if (locality) entry.locality = locality;
      const city = firstString(row, ['city', 'cityName']);
      if (city) entry.city = city;
      const postalCode = firstString(row, ['postalCode', 'pincode', 'zip']);
      if (postalCode) entry.postalCode = postalCode;
      const category = firstString(row, ['addressCategory', 'category']);
      if (category) entry.category = category;
      const receiverName = firstString(row, ['receiverName', 'userName', 'contactName']);
      if (receiverName) entry.receiverName = receiverName;
      const receiverPhone = firstString(row, ['receiverPhone', 'userPhone', 'phone']);
      if (receiverPhone) entry.receiverPhone = receiverPhone;
      mapped.push(entry);
    }
    if (mapped.length) return mapped;
  }
  return [];
}

function pickVariants(parsed: unknown): ResolvedSkuOption[] {
  const out: ResolvedSkuOption[] = [];
  const productArrays = collectArrays(parsed, ['products', 'items', 'data', 'result', 'results']);

  for (const arr of productArrays) {
    for (const p of arr) {
      if (!p || typeof p !== 'object') continue;
      const row = p as Record<string, unknown>;
      if (isExplicitlyUnavailable(row)) continue;
      const parentName = firstString(row, ['productName', 'name', 'displayName']);
      const brand = firstString(row, ['brandName', 'brand']);

      const variantArrays = collectArrays(row, ['variations', 'variants', 'variantList']);
      let pushedVariant = false;
      for (const vArr of variantArrays) {
        for (const v of vArr) {
          if (!v || typeof v !== 'object') continue;
          const vr = v as Record<string, unknown>;
          const inStock = !isExplicitlyUnavailable(vr);
          const spinId = firstString(vr, ['spinId', 'spin_id', 'id']);
          if (!spinId) continue;
          pushedVariant = true;
          out.push(toOption(vr, spinId, parentName, brand, inStock));
        }
      }

      if (!pushedVariant) {
        const spinId = firstString(row, ['spinId', 'spin_id']);
        if (spinId) {
          out.push(toOption(row, spinId, parentName, brand, true));
        }
      }
    }
    if (out.length) break;
  }

  return out;
}

function toOption(
  row: Record<string, unknown>,
  spinId: string,
  parentName: string | undefined,
  brand: string | undefined,
  inStock: boolean,
): ResolvedSkuOption {
  const name =
    firstString(row, ['productName', 'name', 'displayName']) ?? parentName ?? spinId;
  const priceNode = row['price'];
  const priceObj =
    priceNode && typeof priceNode === 'object' ? (priceNode as Record<string, unknown>) : undefined;
  const offerRupees = firstNumber(priceObj ?? row, ['offerPrice', 'storePrice', 'offer_price']);
  const mrpRupees = firstNumber(priceObj ?? row, ['mrp', 'price']);
  return {
    spinId,
    productName: name,
    brand,
    packSize: firstString(row, ['quantityDescription', 'packSize', 'size', 'weight']),
    priceOfferPaise: offerRupees !== undefined ? Math.round(offerRupees * 100) : undefined,
    priceMrpPaise: mrpRupees !== undefined ? Math.round(mrpRupees * 100) : undefined,
    imageUrl: firstString(row, ['imageUrl', 'image', 'imageIds']),
    inStock,
  };
}

function isExplicitlyUnavailable(row: Record<string, unknown>): boolean {
  const keys = ['isInStockAndAvailable', 'inStock', 'isAvail', 'available'];
  for (const k of keys) {
    if (row[k] === false) return true;
  }
  return false;
}

function collectArrays(source: unknown, keys: string[]): unknown[][] {
  if (!source) return [];
  if (Array.isArray(source)) return [source];
  if (typeof source !== 'object') return [];
  const out: unknown[][] = [];
  const obj = source as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) {
      out.push(v);
    } else if (v && typeof v === 'object') {
      out.push(...collectArrays(v, keys));
    }
  }
  return out;
}

function firstString(
  row: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!row) return undefined;
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function firstNumber(
  row: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  if (!row) return undefined;
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

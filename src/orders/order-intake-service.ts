import type { ShoppingItem } from '../llm/gemini-client.js';
import { GeminiClient } from '../llm/gemini-client.js';
import { TranscriptionService } from '../audio/transcription-service.js';
import type { VoiceOrderDraftInput } from './types.js';

export class OrderIntakeService {
  private geminiClient: GeminiClient | null = null;
  private transcriptionService: TranscriptionService | null = null;

  constructor(private readonly resolveApiKey: () => string | undefined) {}

  resetClients(): void {
    this.geminiClient = null;
    this.transcriptionService = null;
  }

  async parseText(rawInput: string): Promise<ShoppingItem[]> {
    const items = await this.getGeminiClient().parseShoppingList(rawInput);
    return this.normalizeItems(items);
  }

  async parseVoice(buffer: Buffer, mimeType: string): Promise<VoiceOrderDraftInput> {
    const result = await this.getTranscriptionService().transcribeAndParse(buffer, mimeType);

    return {
      rawInput: result.transcription,
      transcription: result.transcription,
      parsedItems: this.normalizeItems(result.items),
    };
  }

  async transcribeVoice(buffer: Buffer, mimeType: string): Promise<string> {
    return this.getTranscriptionService().transcribeAudio(buffer, mimeType);
  }

  async matchAddress(query: string, addressDescriptions: string[]): Promise<number | null> {
    return this.getGeminiClient().matchAddress(query, addressDescriptions);
  }

  async verifySku(query: string, productName: string): Promise<boolean> {
    return this.getGeminiClient().verifySkuMatch(query, productName);
  }

  private requireApiKey(): string {
    const key = this.resolveApiKey();
    if (!key || key.trim().length === 0) {
      throw new Error('Gemini API key is not set. Open http://localhost:3000 to add one under Setup.');
    }
    return key.trim();
  }

  private getGeminiClient(): GeminiClient {
    if (!this.geminiClient) {
      this.geminiClient = new GeminiClient(this.requireApiKey());
    }

    return this.geminiClient;
  }

  private getTranscriptionService(): TranscriptionService {
    if (!this.transcriptionService) {
      this.transcriptionService = new TranscriptionService(this.requireApiKey());
    }

    return this.transcriptionService;
  }

  private normalizeItems(items: ShoppingItem[]): ShoppingItem[] {
    return items
      .map((item) => ({
        query: item.query?.trim() ?? '',
        quantity: Number.isFinite(item.quantity) && item.quantity > 0 ? Math.floor(item.quantity) : 1,
      }))
      .filter((item) => item.query.length > 0);
  }
}

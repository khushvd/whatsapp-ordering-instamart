/**
 * Audio Transcription Service
 * Uses Google Gemini for voice note transcription
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from 'fs';
import * as path from 'path';
import { GEMINI_MODEL } from "../llm/model-config.js";

export class TranscriptionService {
  private genAI: GoogleGenerativeAI;
  private model: any;

  constructor(apiKey?: string) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY is not set");
    }
    this.genAI = new GoogleGenerativeAI(key);
    this.model = this.genAI.getGenerativeModel({ model: GEMINI_MODEL });
  }

  /**
   * Transcribe audio from a Buffer
   * Supports common audio formats: ogg, mp3, wav, m4a, webm
   */
  async transcribeAudio(audioBuffer: Buffer, mimeType: string = 'audio/ogg'): Promise<string> {
    try {
      // Convert buffer to base64
      const base64Audio = audioBuffer.toString('base64');

      // Prepare the content with audio
      const result = await this.model.generateContent([
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Audio
          }
        },
        {
          text: `Transcribe this audio message. The speaker is likely ordering groceries or food items.
Return ONLY the transcribed text, nothing else. If you can't understand the audio, return "TRANSCRIPTION_FAILED".
Transcribe in the original language (likely Hindi or English).`
        }
      ]);

      const response = await result.response;
      const text = response.text().trim();

      if (text === "TRANSCRIPTION_FAILED" || !text) {
        throw new Error("Could not transcribe audio");
      }

      return text;
    } catch (e: any) {
      console.error("Transcription error:", e.message);
      throw new Error(`Transcription failed: ${e.message}`);
    }
  }

  /**
   * Transcribe audio from a file path
   */
  async transcribeFile(filePath: string): Promise<string> {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();

    // Map file extension to MIME type
    const mimeTypes: Record<string, string> = {
      '.ogg': 'audio/ogg',
      '.opus': 'audio/ogg',
      '.mp3': 'audio/mp3',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.webm': 'audio/webm',
      '.aac': 'audio/aac'
    };

    const mimeType = mimeTypes[ext] || 'audio/ogg';
    return this.transcribeAudio(buffer, mimeType);
  }

  /**
   * Transcribe and extract shopping list in one call
   * More efficient for voice shopping messages
   */
  async transcribeAndParse(audioBuffer: Buffer, mimeType: string = 'audio/ogg'): Promise<{
    transcription: string;
    items: { query: string; quantity: number }[];
  }> {
    try {
      const base64Audio = audioBuffer.toString('base64');

      const result = await this.model.generateContent([
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Audio
          }
        },
        {
          text: `This is a voice message for ordering groceries. Please:
1. Transcribe the audio
2. Extract shopping items with quantities

Return a JSON object with this exact structure:
{
  "transcription": "the transcribed text here",
  "items": [{"query": "product name", "quantity": 1}]
}

Rules:
- If no items found, return empty items array
- Default quantity is 1 if not specified
- Use specific product names suitable for searching (e.g., "Full Cream Milk" not just "milk")
- Return ONLY valid JSON, no markdown formatting`
        }
      ]);

      const response = await result.response;
      const text = response.text().trim();

      // Clean up potential markdown formatting
      const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();

      try {
        return JSON.parse(cleanText);
      } catch {
        // If JSON parse fails, return just transcription
        return {
          transcription: text,
          items: []
        };
      }
    } catch (e: any) {
      console.error("Transcribe and parse error:", e.message);
      throw new Error(`Voice processing failed: ${e.message}`);
    }
  }
}

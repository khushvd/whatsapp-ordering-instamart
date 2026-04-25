import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_MODEL } from "./model-config.js";

export interface ShoppingItem {
    query: string;
    quantity: number;
}

export class GeminiClient {
    private genAI: GoogleGenerativeAI;
    private model: any;

    constructor(apiKey: string) {
        if (!apiKey || apiKey.trim().length === 0) {
            throw new Error("Gemini API key is missing. Open the setup page at http://localhost:3000 to add one.");
        }
        this.genAI = new GoogleGenerativeAI(apiKey.trim());
        this.model = this.genAI.getGenerativeModel({ model: GEMINI_MODEL });
    }

    async ping(): Promise<void> {
        await this.model.generateContent('ping');
    }

    async matchAddress(query: string, addressDescriptions: string[]): Promise<number | null> {
        if (addressDescriptions.length === 0) return null;
        const numbered = addressDescriptions.map((desc, i) => `${i + 1}. ${desc}`).join('\n');
        const prompt = `Pick the saved delivery address that best matches the user's query.

User query: "${query}"

Addresses:
${numbered}

Rules:
- Return ONLY a raw JSON object: {"index": <1-based integer or null>}
- Only return an integer if you are confident the address matches the query (label, locality, city, or landmark).
- If no address is a clear match, return {"index": null}.
- Do not guess. Prefer null over a weak match.`;

        try {
            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanText) as { index?: number | null };
            const idx = parsed.index;
            if (typeof idx === 'number' && Number.isInteger(idx) && idx >= 1 && idx <= addressDescriptions.length) {
                return idx;
            }
            return null;
        } catch (e) {
            console.error("Error matching address with Gemini:", e);
            return null;
        }
    }

    async verifySkuMatch(query: string, productName: string): Promise<boolean> {
        const prompt = `Is "${productName}" a reasonable Swiggy Instamart match for the user's grocery query "${query}"?

Reply with ONLY one word: YES or NO. No punctuation, no explanation.

Examples:
- query="Tomato", product="Tomato Hybrid 1 kg" → YES
- query="Tomato", product="Brinjal Long 500g" → NO
- query="Milk", product="Amul Taaza Toned Milk 1 L" → YES
- query="Atta", product="Aashirvaad Whole Wheat Atta 5 kg" → YES
- query="Diet Coke", product="Coca-Cola Original 750 ml" → NO`;

        try {
            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const text = (response.text() ?? '').trim().toUpperCase();
            // Accept any answer that starts with YES; everything else is treated as NO.
            return text.startsWith('YES');
        } catch (e) {
            console.error("Gemini verifySkuMatch failed:", e);
            // Fail-open: on Gemini errors, don't block the order — let the
            // user see the SKU in the draft and decide via !pick.
            return true;
        }
    }

    async parseShoppingList(text: string): Promise<ShoppingItem[]> {
        const prompt = `Extract ONLY the grocery / household items that the user EXPLICITLY named as things to buy.

The input is a concatenation of voice-note transcripts and plain WhatsApp chat messages from a kitchen group. Most lines are NOT shopping requests — they are greetings, questions, status updates, confirmations, jokes, or unrelated chatter. Ignore all of that.

STRICT RULES:
- Return an empty array [] if the text contains no explicit item-to-buy. When in doubt, return [].
- Never invent, suggest, complete, or add items that are not in the text.
- Do not treat greetings ("hi", "namaste"), confirmations ("yes", "ok", "thik hai"), questions ("kya laana hai?"), opinions, meal descriptions, or gratitude as shopping items.
- Only include items when the user is naming a product to buy — typically as a bare item name, a list, or phrased as "bring X", "add X", "need X", "laana X", "mangwa lo X", etc.
- Output ONLY a raw JSON array. No markdown, no code fences, no commentary.
- Each object has keys "query" (clean English product name for search) and "quantity" (integer, default 1 if unspecified).
- Input may be English, Hindi, or Hinglish. Translate item names to clean English for Swiggy search.
- If a line mixes chatter and items (e.g. "good morning, 2 milk and bread"), extract only the items.

Positive examples:
Input: "diet coke"
Output: [{"query":"Diet Coke","quantity":1}]

Input: "do kilo tamatar aur ek bread"
Output: [{"query":"Tomato","quantity":2},{"query":"Bread","quantity":1}]

Input: "2 milk, bread, eggs"
Output: [{"query":"Milk","quantity":2},{"query":"Bread","quantity":1},{"query":"Eggs","quantity":1}]

Input: "good morning bhai\\ndal 1 kg, atta\\nkal ka khana accha tha"
Output: [{"query":"Dal","quantity":1},{"query":"Atta","quantity":1}]

Negative examples (return empty array):
Input: "good morning"
Output: []

Input: "thik hai bhai, kal baat karte hain"
Output: []

Input: "kya laana hai aaj?"
Output: []

Input: "ok"
Output: []

Now process this input:
"${text}"`;

        const callOnce = async (): Promise<ShoppingItem[]> => {
            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const raw = response.text();
            const cleanText = raw.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanText);
            if (!Array.isArray(parsed)) {
                throw new Error('Parser returned a non-array response.');
            }
            return parsed;
        };

        let items: ShoppingItem[];
        try {
            items = await callOnce();
        } catch (e) {
            console.error("Gemini parseShoppingList failed:", e);
            throw e instanceof Error ? e : new Error(String(e));
        }

        // Retry-on-empty once: most empty results from a non-empty input are
        // transient (safety blocks, model hiccups). The hardened prompt almost
        // never returns [] for real shopping text.
        if (items.length === 0 && text.trim().length > 0) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            try {
                items = await callOnce();
            } catch (e) {
                console.error("Gemini parseShoppingList retry failed:", e);
                throw e instanceof Error ? e : new Error(String(e));
            }
        }

        return items;
    }
}

export async function validateGeminiApiKey(
    apiKey: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
    const trimmed = apiKey?.trim() ?? '';
    if (trimmed.length === 0) {
        return { ok: false, reason: 'Key is empty. Paste the full key from Google AI Studio.' };
    }
    try {
        const client = new GeminiClient(trimmed);
        await client.ping();
        return { ok: true };
    } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // Map common failures to user-friendly copy.
        if (/api key not valid|API_KEY_INVALID|invalid api key/i.test(raw)) {
            return { ok: false, reason: "That key didn't work. Make sure you copied the full key from aistudio.google.com/apikey." };
        }
        if (/quota|rate|429/i.test(raw)) {
            return { ok: false, reason: 'Gemini rate limit hit while validating. Try again in a minute.' };
        }
        if (/fetch|ENOTFOUND|ECONN|network|timeout/i.test(raw)) {
            return { ok: false, reason: 'Could not reach Gemini — check your internet connection and try again.' };
        }
        return { ok: false, reason: `Validation failed: ${raw}` };
    }
}

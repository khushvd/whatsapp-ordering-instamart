// Single source of truth for the Gemini model used across the bot.
// Picked over gemini-2.5-flash via A/B (scripts/gemini-ab.py, Apr 2026):
// 3-flash-preview returns cleaner product names ("Paneer" not "500g Paneer"),
// translates "haldi" → "Turmeric", and matches Indian-English variants
// ("Ladyfinger" for bhindi). ~30% slower per call but parsing UX is async.
export const GEMINI_MODEL = 'gemini-3-flash-preview';

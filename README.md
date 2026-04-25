# WhatsApp Ordering — Swiggy Instamart

Order groceries from **Swiggy Instamart** by sending WhatsApp voice notes or plain text to your own household group. Your cook says *"dal, atta, 2 kg tomato"* — you reply `order` — the bot parses, resolves SKUs, shows a confirmation, and places the order on your Swiggy account.

Built for our household. Released so you can run your own.

---

## Privacy — everything stays on your laptop

**There is no server behind this.** No cloud. No telemetry. Nothing leaves your machine except:

- Requests you personally send to **Google Gemini** for voice transcription and list parsing, using **your** API key.
- Requests you personally send to **Swiggy's official MCP** to place your own order, using **your** Swiggy login.

Everything else — your WhatsApp session, your Gemini key, your Swiggy token, every draft, every favorite — is stored in plain files in the `data/` folder on your laptop. We have no server to send it to. **Delete the `data/` folder and it's all gone.**

Don't take our word for it — the code is open source. Read it.

---

## What you need

- **A laptop** (Mac, Windows, or Linux)
- **Node.js** and **Git** — both free, both one-time installs. Direct links in [Step 1](#step-1--install-nodejs--git-one-time) below.
- **A WhatsApp account** with a phone to scan a QR code.
- **A free Gemini API key** from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
- **A Swiggy account** with at least one saved delivery address.

No credit card. No signup. Nothing to install except Node.js and Git.

---

## Install & run (for normal humans)

### Step 1 — Install Node.js + Git (one time)

Click the direct links for your system and run both installers. Defaults are fine for everything.

| System | Node.js | Git |
|---|---|---|
| **macOS** (Intel or Apple Silicon) | [node-v22.14.0.pkg](https://nodejs.org/dist/v22.14.0/node-v22.14.0.pkg) | Pre-installed on most Macs. If not, when you run `git` for the first time in Terminal, macOS will pop up a one-click "Install Command Line Tools" prompt. |
| **Windows** (64-bit) | [node-v22.14.0-x64.msi](https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi) | [Git for Windows](https://git-scm.com/download/win) |
| **Linux** | [nodejs.org/en/download/package-manager](https://nodejs.org/en/download/package-manager) | `sudo apt install git` (Debian/Ubuntu) or your distro's equivalent |

(If a newer Node LTS exists, that works too — pick it from [nodejs.org](https://nodejs.org/).)

### Step 2 — Get the project (clone, don't download ZIP)

**Open a terminal first:**

| System | How |
|---|---|
| **macOS** | Press `⌘ + Space`, type `Terminal`, press Return |
| **Windows** | Open the Start menu, type `Git Bash`, press Enter (installed with Git in Step 1) |
| **Linux** | Press `Ctrl + Alt + T` |

Then paste these three commands one at a time (each runs on its own line):

```bash
cd ~/Desktop
```
```bash
git clone https://github.com/khushvd/whatsapp-ordering-instamart.git
```
```bash
cd whatsapp-ordering-instamart
```

You'll now have a `whatsapp-ordering-instamart` folder on your Desktop containing the project. Want it elsewhere? Replace `~/Desktop` with any folder path.

> **Why clone instead of "Download ZIP"?** macOS quarantines anything downloaded via browser and blocks the launcher with a "can't be verified" error that has no override on recent macOS. Files cloned via `git` skip this entirely. **Bonus:** you can update later with one command — `git pull` — instead of re-downloading.

### Step 3 — Double-click the launcher

Open the `whatsapp-ordering-instamart` folder in Finder/Explorer and double-click:

| Your system | File to double-click |
|---|---|
| **Mac** | `start.command` |
| **Windows** | `start.bat` |
| **Linux** | `start.sh` (run from a terminal: `./start.sh`) |

A terminal window will open, install dependencies + build the project on first run (takes 1–2 minutes), then start the bot. When it says `Server running at http://localhost:3000`, your default browser will open to the setup page.

**Keep that terminal window open** — closing it stops the bot. To stop the bot, close the window or press `Ctrl+C`.

### Step 4 — Finish setup in your browser

The browser page shows a 3-step setup overlay:

1. **Paste your Gemini API key.** The page links to [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Sign in with any Google account, click **Create API key**, copy it, paste it in the field, click **Save & validate**. The bot test-calls Gemini to make sure the key works before saving.
2. **Scan the WhatsApp QR.** Open WhatsApp on your phone → **Settings → Linked Devices → Link a Device** → scan the QR shown in the setup page. The step advances automatically when WhatsApp is connected.
3. **Connect Swiggy.** Click **Open Swiggy login**. A new browser tab opens to Swiggy. Sign in. Your browser will try to load a URL and say *"site can't be reached"* — **that is expected**. Copy the full URL from the address bar, paste it back in the setup page, click **Paste & finish**.

When all three pass, the setup overlay closes and you see the main dashboard.

### Step 5 — Pick your WhatsApp group + who can order

On the main dashboard, scroll to the **Allowlist** panel. Tick the household group you want the bot to listen to, and the phone numbers inside it who should be allowed to place orders (usually you, maybe your partner or cook). Click **Save**.

### Step 6 — Pin your delivery address

In your allowed WhatsApp group, type `!address`. The bot replies with your Swiggy saved addresses. Reply `!address 1` (or whichever number fits) to pin one. That's the address every order will go to until you change it.

**Setup done.** You can close the browser tab — as long as the terminal window stays open, the bot is running and listening to your group.

---

## Daily use

- **Cook sends a voice note** like *"do kilo tamatar, ek bread, 500 gram dal"* → bot silently transcribes and remembers it.
- **Cook sends plain text** like `dal, atta` → also silently added to the pending list.
- **You type `order`** → bot combines everything pending, resolves SKUs against Swiggy, and replies with the draft (items + prices + subtotal + delivery address).
- **You reply `yes`** (or `ya`, `ok`, `okay`, `confirm`, `go`, `place`, `y`) → order placed on Swiggy.

Prefer to skip the voice flow? Send `order: 2 kg tomato, bread, dal` in a single message.

### Commands

| You send | Bot does |
|---|---|
| voice note or plain text | Silent — added to pending (kept for 24h) |
| `order` | Compile pending into a draft with SKUs + prices |
| `order: <items>` | Draft from inline text; pending stays untouched |
| `yes` / `ya` / `ok` / `confirm` / `go` / `place` / `y` | Place the draft |
| `no` / `cancel` / `stop` / `abort` / `nope` | Cancel draft + clear pending |
| `edit: <items>` | Replace the draft (re-resolves against Swiggy) |
| `!pick <n>` | Show alternative SKUs for item `n` |
| `!pick <n> <m>` | Swap item `n` to alternative `m` |
| `!address` | List Swiggy saved addresses |
| `!address <n>` | Pin address by number |
| `!address <text>` | Fuzzy-match by description (10+ addresses) |
| `!address clear` | Unpin delivery address |
| `!status` | Queue / pending / Swiggy auth / pinned address / favorites |
| `!help` | Full command reference |

---

## Updating

In the project folder, run:

```bash
git pull
```

Then double-click the launcher again. It rebuilds automatically on first run after a pull.

---

## Troubleshooting

**Mac says `start.command` "cannot be verified" or "is from an unidentified developer".** This only happens if you downloaded the ZIP instead of cloning. Quick fix: in Terminal, run `xattr -cr ~/Desktop/whatsapp-ordering-instamart` (replace with the actual path). Better fix: delete the folder and follow [Step 2](#step-2--get-the-project-clone-dont-download-zip) properly with `git clone`.

**Windows SmartScreen warning.** Same root cause as above (downloaded ZIP). Click **More info** → **Run anyway** the first time, or re-clone via `git`.

**Swiggy orders suddenly stopped working.** Swiggy's access tokens expire every 5 days with no refresh. Click the **Setup** button (top-right of the dashboard) → Step 3 → reconnect Swiggy. Your Gemini key and WhatsApp session are untouched.

**Voice notes aren't getting parsed.** Type `!status` in the group. If Gemini auth is missing or failing, open **Setup** → Step 1 and re-enter the key.

**QR won't scan.** Close the terminal, double-click the launcher again. If that doesn't work, quit the bot, delete the `data/baileys-auth/` folder (this only clears the WhatsApp link — Gemini and Swiggy stay), and relaunch to get a fresh QR.

**I want to wipe everything and start over.** Quit the bot (close the terminal). Delete the `data/` folder in the project directory. Your Gemini key, Swiggy token, WhatsApp session, and order history live there — everything will be gone.

**Bot isn't responding to messages in my group.** Open the dashboard → check the **Allowlist** panel. Both the group AND the sender's phone number need to be ticked.

---

## For developers

<details>
<summary>Click to expand</summary>

### Stack
- **Transport:** [Baileys](https://github.com/WhiskeySockets/Baileys) — in-process WhatsApp Web lib, no external service
- **Language:** TypeScript, Node 22
- **AI:** Google Gemini 3 Flash (voice transcription + Hindi/Hinglish list parsing)
- **Ordering:** Swiggy Instamart MCP (`mcp.swiggy.com/im`) via OAuth PKCE
- **Storage:** SQLite (WAL mode) via Node's built-in `node:sqlite`

### Dev commands
```bash
npm install
npm run build          # tsc → dist/
npm run dev:bot        # tsx watch (hot reload)
npm run start:bot      # node dist/whatsapp-bot.js
```

### Environment variables

All optional for end users; see `.env.example`. `GEMINI_API_KEY` in `.env` is a dev-only fallback — the UI-set value in SQLite (`app_config.gemini_api_key`) takes precedence.

### Architecture

Three layers — `whatsapp-bot.ts` → `OrderOrchestrator` → `SwiggyOrderWorker`:

- **Transport (`src/whatsapp/baileys-client.ts`)** — Baileys socket, multi-file auth persistence at `data/baileys-auth/`, QR lifecycle, allowlist gating, dedupe via `order_events`.
- **Orchestrator (`src/orders/order-orchestrator.ts`)** — state machine. Voice + text accumulate silently into `pending_items`; `order` compiles them, parses via Gemini, resolves SKUs against Swiggy, shows a confirmation. `yes` queues the job; `drainQueue()` runs one job at a time.
- **Worker (`src/orders/swiggy-order-worker.ts`)** — Swiggy MCP client. `resolveItems()` consults a per-chat favorites cache before searching, runs a two-stage SKU-relevance check (token overlap + Gemini fallback) to catch silent mismatches. `placeResolvedOrder()` does a single wholesale `update_cart` then `checkout`.
- **Storage** — SQLite (WAL mode, `node:sqlite`): `draft_orders`, `jobs`, `order_events` (audit log + dedup), `favorites`, `pending_items`, `aliases`, `mcp_auth`/`mcp_tokens`/`mcp_auth_flow`, `app_config`, `user_prefs`.
- **AI (`src/llm/`)** — Gemini for transcription + list parsing + address fuzzy-match + SKU verification. Model ID centralised in `src/llm/model-config.ts`.
- **Recovery** — `orchestrator.recoverAndResume()` runs at startup: `processing` jobs are marked `failed` and the affected chat is notified. Pending items survive restarts.

### Docker (optional, for self-hosted)

Single-service compose example in `docker-compose.yml.example`. The `order_data` volume stores SQLite + `baileys-auth/`.

### Swiggy MCP quirks worth knowing

Fixed public `client_id: "swiggy-mcp"`, exact-match `redirect_uri` (no RFC 8252 port flexibility), 5-day access tokens with no refresh token. 13 MCP tools — full schemas in `scripts/mcp-tools.json`. Swiggy's manifest currently states "Third-party app development is not permitted at this time" — the fixed client_id may be rate-limited or revoked at any point.

### Contributing

This is a household project open-sourced and not an actively maintained product. PRs welcome but replies may be slow. Fork freely.

</details>

---

## License

MIT. See `LICENSE`.

## Credits

Built by [Khush](https://github.com/khushvd). Powered by [Baileys](https://github.com/WhiskeySockets/Baileys), [Google Gemini](https://ai.google.dev/), and [Swiggy's Instamart MCP](https://mcp.swiggy.com/im).

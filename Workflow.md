# Break Tracker Workflow

## System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    BREAK BOT SERVER (Standalone)                  │
│                    Port 3004 · PM2: break-bot-server             │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Telegram Webhook ──┤                                              │
│  @CSBreakMonitoring │                                              │
│  (port 3004)        ├──→ server.js ──→ break-bot.js ──→ Google    │
│                      │                    │           Sheets API   │
│  Dashboard API ─────┤                    │                        │
│  /api/breaks/       │                    ├──→ break-db.js         │
│  /api/break-tracker │                    │       (SQLite cache)    │
│                      │                    │                        │
│  Health /health ────┤                    ├──→ sync-worker.js      │
│                      │                    │   (5s sync to Sheet)   │
│  Webhook Setup ─────┤                    │                        │
│  /set-break-webhook  │                    ├──→ archive-worker.js   │
│                      │                    │   (midnight archive)   │
│  Caddy Proxy ───────┤                    │                        │
│  lionyy.shop/       │                    └──→ google.js           │
│                      │                        (Google auth & API) │
└──────────────────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────┐      ┌──────────────────────────┐
│     Google Sheet             │      │   SQLite Database         │
│  "CS-Break Tracker"          │◄────►│   data/break-bot.db      │
│  Sheet: CS BREAK             │      │   (local cache + sync)   │
│  Columns: A-O (15 cols)      │      └──────────────────────────┘
└──────────────────────────────┘
               ▲
               │
┌──────────────────────────────┐
│  Project2 Dashboard          │
│  Tab5 — CS Break Tracker     │
│  Reads /api/break-tracker    │
└──────────────────────────────┘
```

---

## Break Lifecycle Workflow

### 1. Start Break (`/start`)
```
Agent sends /start → Bot asks for break type → Agent selects type
    → Bot logs start time in SQLite + Google Sheet
    → Sends confirmation to group
    → Updates dashboard cache
```

**Break Types:**
| Type | Button Label | Purpose |
|------|-------------|---------|
| Soft Break | ☕ Soft Break | Short break (stretch, water, etc.) |
| Lunch Break | 🍽️ Lunch | Meal break |
| Dinner Break | 🌙 Dinner | Evening meal break |
| Toilet Break | 🚻 CR | Comfort room |
| Smoke Break | 🚬 Smoke | Smoking break |
| Emergency | 🆘 Emergency | Emergency situations |

### 2. End Break (`/end`)
```
Agent sends /end → Bot calculates duration → Logs end time
    → Sends breakdown to group:
      "✅ [Name] break ended
       🕒 Duration: 15m 30s
       ⏱ Total today: 1h 45m"
    → Check for overbreak violations
    → Updates dashboard cache
```

### 3. Break History (`/history`)
```
Agent sends /history → Bot reads today's records
    → Sends list of all breaks today with durations
```

### 4. Auto-Archive (Midnight)
```
archive-worker.js (runs every 15 min, checks for midnight crossover)
    → Detects shift boundary (12AM/12PM)
    → Archives completed day's data
    → Resets daily totals
```

### 5. Sync Worker (Every 5 seconds)
```
sync-worker.js (runs every 5 seconds)
    → Reads new breaks from SQLite
    → Writes to Google Sheet (CS BREAK!A:O)
    → Updates active-breaks.json
    → Maintains break-buffer.json
```

---

## Shift System

Two 12-hour shifts per day, following **Philippine Time (Asia/Manila, UTC+8):**

| Shift | Period | Business Date |
|-------|--------|---------------|
| **DAY** | 12:00 PM – 11:59 PM | Same calendar date |
| **NIGHT** | 12:00 AM – 11:59 AM | Previous calendar date |

- Shift boundary is calculated at **12:00 PM PH time**
- Business date determines which daily summary a break belongs to
- `getBusinessDate()` function handles the shift-to-date mapping

---

## Violation / Alert System

The bot monitors for overbreak violations:

| Rule | Threshold | Alert |
|------|-----------|-------|
| Long break | > 1 hour | ⚠️ Warning sent to group |
| Overbreak total | > 2 hours/day | 🚨 Violation recorded |

Violations are tracked in the break history and shown on the Tab5 dashboard.

---

## Google Sheet Structure

**Sheet:** CS-Break Tracker → Tab: `CS BREAK`

| Col | Header | Description |
|:---:|--------|-------------|
| A | ID | Unique break record ID |
| B | Agent Name | CS agent name |
| C | Date | Business date |
| D | Shift | DAY or NIGHT |
| E | Start Time | Break start (HH:MM AM/PM) |
| F | End Time | Break end (HH:MM AM/PM) |
| G | Duration (min) | Break duration in minutes |
| H | Duration (HMS) | Break duration formatted |
| I | Break Type | Type of break |
| J | Reason | Optional reason text |
| K | Status | Active / Completed / Archived |
| L | Day Period | Shift period label |
| M | Total Used | Running total used today |
| N | Break ID | Unique UUID for record |
| O | Synced At | Last sync timestamp |

---

## API Endpoints

| Method | Path | Description | Cache |
|--------|------|-------------|:-----:|
| POST | `/webhook-break` | Telegram bot webhook | ❌ |
| GET | `/api/breaks/dashboard` | Dashboard data (JSON) | ✅ 15s |
| GET | `/api/break-tracker` | Tab5 break tracker data | ✅ 15s |
| GET | `/set-break-webhook` | Set Telegram webhook URL | ❌ |
| GET | `/health` | Health check + timezone | ❌ |

---

## VPS Deployment

| Parameter | Current Value |
|-----------|:-------------:|
| Server | `164.132.45.47` (OVH VPS) |
| PM2 name | `break-bot-server` |
| Port | `3004` |
| Node.js | `>= 18.0.0` |
| Startup | `node src/server.js` |
| Proxy | Caddy (vps-faf8418b.vps.ovh.net → localhost:3004) |
| Git | `github.com/PJ-automate/break-bot-server` (branch: master) |

---

## Fresh Setup Guide (New PC / New Server)

Use this section when deploying the break bot on a brand new machine.

### Prerequisites
- **Node.js** v18 or higher
- **npm** (comes with Node.js)
- **Git**
- **PM2** (`npm install -g pm2`)
- **Caddy** (optional, for reverse proxy)

### Step 1: Clone the Repository
```bash
git clone https://github.com/PJ-automate/break-bot-server.git
cd break-bot-server
npm install
```

### Step 2: Configure Environment
```bash
# Create .env file (copy from template or use values below)
cat > .env << 'EOF'
BREAK_BOT_TOKEN=8712015323:AAGIobbwUZ2PDJ_xXeVG6XGawH8Eume_EMk
BREAK_SHEET_ID=1-ZRcIVmMwXzTjGri0eE0off4jWDhppV6Gs-k7_tRop8
BREAK_GROUP_ID=-1003716788529
BREAK_SERVICE_ACCOUNT_PATH=./break-bot-key.json
BREAK_SERVER_PORT=3004
BREAK_SERVER_HOST=0.0.0.0
EOF
```

### Step 3: Google Service Account Setup
1. Go to https://console.cloud.google.com/
2. Select or create a project
3. Go to **IAM & Admin → Service Accounts**
4. Create a service account (or use existing)
5. Generate a JSON key → download as `break-bot-key.json`
6. Place the key file in the project root (`break-bot-server/break-bot-key.json`)
7. Share the Google Sheet **"CS-Break Tracker"** with the service account email (Editor access)

### Step 4: Start the Server
```bash
# Test run
node src/server.js

# If working, start with PM2 (persistent)
pm2 start src/server.js --name break-bot-server
pm2 save
pm2 startup   # Follow the instructions to enable auto-start on boot
```

### Step 5: Configure Telegram Webhook
```bash
# If using Caddy proxy:
curl "http://localhost:3004/set-break-webhook?url=https://YOUR-DOMAIN/webhook-break"

# Or direct (no proxy):
curl "http://localhost:3004/set-break-webhook?url=https://YOUR-SERVER-IP:3004/webhook-break"
```

### Step 6: (Optional) Caddy Reverse Proxy
If you want a custom domain instead of IP:port:

**Caddyfile:**
```
your-domain.com {
    handle /webhook-break* {
        reverse_proxy localhost:3004
    }
    handle /api/break-tracker* {
        reverse_proxy localhost:3004
    }
    handle /api/breaks/dashboard* {
        reverse_proxy localhost:3004
    }
}
```

### Step 7: Integrate with Project2 Dashboard
In `Project2-Agent Activity Automate/src/dashboard_server.js`, update:

```javascript
var BREAK_API_URL = 'http://localhost:3004/api/breaks/dashboard';
```

The Tab5 HTML (`tab5-cs-break-tracker/index.html`) fetches from `/api/break-tracker`
which is proxied through the dashboard server using the URL above.

### Step 8: Verify Everything
```bash
# Check health
curl http://localhost:3004/health

# Check PM2
pm2 list
pm2 logs break-bot-server

# Test bot
# Send /help to @CSBreakMonitoring_bot in Telegram
```

---

## Data Flow Summary

```
Telegram Agent
    │
    ▼
webhook-break (POST)
    │
    ▼
handleBreakUpdate()
    ├── /start → startBreak() → SQLite insert → Sheet append
    ├── /end   → endBreak()   → SQLite update → Sheet update
    ├── /history → readBreakData() → formatHistory() → sendMsg()
    └── callback → handleCallbackQuery()
    │
    ▼
sync-worker.js (5s interval)
    SQLite → Google Sheet sync (bi-directional)
    │
    ▼
archive-worker.js (15min interval)
    Checks midnight boundary → archives completed shifts
```

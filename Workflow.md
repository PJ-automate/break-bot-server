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

| Parameter | Value |
|-----------|-------|
| Server | `164.132.45.47` (OVH VPS) |
| PM2 name | `break-bot-server` |
| Port | `3004` |
| Node.js | `>= 18.0.0` |
| Startup | `node src/server.js` |
| Proxy | Caddy (vps-faf8418b.vps.ovh.net → localhost:3004) |
| Git | `github.com/PJ-automate/break-bot-server` (branch: master) |

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

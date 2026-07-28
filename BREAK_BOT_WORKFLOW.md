# Break Bot Technical Documentation

> **Project:** break-bot-server  
> **Version:** 1.0.0  
> **Last Updated:** 2026-07-29  
> **Repository:** https://github.com/PJ-automate/break-bot-server  
> **Telegram Bot:** @CSBreakMonitoring_bot  

---

## 1. System Overview

### 1.1 Purpose

The Break Bot is a Telegram-based time-tracking system for customer service agents. It allows agents to log their breaks (start/end), tracks break duration and daily totals, detects overbreak violations, and syncs all data to Google Sheets for reporting and dashboard display. It serves as the data source for Project2's Tab5 — the CS Break Tracker dashboard.

### 1.2 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      BREAK BOT SERVER                           │
│                  Standalone Node.js + Express                   │
│                        Port 3004                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Telegram Webhook ──────┐                                        │
│  @CSBreakMonitoring_bot │                                        │
│  (POST /webhook-break)  ├──→ server.js ──→ break-bot.js         │
│                          │                    │                  │
│  Dashboard API ─────────┤                    ├──→ break-db.js    │
│  GET /api/breaks/       │                    │    (SQLite)       │
│  /api/break-tracker     │                    │                  │
│                          │                    ├──→ sync-worker.js│
│  Health Check ──────────┤                    │    (5s interval)  │
│  GET /health            │                    │                  │
│                          │                    ├──→ archive-      │
│  Webhook Setup ─────────┤                    │    worker.js      │
│  GET /set-break-webhook │                    │    (15min check)  │
│                          │                    │                  │
│                          │                    └──→ google.js     │
│                          │                         (Google API)  │
└──────────────────────────┴────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │       Google Sheets           │
                    │    "CS-Break Tracker"         │
                    │  Tabs: CS BREAK, ARCHIVES,    │
                    │  DAILY SUMMARY,               │
                    │  OVERBREAK_TRACKER            │
                    └───────────────────────────────┘
                                    ▲
                                    │
                    ┌───────────────────────────────┐
                    │   SQLite (data/break-bot.db)  │
                    │   Source of Truth             │
                    │   Tables: breaks,             │
                    │   sync_queue,                 │
                    │   daily_summary_cache,        │
                    │   settings                    │
                    └───────────────────────────────┘
```

### 1.3 Main Components

| Component | Role | Technology |
|-----------|------|------------|
| **Webhook Receiver** | Receives Telegram updates (commands + callbacks) | Express POST /webhook-break |
| **Command Handler** | Parses and executes bot commands (/start, /end, /history, /myid, /monitoring) | break-bot.js |
| **Callback Handler** | Processes inline keyboard button presses (break type selection, shift selection) | break-bot.js |
| **SQLite Database** | Source of truth — all break records stored locally first | better-sqlite3 |
| **Google Sheets Client** | Syncs data to Google Sheets asynchronously | googleapis |
| **Sync Worker** | Background process pushing SQLite → Google Sheets every 5 seconds | sync-worker.js |
| **Archive Worker** | Moves old data from CS BREAK → ARCHIVES at midnight | archive-worker.js |
| **Dashboard API** | Serves live break data to Project2 Tab5 | Express GET /api/break-tracker |

---

## 2. Project Structure

### 2.1 Root Directory

```
break-bot-server/
├── .env                          # Environment config (bot token, sheet ID, port)
├── .gitignore
├── Caddyfile                     # Reverse proxy config (Caddy → localhost:3004)
├── package.json                  # Dependencies and scripts
├── package-lock.json
├── break-bot-key.json            # Google Service Account key
├── Workflow.md                   # High-level workflow documentation
├── Skill.md                      # User-facing skill documentation
├── BREAK_BOT_WORKFLOW.md         # This file — technical documentation
├── data/
│   └── break-bot.db              # SQLite database (auto-created)
├── src/
│   ├── server.js                 # Express server entry point
│   ├── config.js                 # Configuration from .env
│   ├── break-bot.js              # Core bot logic (commands, callbacks, breaks)
│   ├── break-db.js               # SQLite database layer
│   ├── break-buffer.js           # Buffer/write-queue for sheet operations
│   ├── sync-worker.js            # Background sync worker (5s interval)
│   ├── archive-worker.js         # Background archive worker (15min interval)
│   └── google.js                 # Google Sheets API client
├── node_modules/
└── [utility scripts]             # See 2.3
```

### 2.2 Source Files — Detailed Purpose

| File | Purpose |
|------|---------|
| `src/server.js` | Express server entry point. Starts the webhook listener, dashboard API, and background workers. Initializes SQLite, imports existing sheet data on startup, and begins the sync + archive workers. |
| `src/config.js` | Loads `.env` configuration: bot token, sheet ID, group ID, service account path, server port/host, timezone. |
| `src/break-bot.js` | Core bot logic. Contains all command handlers (`/start`, `/end`, `/history`, `/myid`, `/monitoring`), callback query handlers (break type selection, shift selection), break lifecycle (startBreak, endBreak), dashboard data generation, daily summary updates, and the SILENT_USERS / ADMIN_IDS / STAFF_IDS access control. |
| `src/break-db.js` | SQLite database layer. Handles database initialization, table creation, CRUD operations for breaks, sync queue management, daily summary caching, and persistent key-value settings. |
| `src/break-buffer.js` | Write queue buffer for Google Sheets operations. Accumulates writes and flushes them in batches to reduce API calls. Used internally by sync-worker. |
| `src/sync-worker.js` | Background worker that processes the sync queue every 5 seconds. Reads pending syncs from SQLite, pushes start/end break data to Google Sheets, updates daily summaries, tracks overbreak violations, and reverse-syncs (reconciles) breaks ended via Google Sheets directly. |
| `src/archive-worker.js` | Background worker that moves old break data from CS BREAK → ARCHIVES sheet. Runs on a 15-minute interval, triggers at midnight PH time (12:00 AM / 12:00 PM). Also auto-closes stale breaks, reconciles active breaks, and checks for old data outside the midnight window. |
| `src/google.js` | Google Sheets API client. Handles authentication (service account), read/write operations with retry logic, quota management, concurrency limiting, formatting, and sheet creation. All Google API calls pass through this module. |

### 2.3 Utility Scripts

| Script | Purpose |
|--------|---------|
| `check-db-stats.js` | Print SQLite database statistics |
| `check-pending.js` | Check for pending/unclosed breaks |
| `check-sheet.js` | Verify Google Sheet data integrity |
| `cleanup-db.js` | Clean old/failed records from DB |
| `fix-all-sheet.js` | Fix and repair sheet data |
| `fix-pijie.js` | Fix specific agent's break records |
| `fix-sheet.js` / `fix-sheet-2.js` | General sheet corruption repair |
| `import-sheet.js` | Import sheet data into SQLite |
| `populate-active-breaks.js` | Rebuild active breaks from database |
| `rebuild-breaks.js` | Rebuild break records from sheet data |
| `rebuild-daily-summary.js` | Rebuild daily summary from break data |
| `deploy-server-v2.js` | VPS deployment script |
| `dashboard_server.js` | Legacy dashboard server (for Project2 Tab5) |

---

## 3. Workflow

### 3.1 Complete Break Lifecycle

```
Agent Command     →   SQLite (instant)  →   Sync Queue     →   Google Sheet (~5s later)
                                                                       │
                                                                  ┌─────┴─────┐
                                                                  │           │
                                                              On End      On Start
                                                                  │           │
                                                            Update Row   Append Row
                                                                  │
                                                            ┌─────┴─────┐
                                                            │           │
                                                       Violation?   Normal
                                                           │          │
                                                    OVERBREAK     🟢 RETURNED
                                                    TRACKER
                                                                       │
                                                              ┌────────┴────────┐
                                                              │                 │
                                                         DAILY SUMMARY     ARCHIVE (midnight)
                                                                  │         (moves old rows)
                                                              Tab5 Dashboard
                                                              (polled via API)
```

### 3.2 Step-by-Step: Starting a Break

| Step | Component | Action | Function | File |
|:----:|-----------|--------|----------|------|
| 1 | Telegram | Agent sends `/start` or taps inline button | POST /webhook-break | server.js |
| 2 | server.js | Parses update, routes to break-bot.js | `handleBreakUpdate()` | server.js |
| 3 | break-bot.js | Checks for DM (ignored unless whitelisted) | `handleBreakUpdate()` | break-bot.js |
| 4 | break-bot.js | Routes to message or callback handler | `handleMessage()` / `handleCallback()` | break-bot.js |
| 5 | break-bot.js | Shows break type menu (Meal, Bio, Smoke, Relax, Snack, Prayer, Emergency) | `sendBreakTypeMenu()` | break-bot.js |
| 6 | Telegram | Agent selects break type via inline button | callback_data: `start_12h_DayShift_Meal` | — |
| 7 | break-bot.js | Validates no active break, determines shift/period/business date | `startBreak()` | break-bot.js |
| 8 | break-db.js | **Inserts break record into SQLite** (source of truth) | `db.startBreak()` | break-db.js |
| 9 | break-bot.js | Sends confirmation to monitoring group | `sendMsg(CONFIG.breakGroupId, ...)` | break-bot.js |
| 10 | break-bot.js | Sends personal confirmation DM | `sendMsg(chatId, ...)` | break-bot.js |
| 11 | break-db.js | Queues a "start" sync operation | `queueSync('start', ...)` | break-db.js |
| 12 | sync-worker.js | On next 5s tick, picks up pending sync | `processSyncQueue()` | sync-worker.js |
| 13 | sync-worker.js | Appends new row to CS BREAK sheet | `syncStartBreak()` → `breakAppendRow()` | sync-worker.js / google.js |
| 14 | break-db.js | Marks sync as completed | `markSyncDone()` | break-db.js |

### 3.3 Step-by-Step: Ending a Break

| Step | Component | Action | Function | File |
|:----:|-----------|--------|----------|------|
| 1 | Telegram | Agent sends `/end` | POST /webhook-break | server.js |
| 2 | break-bot.js | Routes to message handler | `handleMessage() → endBreak()` | break-bot.js |
| 3 | break-db.js | Finds active break, calculates duration | `db.endBreak(userId, timeStr)` | break-db.js |
| 4 | break-db.js | **Updates SQLite** with end time, duration, remark | `UPDATE breaks SET ...` | break-db.js |
| 5 | break-db.js | Checks violation: >1h = LONG BREAK, >2h total = OVERBREAK | `endBreak()` | break-db.js |
| 6 | break-db.js | Queues an "end" sync operation | `queueSync('end', ...)` | break-db.js |
| 7 | break-bot.js | Sends group notification with duration + remaining | `sendMsg(CONFIG.breakGroupId, ...)` | break-bot.js |
| 8 | break-bot.js | Sends personal confirmation DM | `sendMsg(chatId, ...)` | break-bot.js |
| 9 | sync-worker.js | On next 5s tick, picks up pending "end" sync | `processSyncQueue()` | sync-worker.js |
| 10 | sync-worker.js | Updates existing GS row with end time, duration, status | `syncEndBreak()` → `breakUpdateRange()` | sync-worker.js / google.js |
| 11 | sync-worker.js | Updates DAILY SUMMARY sheet | `updateDailySummary()` → fire-and-forget | sync-worker.js / break-bot.js |
| 12 | sync-worker.js | If violation, writes to OVERBREAK_TRACKER | `trackOverbreakViolation()` | sync-worker.js |
| 13 | break-db.js | Marks sync as completed | `markSyncDone()` | break-db.js |

### 3.4 Step-by-Step: Archive

| Step | Component | Action | Function | File |
|:----:|-----------|--------|----------|------|
| 1 | archive-worker.js | 15-min interval fires | `startArchiveWorker(900000)` | archive-worker.js |
| 2 | archive-worker.js | Checks PH time for midnight window (0:00-0:59) OR old data | `runArchive()` | archive-worker.js |
| 3 | archive-worker.js | Restores `lastArchivedDate` from SQLite | `db.getSetting('lastArchivedDate')` | archive-worker.js |
| 4 | archive-worker.js | Skips if already archived today | `if (lastArchivedDate === todayStr) return` | archive-worker.js |
| 5 | archive-worker.js | **Reads CS BREAK!A:O** from Google Sheets | `readRange(ssId, 'CS BREAK!A:O')` | google.js |
| 6 | archive-worker.js | Separates rows: date < today → archive, date >= today → keep | cell comparison | archive-worker.js |
| 7 | archive-worker.js | Appends old rows to ARCHIVES sheet | `breakAppendRow(ssId, 'Archives!A:O', rowsToMove)` | google.js |
| 8 | archive-worker.js | Rewrites CS BREAK with only today's rows | `breakUpdateRange(ssId, 'CS BREAK!A1:O...', rowsToKeep)` | google.js |
| 9 | archive-worker.js | Deletes excess rows from CS BREAK sheet grid | `batchUpdate({deleteDimension})` | archive-worker.js |
| 10 | archive-worker.js | Updates SQLite google_sheet_row references | recalculation loop | archive-worker.js |
| 11 | archive-worker.js | Sets lastArchivedDate = today (only AFTER all writes succeed) | `db.setSetting('lastArchivedDate', ...)` | archive-worker.js |
| 12 | archive-worker.js | Rebuilds daily_summary_cache | `rebuildDailySummaryCache()` | archive-worker.js |

### 3.5 Step-by-Step: Dashboard Data

| Step | Component | Action | Function | File |
|:----:|-----------|--------|----------|------|
| 1 | Project2 Tab5 | Polls `/api/break-tracker` | HTTP GET | dashboard_server.js |
| 2 | server.js | Checks cache (15s TTL), serves cached or generates fresh | `getDashboardData()` | server.js |
| 3 | break-bot.js | Reads from SQLite (instant, no network I/O) | `db.getAllActiveBreaks()` + `db.getTodayHistory()` | break-bot.js |
| 4 | break-bot.js | Filters out SILENT_USERS from results | `!isSilentUser(b.user_id)` | break-bot.js |
| 5 | break-bot.js | Returns JSON: onBreak[], dailySummary[], breakHistory[], violations[] | `getDashboardData()` | break-bot.js |
| 6 | server.js | Caches result for 15s | `dashboardCache` | server.js |

---

## 4. Data Flow Diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          DATA FLOW DIAGRAM                                 │
└────────────────────────────────────────────────────────────────────────────┘

TELEGRAM                           SQLITE                        GOOGLE SHEETS
─────────                          ──────                        ─────────────
                                     │
  /start ────────────────────────────┤
  /end   ────────────────────────────┤
  /history ──────────────────────────┤
  /myid ─────────────────────────────┤
  /monitoring ───────────────────────┤
                                     │
                                     ▼
                            ┌─────────────────┐
                            │   break-db.js    │
                            │   (SQLite)       │
                            │                  │
                            │ Tables:          │
                            │  - breaks        │◄── Source of Truth
                            │  - sync_queue    │
                            │  - daily_summary │
                            │    _cache        │
                            │  - settings      │
                            └────────┬─────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                    ▼                ▼                ▼
            ┌────────────┐   ┌────────────┐   ┌──────────────┐
            │  sync-     │   │  archive-  │   │  break-bot   │
            │  worker.js │   │  worker.js │   │  (dashboard) │
            │  (5s)      │   │  (15min)   │   │  (on demand) │
            └─────┬──────┘   └─────┬──────┘   └──────┬───────┘
                  │                │                  │
                  ▼                ▼                  │
          ┌───────────────┐  ┌────────────┐           │
          │   google.js   │  │  google.js │           │
          │   (writes)    │  │  (reads)   │           │
          └───────┬───────┘  └──────┬─────┘           │
                  │                 │                 │
                  ▼                 ▼                 ▼
          ┌───────────────────────────────────────────────┐
          │              Google Sheets                    │
          │  ┌─────────────┐  ┌─────────────┐             │
          │  │ CS BREAK    │  │ ARCHIVES    │             │
          │  │ (A:O, 15col)│  │ (old data)  │             │
          │  ├─────────────┤  └─────────────┘             │
          │  │ DAILY       │  ┌──────────────────┐        │
          │  │ SUMMARY     │  │ OVERBREAK_       │        │
          │  │ (A:E)       │  │ TRACKER (A:I)    │        │
          │  └─────────────┘  └──────────────────┘        │
          └───────────────────────────────────────────────┘
                              ▲
                              │
                    ┌─────────┴──────────┐
                    │                    │
                    ▼                    ▼
            ┌──────────────┐   ┌──────────────────┐
            │   Tab5       │   │  Telegram Group   │
            │   Dashboard  │   │  (notifications)  │
            └──────────────┘   └──────────────────┘


TIME FLOW:
──────────

Agent: /start
  0ms    ──→ SQLite INSERT (break record + sync_queue entry)
  500ms  ──→ Telegram: confirmation to group + DM
  5s     ──→ sync-worker: Google Sheets appendRow (CS BREAK)

Agent: /end
  0ms    ──→ SQLite UPDATE (end time, duration, remark)
  500ms  ──→ Telegram: summary to group + DM
  5s     ──→ sync-worker: Google Sheets updateRange (CS BREAK row)
  5s     ──→ sync-worker: Google Sheets appendRow (DAILY SUMMARY)
  5s     ──→ sync-worker: (if violation) Google Sheets appendRow (OVERBREAK_TRACKER)

Midnight (PH):
  15min  ──→ archive-worker: read CS BREAK!A:O
  15min  ──→ archive-worker: append old rows to ARCHIVES
  15min  ──→ archive-worker: rewrite CS BREAK with only today's rows
  15min  ──→ archive-worker: mark lastArchivedDate in SQLite
```

---

## 5. SQLite Database

### 5.1 Database File

**Path:** `data/break-bot.db`  
**Engine:** better-sqlite3 (v12.11.1)  
**WAL mode:** Enabled (`PRAGMA journal_mode = WAL`) for faster concurrent reads/writes

### 5.2 Tables

#### Table: `breaks`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Unique break record ID |
| `business_date` | TEXT NOT NULL | Business date (YYYY-MM-DD, PH timezone) |
| `user_name` | TEXT NOT NULL | Agent's Telegram display name |
| `shift_type` | TEXT DEFAULT '12h' | Shift type (always '12h') |
| `shift_period` | TEXT DEFAULT 'DayShift' | 'DayShift' (12PM-11:59PM) or 'NightShift' (12AM-11:59AM) |
| `break_type` | TEXT NOT NULL | Type: Meal, Bio, Smoke, Relax, Snack, Prayer, Emergency |
| `start_time` | TEXT NOT NULL | Start time (HH:MM:SS PH time) |
| `end_time` | TEXT DEFAULT '' | End time (HH:MM:SS PH time) |
| `duration_secs` | INTEGER DEFAULT 0 | Duration in seconds |
| `duration_hms` | TEXT DEFAULT '' | Duration formatted as HH:MM:SS |
| `remaining` | TEXT DEFAULT '' | Remaining break allowance (HH:MM:SS) |
| `remark` | TEXT DEFAULT '' | Violation flag: '' (normal), 'LONG BREAK', 'OVERBREAK' |
| `total_used_hms` | TEXT DEFAULT '' | Total break time used today (HH:MM:SS) |
| `user_id` | TEXT NOT NULL | Telegram user ID |
| `status` | TEXT DEFAULT 'ON BREAK' | 'ON BREAK' or 'ENDED' |
| `break_id` | TEXT | Human-readable break ID (format: CSB{YYMMDD}{TS}{RND}) |
| `sync_status` | TEXT DEFAULT 'pending' | 'pending' or 'synced' |
| `google_sheet_row` | INTEGER DEFAULT 0 | Row number in Google Sheet CS BREAK tab |
| `created_at` | TEXT DEFAULT datetime('now','localtime') | Record creation timestamp |

**Indexes:**
- `idx_breaks_user` ON (`user_id`, `status`)
- `idx_breaks_date` ON (`business_date`)
- `idx_breaks_sync` ON (`sync_status`)

**Purpose:** Source of truth for all break records. Every command writes to this table first. Google Sheets is updated asynchronously.

#### Table: `sync_queue`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Queue entry ID |
| `operation` | TEXT NOT NULL | 'start' or 'end' |
| `break_id` | INTEGER | FK to breaks.id |
| `payload` | TEXT | JSON payload with operation data |
| `retries` | INTEGER DEFAULT 0 | Number of retry attempts |
| `last_error` | TEXT | Last error message |
| `created_at` | TEXT DEFAULT datetime('now','localtime') | Creation timestamp |

**Purpose:** Queue of pending Google Sheet sync operations. The sync worker reads from this table and processes each entry.

**Indexes:**
- `idx_sync_created` ON (`created_at`)

#### Table: `daily_summary_cache`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Cache entry ID |
| `business_date` | TEXT NOT NULL | Business date |
| `user_name` | TEXT NOT NULL | Agent name |
| `shift_key` | TEXT NOT NULL | Shift type + period (e.g., "12h (DayShift)") |
| `sheet_row` | INTEGER NOT NULL DEFAULT 0 | Row in DAILY SUMMARY sheet |
| `total_used` | TEXT DEFAULT '' | Total break time used (HH:MM:SS) |
| `remaining` | TEXT DEFAULT '' | Remaining allowance (HH:MM:SS) |
| `updated_at` | TEXT DEFAULT datetime('now','localtime') | Last update timestamp |

**UNIQUE constraint:** (`business_date`, `user_name`, `shift_key`)

**Purpose:** Eliminates the need to read the DAILY SUMMARY sheet to find existing rows (which caused 40s timeouts from OVH France).

#### Table: `settings`

| Column | Type | Description |
|--------|------|-------------|
| `key` | TEXT PRIMARY KEY | Setting name |
| `value` | TEXT | Setting value |
| `updated_at` | TEXT DEFAULT datetime('now','localtime') | Last update timestamp |

**Purpose:** Persistent key-value store across PM2 restarts. Used to persist:
- `lastArchivedDate` — the last date the archive successfully completed

### 5.3 Source of Truth

**SQLite is the source of truth.** Google Sheets is a sync target, not the authoritative data store. The reasoning:

1. Every bot command writes to SQLite first (instant, <50ms)
2. Google Sheets writes are queued and processed asynchronously (~5s delay)
3. If a Google Sheets write fails, the sync_queue retains the entry for retry
4. On server restart, existing sheet data is imported into SQLite as a one-time migration
5. The dashboard reads from SQLite, not from Google Sheets

### 5.4 Table Relationships

```
breaks (1) ──────→ sync_queue (many)
    │                  │
    │                  └── Each break can have one or more sync_queue entries
    │                      (start + end operations)
    │
    ├── business_date + user_name + shift_key → daily_summary_cache
    │
    └── user_id → lookup index for active break queries

settings (standalone)
    └── Stores lastArchivedDate, used by archive-worker
```

---

## 6. Google Sheets

### 6.1 Spreadsheet

**ID:** `1-ZRcIVmMwXzTjGri0eE0off4jWDhppV6Gs-k7_tRop8`  
**Name:** "CS-Break Tracker"  
**Service Account:** break-bot-key.json (independent 60 req/min quota pool)

### 6.2 Tabs

#### Tab: `CS BREAK` (Active breaks)

| Property | Detail |
|----------|--------|
| **Purpose** | Current day's break records. Main operational sheet. |
| **Columns** | A:O (15 columns) — Date, User Name, Shift Type, Shift Period, Break Type, Start Time, End Time, Duration, Remaining, Remark, User ID, Total Used, Status, Break ID, Status Icon |
| **Append** | On every `/start` — `breakAppendRow()` → ~5s delay |
| **Update** | On every `/end` — `breakUpdateRange()` updates columns G, H, I, J, L, M, O → ~5s delay |
| **Read** | Archive worker reads `CS BREAK!A:O` at midnight. Dashboard reads from SQLite. |
| **Functions** | `syncStartBreak()`, `syncEndBreak()` in sync-worker.js |

#### Tab: `ARCHIVES` (Historical data)

| Property | Detail |
|----------|--------|
| **Purpose** | Old break data moved from CS BREAK after midnight. |
| **Columns** | A:O (same structure as CS BREAK) |
| **Append** | During archive: `breakAppendRow(ssId, "'Archives'!A:O", rowsToMove)` |
| **Read** | On archive (to determine next empty row) |
| **Functions** | `runArchive()` in archive-worker.js |

#### Tab: `DAILY SUMMARY` (Per-agent daily totals)

| Property | Detail |
|----------|--------|
| **Purpose** | Per-agent break time summary per day. Used by Tab5 dashboard. |
| **Columns** | A:E — Date, User Name, Shift, Total Used, Remaining |
| **Update** | After each `/end` sync completes (fire-and-forget via setTimeout) |
| **Append** | If no existing row found for that user/date/shift |
| **Functions** | `updateDailySummary()` in break-bot.js, triggered from sync-worker.js |

#### Tab: `OVERBREAK_TRACKER` (Violations)

| Property | Detail |
|----------|--------|
| **Purpose** | Tracks LONG BREAK and OVERBREAK violations. |
| **Columns** | A:I — Timestamp, User Name, User ID, Shift Type, Shift Period, Break Type (+violation), Time Range, Duration, Total Used |
| **Append** | When an ended break has remark 'LONG BREAK' or 'OVERBREAK' |
| **Functions** | `trackOverbreakViolation()` in sync-worker.js |

### 6.3 Read/Write Frequency Summary

| Operation | Frequency | Tab | Direction |
|-----------|-----------|:---:|:---------:|
| Append new break start | Every `/start` (~1-5/min) | CS BREAK | Write |
| Update break end | Every `/end` (~1-5/min) | CS BREAK | Write |
| Update daily summary | Every `/end` (~1-5/min) | DAILY SUMMARY | Write |
| Append overbreak violation | On violations (~rare) | OVERBREAK_TRACKER | Write |
| Reconcile active breaks | Every 60s | CS BREAK | Read |
| Archive old data | Midnight (~1/day) | CS BREAK + ARCHIVES | Read + Write |
| Startup import | On server restart | CS BREAK | Read |

### 6.4 API Quota Management

- **Independent service account** — separate 60 req/min quota from other projects
- **Concurrency limiting** — `acquireReadSlot()` limits concurrent reads to 5
- **Quota retry** — On 429/403 errors, exponential backoff: 2^attempt * 1000ms, max 5 retries
- **Write retry** — All write functions have 5 retries with exponential backoff
- **Timeout** — `GOOGLE_API_TIMEOUT = 180000ms` (3 min) for all readRange calls

---

## 7. Sync Worker

### 7.1 Overview

**File:** `src/sync-worker.js`  
**Interval:** Every **5 seconds** (`setInterval`)  
**Purpose:** Push pending break data from SQLite → Google Sheets asynchronously

### 7.2 Trigger Conditions

1. **Periodic tick** — The `startSyncWorker(5000)` function starts a 5-second interval
2. **Post-command trigger** — After every `/start` and `/end`, `syncWorker.processSyncQueue()` is called
3. **On server start** — Immediate call on worker initialization

### 7.3 Workflow

```
processSyncQueue() called
    │
    ├─ if (processing) return        ← Guard against concurrent runs
    │
    ├─ Read pending syncs from SQLite
    │   db.getPendingSyncs() → SELECT * FROM sync_queue
    │
    ├─ For each pending item:
    │   │
    │   ├─ operation === 'start' → syncStartBreak(item)
    │   │   ├─ breakAppendRow(SH, 'CS BREAK!A:O', rowData)
    │   │   └─ markSyncDone(id, breakId, newRow)
    │   │
    │   ├─ operation === 'end' → syncEndBreak(item)
    │   │   ├─ Find existing sheet row (from breaks.google_sheet_row)
    │   │   ├─ If no existing row: append complete break as new row (fallback)
    │   │   ├─ breakUpdateRange(SH, 'CS BREAK!G{row}:J{row}', [end, dur, rem, remark])
    │   │   ├─ breakUpdateRange(SH, 'CS BREAK!L{row}:M{row}', [total, status])
    │   │   ├─ breakUpdateRange(SH, 'CS BREAK!O{row}', [statusIcon])
    │   │   ├─ markSyncDone(id, breakId, row)
    │   │   └─ setTimeout → updateDailySummary() (fire-and-forget)
    │   │   └─ If remark is LONG BREAK/OVERBREAK → trackOverbreakViolation()
    │   │
    │   └─ On error:
    │       ├─ markSyncFailed(id, error.message)
    │       └─ If 'exceeds grid limits' → reset google_sheet_row = 0 for retry
    │
    └─ Reconcile (every 60s):
        reconcileActiveBreaks()
            ├─ Read CS BREAK!M:N from Google Sheets
            ├─ Compare with active breaks in SQLite
            └─ If sheet shows RETURNED but SQLite shows ON BREAK → update SQLite
```

### 7.4 Retry Logic

- **No explicit retry in sync-worker.js** — on failure, the entry is marked as failed and skipped
- The entry remains in `sync_queue` with `retries` count incremented
- On next interval cycle, failed entries are NOT automatically retried (they stay in the queue but the worker reads only unprocessed entries)
- Retry happens only when the break's `sync_status` is reset to `'pending'`

### 7.5 Error Handling

| Error | Handling |
|-------|----------|
| Google API timeout (30s for reconcile) | Caught, silently skipped — retries next 60s cycle |
| "exceeds grid limits" | Resets `google_sheet_row = 0` so next retry re-appends |
| Append/update failure | `markSyncFailed()` logs error, continues to next item |
| Individual sync failure | Does NOT block other syncs — each item is independent |

### 7.6 Timeouts

| Operation | Timeout | Defined In |
|-----------|:-------:|-----------|
| Reconcile read (`CS BREAK!M:N`) | 30s | sync-worker.js `withTimeout()` |
| Start break append | 120s | sync-worker.js `withTimeout()` |
| End break append (fallback) | 120s | sync-worker.js `withTimeout()` |
| End break update (G-J) | 120s | sync-worker.js `withTimeout()` |
| End break update (L-M) | 120s | sync-worker.js `withTimeout()` |
| Daily summary update | 60s | sync-worker.js `withTimeout()` |
| Daily summary append | 120s | sync-worker.js `withTimeout()` |

---

## 8. Archive Worker

### 8.1 Overview

**File:** `src/archive-worker.js`  
**Interval:** Every **15 minutes** (900,000ms)  
**Purpose:** Move completed day's data from CS BREAK → ARCHIVES sheet

### 8.2 Schedule

The archive worker checks two conditions on every 15-minute tick:

1. **Midnight window** — If PH time is between 00:00 and 00:59 (midnight), trigger archive
2. **Old data detection** — If `hasOldDataToArchive()` returns true (rows with date < today exist in CS BREAK), trigger archive even outside midnight window (handles PM2 restarts)

### 8.3 Workflow

```
runArchive()
    │
    ├─ Guard: if (running) return
    ├─ running = true
    │
    ├─ STEP 0: autoCloseStaleBreaks()
    │   └─ Close any breaks from previous business dates that are still ON BREAK
    │
    ├─ Restore lastArchivedDate from SQLite
    │
    ├─ Skip if lastArchivedDate === todayStr
    │
    ├─ STEP 1: Read CS BREAK!A:O from Google Sheets
    │   └─ withTimeout(readRange(ssId, 'CS BREAK!A:O'), 180000)
    │
    ├─ STEP 2: Classify rows
    │   ├─ rowsToMove: date < todayStr (old data)
    │   └─ rowsToKeep: date >= todayStr (current data)
    │
    ├─ STEP 3: Append to ARCHIVES
    │   ├─ breakAppendRow(ssId, "'Archives'!A:O", rowsToMove)
    │   └─ Fallback: ensureArchiveGrid() + breakUpdateRange()
    │
    ├─ STEP 4: Rewrite CS BREAK
    │   ├─ breakUpdateRange(ssId, "'CS BREAK'!A1:O{n}", rowsToKeep)
    │   └─ DeleteDimension batchUpdate to remove excess rows
    │
    ├─ STEP 5: Cleanup
    │   ├─ Recalculate google_sheet_row for breaks in SQLite
    │   ├─ cleanupAlternateArchives()
    │   ├─ cleanupDailySummary()
    │   ├─ cleanupArchives()
    │   └─ rebuildDailySummaryCache()
    │
    └─ Mark lastArchivedDate = todayStr (ONLY after all writes succeed)
        └─ running = false
```

### 8.4 Row Selection Logic

```javascript
for (var i = 1; i < data.length; i++) {
  var row = data[i];
  if (!row || row.every(cell => !cell && cell !== 0)) continue; // skip empty
  if (!row[0]) { rowsToMove.push(row); continue; } // no date = archive
  var rowDateStr = cellToDateStr(row[0]); // normalize to YYYY-MM-DD
  if (!rowDateStr) { rowsToKeep.push(row); continue; }
  if (rowDateStr < todayStr) { rowsToMove.push(row); }
  else { rowsToKeep.push(row); }
}
```

- Rows with **date < today** → moved to ARCHIVES
- Rows with **date >= today** → kept in CS BREAK
- Rows with **no date** → moved to ARCHIVES (considered error/incomplete)
- Rows with **unparseable date** → kept in CS BREAK

### 8.5 Why `CS BREAK!A:O` Is Read

The archive worker reads the FULL sheet (all 15 columns, all rows) because:

1. It needs all column data to reconstruct rows in ARCHIVES + CS BREAK
2. It splits rows into two sets (move/keep) which both need full data
3. There is no incremental archive tracking — the entire sheet is processed each time

This is the **single largest Google API call** in the system and the most prone to timeout.

### 8.6 How Archived Rows Are Removed

After the archive writes only the kept rows back to CS BREAK, it deletes the remaining excess rows:

```javascript
// Physical row deletion via Google Sheets API
gsheets2.spreadsheets.batchUpdate({
  spreadsheetId: ssId,
  requestBody: {
    requests: [{
      deleteDimension: {
        range: {
          sheetId: csSheet.properties.sheetId,
          dimension: 'ROWS',
          startIndex: rowsToKeep.length, // first row past kept data
          endIndex: totalRows             // up to grid row count
        }
      }
    }]
  }
});
```

If the deleteDimension call fails (permissions limitation), a fallback writes empty rows:
```javascript
breakUpdateRange(ssId, "'CS BREAK'!A2:O1000", Array(999).fill(['',...,'']));
```

### 8.7 How `lastArchivedDate` Works

- **Persisted in SQLite** settings table — survives PM2 restarts
- **Checked** at the start of every archive run
- **Set ONLY after all writes succeed** — if any write fails, `lastArchivedDate` is NOT updated
- **Purpose**: Prevents redundant archive runs on the same day
- **Special case**: `lastArchivedDate = todayStr` means "already archived today" → skip
- **On error**: `lastArchivedDate` remains as the previous day's value → next 15-min interval retries

### 8.8 Auto-Close Stale Breaks

Before archiving, the worker auto-closes any breaks that are still `ON BREAK` but belong to a previous business date:

```javascript
// For each active break:
// If business_date < today → auto-close with "Auto-closed" remark
// This ensures ended breaks get archived correctly
```

---

## 9. Error Handling

### 9.1 Network Failures

| Scenario | Handling | Location |
|----------|----------|----------|
| Google API unreachable | Timeout after 180s (google.js) or 30-120s (sync-worker.js withTimeout) | google.js, sync-worker.js |
| Connection reset | Caught by google.js retry loop (5 retries with backoff) | google.js |
| DNS resolution failure | Propagates as exception, caught by caller's try/catch | All callers |

### 9.2 Google API Failures

| Error | Handling | Location |
|-------|----------|----------|
| 429 Quota exceeded | Exponential backoff: 2^attempt * 1000ms, max 5 retries | google.js (all operations) |
| 403 Rate limit | Same as 429 — retry with backoff | google.js |
| 400 "exceeds grid limits" | Returns empty array (read) or resets google_sheet_row (sync) | google.js, sync-worker.js |
| 400 "Unable to parse range" | Returns empty array | google.js |
| Timeout (90s/180s) | Rejected via Promise.race + timeoutPromise | google.js readRange |

### 9.3 SQLite Failures

| Scenario | Handling | Location |
|----------|----------|----------|
| Database locked | WAL mode minimizes locking; better-sqlite3 is synchronous (no race conditions) | break-db.js |
| Write failure | better-sqlite3 throws synchronously; caught by caller | break-bot.js |
| Missing database file | Auto-created on initDB() | break-db.js |

### 9.4 Recovery Process

```
Startup Import Failure (readRange timeout):
    → Error is logged as non-fatal
    → Server continues with empty database
    → Data will sync as users interact with the bot
    → SQLite remains the source of truth

Sync Worker Failure (Google Sheets write timeout):
    → Entry remains in sync_queue with retries > 0
    → Next tick skips failed entries (only processes pending)
    → Manual recovery: reset sync_status = 'pending' via cleanup-db.js

Archive Failure (readRange timeout):
    → lastArchivedDate is NOT updated
    → Next 15-min interval retries the entire archive
    → Error is logged with "lastArchivedDate was NOT updated" message

Reconcile Failure (readRange timeout):
    → Silently skipped
    → Retries on next 60s reconcile cycle
```

### 9.5 Guard Against Concurrent Execution

Both workers use a `running` flag to prevent concurrent execution:

```javascript
// sync-worker.js
if (processing) return;
processing = true;
// ... work ...
processing = false;

// archive-worker.js
if (running) return;
running = true;
// ... work ...
running = false;  // set in finally block or on success/failure
```

---

## 10. Performance Analysis

### 10.1 Bottlenecks

| Bottleneck | Impact | Location |
|------------|--------|----------|
| **Google Sheets read latency** | `readRange('CS BREAK!A:O')` takes 90-180+ seconds from OVH France. Blocks archive and startup. | google.js, archive-worker.js, server.js |
| **Sync queue processing (serial)** | Each sync is processed one at a time. If a sync hangs (timeout), subsequent syncs in the same batch are delayed. | sync-worker.js |
| **Daily summary update (fire-and-forget via setTimeout)** | After end-break sync, the daily summary update fires via setTimeout (100ms delay). If it fails, there is no retry mechanism. | sync-worker.js |
| **Full sheet read for startup import** | Every server restart triggers a full `readRange('CS BREAK!A:O')`. If this times out, the server starts with an empty DB and relies on syncs to rebuild. | server.js |
| **No pagination for large sheets** | `Archives!A:A` reads ALL rows (potentially 15,000+). This is increasingly slow as the archives grow. | archive-worker.js |

### 10.2 Unnecessary Reads

| Read | Why It May Be Unnecessary | Location |
|------|--------------------------|----------|
| `CS BREAK!A:O` full sheet read at startup | Data already exists in SQLite (synced from previous sessions). Import is only needed for first-time migration. | server.js startup |
| `CS BREAK!A:O` full sheet read for archive | Only the date column (A) is needed to classify rows. The remaining 14 columns of all rows are fetched unnecessarily. | archive-worker.js |
| `DAILY SUMMARY!A:E` full read in `cleanupDailySummary()` | Reads the entire summary sheet to check for duplicates. Could be done incrementally. | archive-worker.js |
| `Archives!A:O` full read in `cleanupArchives()` | Reads all archive rows to check for duplicates. Increasingly slow as archives grow. | archive-worker.js |

### 10.3 Unnecessary Writes

| Write | Why It May Be Unnecessary | Location |
|-------|--------------------------|----------|
| Empty row fallback write | When deleteDimension fails, writes 999 empty rows as a fallback. This is an anti-pattern. | archive-worker.js |
| `breakUpdateRange('CS BREAK!O{row}')` | Updates a single status icon column in a separate API call. Could be combined with the L-M update. | sync-worker.js |
| Daily summary rewrite during archive `cleanupDailySummary()` | Re-reads and rewrites the entire summary sheet during each archive. | archive-worker.js |

### 10.4 Potential Optimizations

| Optimization | Expected Improvement | Complexity |
|-------------|---------------------|:----------:|
| Read only column A for archive classification, then fetch full rows for move set | Reduces archive read size by 93% (1 col vs 15 col) | Medium |
| Remove startup import (rely on SQLite as source of truth) | Eliminates ~90-180s startup delay | Low |
| Batch reconcile reads into a single API call | Reduces reconcile API calls | Low |
| Combine G-J + L-M + O updates into single `breakBatchUpdate` | Reduces 3 API calls → 1 per end-sync | Low |
| Paginate large sheet reads (Archives, DAILY SUMMARY) with limit/offset | Prevents slowdown as sheets grow | Medium |
| Add read cache for archive row counts | Eliminates redundant API calls for metadata | Low |

---

## 11. Architecture Assessment

### 11.1 Current Design

The Break Bot uses a **local-first** architecture: SQLite is the source of truth, Google Sheets is an async sync target. This design prioritizes responsiveness (commands complete in <1s) over data consistency (synced within ~5s). The Express server handles both the Telegram webhook and the dashboard API on a single port (3004).

### 11.2 Strengths

| Strength | Explanation |
|----------|-------------|
| **Local-first architecture** | Commands are instant (<50ms for SQLite). Users never wait for Google API. |
| **Decoupled sync** | Sync worker runs independently. A Google API failure doesn't block bot commands. |
| **Independent quota pool** | Separate Google service account prevents quota conflicts with other projects. |
| **Graceful degradation** | If Google Sheets is down, the bot still works (SQLite records everything). Data syncs when API recovers. |
| **Comprehensive error handling** | Every Google API call has retry logic, timeout, and error reporting. |
| **Idempotent operations** | Start/end breaks are idempotent — replaying syncs doesn't create duplicates (uses google_sheet_row tracking). |
| **Dual shift support** | Correctly handles DayShift/NightShift with business date mapping. |
| **Caching layers** | Dashboard data is cached (15s TTL), daily summary is cached (eliminates sheet reads). |

### 11.3 Weaknesses

| Weakness | Impact | Severity |
|----------|--------|:--------:|
| **Google API timeout from OVH France** | Archive consistently fails because `readRange` times out even at 180s. Old data never moves to ARCHIVES. | **Critical** |
| **Full sheet reads for archive** | Reading 15 columns × 490+ rows is unnecessary — only column A is needed for classification. | **High** |
| **Serial sync processing** | If one sync hangs, subsequent syncs are delayed. No timeout per individual sync item. | Medium |
| **No monitoring dashboard** | No built-in health/performance UI. Requires PM2 logs or manual DB queries. | Medium |
| **No alerts for sync failures** | If sync_queue accumulates entries, there's no automatic alert. | Medium |
| **Reconcile reads full sheet also** | Same `CS BREAK!A:O` read as archive, with the same timeout problems. | High |
| **Startup blocks on import** | Server doesn't listen until import completes (or times out). | Medium |
| **Manual ID management** | SILENT_USERS, ADMIN_IDS, STAFF_IDS are hardcoded in source. Adding/removing requires a code push + PM2 restart. | Low |

### 11.4 Areas for Future Improvement

| Area | Suggested Approach | Priority |
|------|-------------------|:--------:|
| **Archive reliability** | Read only column A for classification, then batch-fetch only the rows to move. Or use Apps Script for server-side archiving. | **Critical** |
| **Sync resilience** | Add per-item timeout in sync-worker processSyncQueue. Add alerting for queue backlogs. | High |
| **Configuration management** | Move ID lists (ADMIN_IDS, STAFF_IDS, SILENT_USERS) into a config file or SQLite settings table. | Medium |
| **Google API optimization** | Combine multiple updateRange calls into batchUpdate. Reduce column range for reconcile reads (M:N already, but A:O for fallback). | Medium |
| **Health monitoring** | Add a `/api/health/detailed` endpoint showing sync queue depth, archive status, last sync time. | Medium |
| **Archive pagination** | As ARCHIVES grows, reading the entire sheet becomes slower. Paginate reads. | Low |
| **Database backups** | Automated SQLite backup before archive operations. | Low |

---

## 12. File & Function Reference

### 12.1 Core Files

| File | Lines | Key Exports |
|------|:-----:|-------------|
| `src/server.js` | ~120 | Express app, webhook route, dashboard API, health check |
| `src/config.js` | ~30 | `CONFIG` object (bot token, sheet ID, group ID, port) |
| `src/break-bot.js` | ~1230 | `handleBreakUpdate()`, `handleMessage()`, `handleCallback()`, `startBreak()`, `endBreak()`, `getDashboardData()`, `sendStaffMonitoringReport()`, `sendUserHistory()` |
| `src/break-db.js` | ~620 | `initDB()`, `startBreak()`, `endBreak()`, `getActiveBreak()`, `getTodayHistory()`, `getHistoryByDate()`, `queueSync()`, `getPendingSyncs()`, `markSyncDone()`, `getAllActiveBreaks()`, `getSetting()`, `setSetting()` |
| `src/sync-worker.js` | ~200 | `processSyncQueue()`, `syncStartBreak()`, `syncEndBreak()`, `reconcileActiveBreaks()`, `trackOverbreakViolation()`, `startSyncWorker()` |
| `src/archive-worker.js` | ~860 | `runArchive()`, `cellToDateStr()`, `autoCloseStaleBreaks()`, `cleanupDailySummary()`, `cleanupArchives()`, `rebuildDailySummaryCache()`, `hasOldDataToArchive()`, `startArchiveWorker()` |
| `src/google.js` | ~730 | `initBreakAuth()`, `readRange()`, `updateRange()`, `appendRow()`, `breakAppendRow()`, `breakUpdateRange()`, `getOrCreateSheet()`, `breakBatchUpdate()`, `formatBreakSheets()` |
| `src/break-buffer.js` | ~120 | Buffer management for sheet writes |

### 12.2 Key Functions Reference

#### break-bot.js

| Function | Parameters | Purpose |
|----------|------------|---------|
| `handleBreakUpdate(update)` | Raw Telegram update object | Routes incoming webhook to callback or message handler |
| `handleMessage(msg)` | Telegram message object | Routes commands: /start, /end, /history, /myid, /monitoring |
| `handleCallback(cb)` | Telegram callback query | Processes inline button presses (break type, shift, end) |
| `showMenu(chatId, user, userId)` | Chat ID, name, user ID | Shows break type selection menu with auto-detected shift |
| `startBreak(chatId, userId, userName, shiftType, shiftPeriod, breakType)` | Context + break params | Creates break record in SQLite, sends confirmations |
| `endBreak(chatId, userId, userName)` | Context | Ends active break, calculates duration, checks violations |
| `sendUserHistory(chatId, userId, userName)` | Context | Sends today's break history to user |
| `getDashboardData()` | None | Returns JSON for Tab5: onBreak[], dailySummary[], breakHistory[], violations[] |
| `getDashboardDataForDate(dateStr)` | Date string | Same as getDashboardData but for a specific date |
| `updateDailySummary(date, user, shift, period, totalUsed, remaining)` | Summary data | Updates DAILY SUMMARY sheet row |
| `sendStaffMonitoringReport(chatId, targetDate)` | Chat ID, optional date | Admin command: shows 6 staff members' break records grouped by shift |
| `isSilentUser(userId)` | User ID | Checks if user is in SILENT_USERS whitelist |

#### break-db.js

| Function | Parameters | Purpose |
|----------|------------|---------|
| `initDB()` | None | Creates database file + tables + indexes |
| `getDB()` | None | Returns SQLite database instance |
| `startBreak(businessDate, userName, shiftType, shiftPeriod, breakType, startTime, userId)` | Break params | INSERT into breaks + queueSync('start') |
| `endBreak(userId, endTimeStr)` | User ID, time | UPDATE active break with end data + violation check + queueSync('end') |
| `getActiveBreak(userId)` | User ID | Returns current active break or null |
| `getTodayHistory(userId, shiftPeriod)` | User ID, period | Returns today's breaks for user (or '__ALL__' for all) |
| `getHistoryByDate(date, userId)` | Date, user ID | Returns breaks for a specific date |
| `getAllActiveBreaks()` | None | Returns all ON BREAK records |
| `queueSync(operation, breakId, payload)` | Operation type, ID, data | INSERT into sync_queue |
| `getPendingSyncs()` | None | SELECT pending syncs |
| `markSyncDone(id, breakId, row)` | Queue ID, break ID, row | UPDATE sync_status = 'synced', delete from queue |
| `getSetting(key)` | Key string | SELECT from settings table |
| `setSetting(key, value)` | Key + value | INSERT OR REPLACE into settings |

#### sync-worker.js

| Function | Parameters | Purpose |
|----------|------------|---------|
| `processSyncQueue()` | None | Main loop: read pending → process start/end → mark done |
| `syncStartBreak(item)` | Sync queue item | Append row to CS BREAK sheet |
| `syncEndBreak(item)` | Sync queue item | Update existing row + daily summary + violations |
| `reconcileActiveBreaks()` | None | Reverse-sync: check GS for manually ended breaks |
| `trackOverbreakViolation(item)` | Sync queue item | Append violation to OVERBREAK_TRACKER |
| `startSyncWorker(intervalMs)` | Interval (default 5000) | Start periodic sync processing |

#### archive-worker.js

| Function | Parameters | Purpose |
|----------|------------|---------|
| `runArchive()` | None | Main archive flow: read, classify, move, cleanup |
| `cellToDateStr(value)` | Cell value | Normalize serial/string dates to YYYY-MM-DD |
| `autoCloseStaleBreaks()` | None | Close breaks from previous business dates |
| `cleanupDailySummary()` | None | Remove duplicate entries from DAILY SUMMARY |
| `cleanupArchives()` | None | Remove duplicate entries from ARCHIVES |
| `rebuildDailySummaryCache()` | None | Rebuild SQLite daily_summary_cache from GS data |
| `hasOldDataToArchive()` | None | Check if CS BREAK has rows with date < today |
| `startArchiveWorker(intervalMs)` | Interval (default 900000) | Start periodic archive checks |

#### google.js

| Function | Parameters | Purpose |
|----------|------------|---------|
| `initBreakAuth()` | None | Initialize Google API auth with service account |
| `readRange(spreadsheetId, range)` | Sheet ID, A1 range | Read cell range with 180s timeout + 5 retries |
| `updateRange(spreadsheetId, range, values)` | Sheet ID, range, 2D array | Write values with USER_ENTERED mode |
| `appendRow(spreadsheetId, range, values)` | Sheet ID, range, values | Append row with USER_ENTERED mode |
| `breakAppendRow(spreadsheetId, range, values)` | Sheet ID, range, values | Append row with RAW mode (prevents date auto-format) |
| `breakUpdateRange(spreadsheetId, range, values)` | Sheet ID, range, values | Write values with RAW mode |
| `getOrCreateSheet(spreadsheetId, sheetName)` | Sheet ID, tab name | Get or create a sheet tab |
| `breakBatchUpdate(spreadsheetId, requests)` | Sheet ID, batch requests | Execute multiple Google Sheets API requests |
| `formatBreakSheets(spreadsheetId)` | Sheet ID | Apply professional formatting to all break tabs |

### 12.3 Configuration Constants

| Constant | Value | Location |
|----------|-------|----------|
| `GOOGLE_API_TIMEOUT` | `180000` (180s) | google.js |
| `SYNC_TIMEOUT` | `120000` (120s) | sync-worker.js |
| `RECONCILE_INTERVAL` | `60000` (60s) | sync-worker.js |
| `DATA_CACHE_TTL` | `15000` (15s) | break-bot.js |
| `CB_CLEANUP_INTERVAL` | `600000` (10 min) | break-bot.js |
| `ALLOWANCE_SECONDS` | `7200` (2 hours) | break-bot.js |
| `LONG_BREAK_THRESHOLD` | `3600` (1 hour) | break-db.js |
| `ARCHIVE_WORKER_INTERVAL` | `900000` (15 min) | archive-worker.js |

### 12.4 Access Control ID Sets

| Set | Type | Location |
|-----|------|----------|
| `SILENT_USERS` | `Set` of 10 Telegram IDs | break-bot.js |
| `ADMIN_IDS` | `Set` of 4 Telegram IDs | break-bot.js |
| `STAFF_IDS` | `Set` of 6 Telegram IDs | break-bot.js |

---

*Document generated 2026-07-29. Based on commit `8e5730b`.*

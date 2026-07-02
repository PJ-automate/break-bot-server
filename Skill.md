# Break Tracker Skills

## Overview

CS Break Tracker is a Telegram bot (@CSBreakMonitoring_bot) that allows customer service agents to log their breaks. It tracks break duration, generates daily summaries, detects overbreak violations, and syncs data to Google Sheets + a real-time dashboard.

---

## Telegram Bot Commands

### Agent Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/start` | Start a new break. Bot asks for break type (Soft, Lunch, Dinner, Toilet, Smoke, Emergency). | `/start` |
| `/end` | End your current active break. Shows duration + total used today. | `/end` |
| `/history` | View your break history for today. | `/history` |
| `/help` | Show help message with available commands. | `/help` |

### Break Types

When starting a break, the bot presents buttons to select:

| Button | 🆔 Type Code | Max Duration | Notes |
|--------|:-----------:|:-----------:|-------|
| ☕ Soft Break | `soft` | 15-30 min | Short breaks |
| 🍽️ Lunch | `lunch` | 60 min | Meal break |
| 🌙 Dinner | `dinner` | 60 min | Evening meal |
| 🚻 CR | `cr` | 10-15 min | Comfort room |
| 🚬 Smoke | `smoke` | 10-15 min | Smoke break |
| 🆘 Emergency | `emergency` | Varies | Emergency situations |

### Agent Interaction Flow

**Starting a break:**
```
Agent: /start
Bot:   Select your break type:
       [☕ Soft Break] [🍽️ Lunch] [🌙 Dinner]
       [🚻 CR] [🚬 Smoke] [🆘 Emergency]
Agent: [clicks ☕ Soft Break]
Bot:   ✅ Break started at 2:30 PM
       Type: Soft Break
```

**Ending a break:**
```
Agent: /end
Bot:   ✅ Break ended at 2:45 PM
       Duration: 15m 00s
       ⏱ Total used today: 1h 30m
       Remaining: 30m
```

**Viewing history:**
```
Agent: /history
Bot:   📋 Today's Break History:
       1. 09:15 AM - 09:25 AM (10m) 🚻 CR
       2. 12:00 PM - 12:45 PM (45m) 🍽️ Lunch
       3. 02:30 PM - 02:45 PM (15m) ☕ Soft
       
       Total: 1h 10m used
```

---

## Dashboard (Tab5) Skills

The break tracker dashboard is displayed in **Project2's Tab5** and provides:

### KPI Cards
| Metric | Description |
|--------|-------------|
| 👥 On Break | Currently active breaks |
| 📊 Today Total | Total break hours used today |
| ⏳ Avg Duration | Average break duration |
| 🚨 Violations | Overbreak violations today |

### Active Break Monitoring
- Real-time list of agents currently on break
- Shows: name, break type, start time, elapsed duration
- **⚠️ Warning** highlight when break exceeds 1 hour
- **🚨 Overbreak** highlight when total exceeds 2 hours/day

### Daily Summary Table
Per-agent breakdown:
| Agent | Shift | # Breaks | Total Used | Status |
|-------|-------|:--------:|:----------:|--------|
| Juan | DAY | 3 | 1h 30m | ✅ OK |
| Maria | NIGHT | 4 | 2h 15m | ⚠️ Over |

### Break History Timeline
Shows today's complete break timeline for each agent with:
- Break type icon/color coding
- Duration bars
- Overbreak indicators

---

## Operational Skills

### Daily Workflow

1. **Shift Start (12PM or 12AM PH)** → Archive worker runs
   - Previous shift data archived
   - Daily totals reset
   - New shift begins

2. **Ongoing (24/7)** → Bot listens on port 3004
   - Agents start/end breaks
   - Sync worker updates Google Sheet every 5 seconds
   - Dashboard auto-refreshes every 15 seconds

3. **Shift End (11:59PM or 11:59AM)** → Summary generated
   - Final sync completes
   - Data archived

### Shift Rules

| Rule | Implementation |
|------|----------------|
| DAY shift | 12PM – 11:59PM, business date = today |
| NIGHT shift | 12AM – 11:59AM, business date = yesterday |
| Cross-midnight | Breaks cannot span across midnight |
| Max daily break | 2 hours before overbreak alert |

---

## Admin / Maintenance Skills

### Utility Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `rebuild-breaks.js` | Rebuild break records from sheet data | `node rebuild-breaks.js` |
| `check-db-stats.js` | Check SQLite database statistics | `node check-db-stats.js` |
| `check-pending.js` | Check for any pending/unclosed breaks | `node check-pending.js` |
| `check-sheet.js` | Verify Google Sheet data integrity | `node check-sheet.js` |
| `cleanup-db.js` | Clean up old/failed records in DB | `node cleanup-db.js` |
| `fix-all-sheet.js` | Fix and repair sheet data | `node fix-all-sheet.js` |
| `fix-pijie.js` | Fix specific agent's break records | `node fix-pijie.js` |
| `fix-sheet-2.js` | Additional sheet repair utility | `node fix-sheet-2.js` |
| `fix-sheet.js` | General sheet corruption fix | `node fix-sheet.js` |
| `import-sheet.js` | Import sheet data into SQLite | `node import-sheet.js` |
| `populate-active-breaks.js` | Rebuild active breaks from database | `node populate-active-breaks.js` |
| `deploy-server-v2.js` | Deploy script for VPS setup | `node deploy-server-v2.js` |

### VPS Commands

```bash
# Start bot
pm2 start src/server.js --name break-bot-server

# Restart bot
pm2 restart break-bot-server

# View logs
pm2 logs break-bot-server

# Monitor
pm2 monit

# Update from GitHub
cd /home/ubuntu/break-bot-server
git pull origin master
pm2 restart break-bot-server
```

### Set Webhook

```bash
# After deploying to new server, configure Telegram webhook:
curl "http://localhost:3004/set-break-webhook?url=https://vps-faf8418b.vps.ovh.net/webhook-break"
```

---

## Health Check

```
GET /health
Response: {
  "status": "ok",
  "time": "2026-07-02T12:00:00.000Z",
  "timezone": "Asia/Manila"
}
```

### Troubleshooting

| Symptom | Possible Cause | Solution |
|---------|---------------|----------|
| Bot not responding | Webhook misconfigured | Re-run `/set-break-webhook` |
| Breaks not sync to Sheet | Google auth expired | Check `break-bot-key.json` and `.env` |
| Dashboard shows no data | Cache stale / API unreachable | Check PM2 status, port 3004 |
| Overbreak not alerting | Threshold config | Check `break-bot.js` constants |
| SQLite errors | DB corruption | Run `cleanup-db.js` or restore from backup |

---

## Dependencies

| Library | Version | Purpose |
|---------|:-------:|---------|
| express | ^4.19.2 | HTTP server |
| axios | ^1.18.1 | HTTP client (Telegram API) |
| googleapis | ^140.0.1 | Google Sheets API |
| better-sqlite3 | ^12.11.1 | SQLite database |
| dotenv | ^16.4.5 | Environment config |

---

## Configuration (`.env`)

| Variable | Description | Current Value |
|----------|-------------|:-----------:|
| `BREAK_BOT_TOKEN` | Telegram bot token | `8712015323:AAGI...` |
| `BREAK_SHEET_ID` | Google Sheet ID | `1-ZRcIVmMwXzTjGri0eE0off4jWDhppV6Gs-k7_tRop8` |
| `BREAK_GROUP_ID` | Telegram group chat ID | `-1003716788529` |
| `BREAK_SERVICE_ACCOUNT_PATH` | Google service account key path | `./break-bot-key.json` |
| `BREAK_SERVER_PORT` | Server port | `3004` |
| `BREAK_SERVER_HOST` | Server bind address | `0.0.0.0` |

---

## GitHub Repository

- **URL:** https://github.com/PJ-automate/break-bot-server
- **Branch:** `master`
- **Default branch:** `master`

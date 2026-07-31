# Break Bot — Current Workflow

> **Last updated:** 2026-07-30  
> **Commit:** `7d99d54`

---

## 1. Start Break (`/start`)

```
Agent sends /start in break group
         │
         ▼
  ┌──────────────────┐
  │  break-bot.js    │
  │  startBreak()    │
  └────────┬─────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
  SQLite      Telegram
  (instant)   (instant)
  INSERT      response ✅
     │
     ▼
  syncBreakNow(freshBreak, 'start')
     │
     ├─ 1. DELETE FROM sync_queue WHERE break_id = ?
     │      (prevents periodic worker from racing)
     │
     ├─ 2. Check: google_sheet_row > 0?
     │      YES → skip (already synced, idempotency guard)
     │      NO  → continue
     │
     ├─ 3. syncStartBreak(item)
     │      breakAppendRow('CS BREAK!A:O', 15 values)
     │      Returns: row number N
     │      google_sheet_row = N
     │
     └─ 4. UPDATE breaks SET google_sheet_row = N
            WHERE id = breakId
```

**Result:** Break appears in CS BREAK sheet at the next available row.

---

## 2. End Break (`/end`)

```
Agent sends /end in break group
         │
         ▼
  ┌──────────────────┐
  │  break-bot.js    │
  │  endBreak()      │
  └────────┬─────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
  SQLite      Telegram
  (instant)   (instant)
  UPDATE      response ✅
     │
     ▼
  syncBreakNow(endedBreak, 'end')
     │
     ├─ 1. DELETE FROM sync_queue WHERE break_id = ?
     │
     ├─ 2. Check: google_sheet_row > 0?
     │      NO → throw error (cannot update without row)
     │      YES → continue
     │
     ├─ 3. syncEndBreak(item)
     │      breakUpdateRange('CS BREAK!G{r}:J{r}', [end, dur, rem, remark])
     │      breakUpdateRange('CS BREAK!L{r}:M{r}', [total, status])
     │      breakUpdateRange('CS BREAK!O{r}', [statusIcon])
     │
     └─ 4. UPDATE breaks SET sync_status = 'synced'
            WHERE id = breakId
```

**Result:** Same row updated with end time, duration, RETURNED status.

---

## 3. Sync Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    SYNC WORKER                               │
│  sync-worker.js                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  syncBreakNow() ─── Inline sync (called from /start, /end)   │
│  ├─ Queue delete FIRST (atomic)                              │
│  ├─ Idempotency check (skip if already synced)               │
│  ├─ Google Sheets write                                      │
│  └─ google_sheet_row update                                  │
│                                                              │
│  processSyncQueue() ─── Periodic (every 5 seconds)           │
│  ├─ Fallback for failed inline syncs                         │
│  ├─ Only processes entries still in sync_queue               │
│  └─ After queue is empty, runs reconcileActiveBreaks()       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Protection Against Duplicates

| Protection | Location | How It Works |
|-----------|----------|-------------|
| **Queue delete first** | `syncBreakNow()` | `DELETE FROM sync_queue` runs BEFORE the GS await — periodic worker won't find the entry |
| **Idempotency check** | `syncBreakNow()` | If `google_sheet_row > 0` before start sync → skip (already synced) |
| **Idempotency check** | `syncStartBreak()` | Same guard at the function level — catches periodic worker too |
| **End sync guard** | `syncBreakNow()` | Throws if `google_sheet_row` is 0 — never searches for the break |

---

## 5. Google Sheets Structure

```
CS BREAK (15 columns: A-O)
  ├── Writes: syncStartBreak (append), syncEndBreak (update)
  ├── Reads: Only from reconcileActiveBreaks (archive worker)
  └── Grid: 15 columns (was 29 — resized to 15 on 2026-08-01; deleteDimension succeeds on retry)

ARCHIVES (15 columns: A-O)
  └── Writes: archive-worker at midnight

DAILY SUMMARY (5 columns: A-E)
  └── Writes: syncEndBreak fires async daily summary update

OVERBREAK_TRACKER (9 columns: A-I)
  └── Writes: When break has OVERBREAK or LONG BREAK remark
```

---

## 6. Data Flow Diagram

```
Agent /start
      │
      ▼
┌──────────────┐     ┌──────────────┐
│   SQLite     │─────▶   Telegram   │ (instant)
│  (source of  │     │  response    │
│   truth)     │     └──────────────┘
└──────┬───────┘
       │
       ▼
┌──────────────┐     ┌──────────────┐
│syncBreakNow()│─────▶  Google      │ (5-30s API latency)
│  (inline)    │     │  Sheets A1:O1 │
└──────────────┘     └──────────────┘

Agent /end
      │
      ▼
┌──────────────┐     ┌──────────────┐
│   SQLite     │─────▶   Telegram   │ (instant)
│  (updated)   │     │  response    │
└──────┬───────┘     └──────────────┘
       │
       ▼
┌──────────────┐     ┌──────────────┐
│syncBreakNow()│─────▶  Google      │ (updates SAME row)
│  (inline)    │     │  Sheets A1:O1 │
└──────────────┘     └──────────────┘
```

---

## 7. Key Files

| File | Purpose |
|------|---------|
| `src/server.js` | Express server, webhook, dashboard API |
| `src/break-bot.js` | Bot commands: startBreak, endBreak, handleMessage |
| `src/sync-worker.js` | syncBreakNow (inline), processSyncQueue (periodic) |
| `src/break-db.js` | SQLite: breaks table, sync_queue, settings |
| `src/coordinator.js` | Archive-sync lock (Phase 1) |
| `src/archive-worker.js` | Midnight archive (currently disabled by timeout) |
| `src/google.js` | Google Sheets API: breakAppendRow, breakUpdateRange |

---

## 8. Append Range Fix

All `breakAppendRow` calls to CS BREAK use **`A1:O1`** instead of `A:O`.

**Why:** Google Sheets API `values.append` with open-ended range `A:O` writes data starting at column O (instead of A) when the sheet grid is 29 columns wide. Using `A1:O1` (with explicit row) forces the API to correctly identify the table as starting at column A.

**Files updated:** `sync-worker.js`, `break-bot.js`, `break-buffer.js`

## 9. Current Issues

| Issue | Status |
|-------|--------|
| **Grid was 29 columns** | ✅ RESOLVED 2026-08-01 — deleteDimension now succeeds on retry (first attempt hit transient `The service is currently unavailable`). CS BREAK is now 15 columns (A:O). Root cause was transient Google API availability + OVH→Google latency, NOT the JSON key. |
| **GS reads from OVH** | Consistent timeouts. Network issue between OVH France and Google. |
| **Archive not working** | readRange times out. Sheet is small enough now (300+ rows) that a retry may succeed. |

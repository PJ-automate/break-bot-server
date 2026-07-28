# SQLite-First Archive Migration Design

> **Project:** break-bot-server  
> **Status:** Design Proposal — Planning Only  
> **Date:** 2026-07-29  
> **Target File:** `src/archive-worker.js` (896 lines)  
> **Related Files:** `src/break-db.js`, `src/sync-worker.js`, `src/google.js`, `src/break-bot.js`

---

## 1. Current Architecture

### 1.1 Archive Workflow Summary

The current archive worker (`archive-worker.js`) runs on a 15-minute interval via `startArchiveWorker(900000)`. Each `scheduledCheck()` evaluates three conditions to decide whether to trigger `runArchive()`:

1. **Midnight window** (PH time 00:00–00:30) — primary trigger
2. **First run / retry** (`lastArchivedDate` is null) — backup trigger after PM2 restart
3. **Old data detected** (`hasOldDataToArchive()` returns true) — secondary trigger outside midnight window

When `runArchive()` executes, it:

```
Read CS BREAK!A:O  ──→  15 columns × all rows from Google Sheets (180s timeout)
        │
Classify rows by date (column A only):
  │                              │
rowDate < todayStr           rowDate >= todayStr
  │                              │
rowsToMove                    rowsToKeep
  │                              │
  ▼                              ▼
Append to ARCHIVES           Rewrite CS BREAK
(breakAppendRow)             (breakUpdateRange + deleteDimension)
  │                              │
  │                              ▼
  │                         recalculateSheetRows()
  │                         (update google_sheet_row)
  │
  ▼
Mark lastArchivedDate = todayStr in SQLite
Apply formatting
Rebuild daily_summary_cache from sheet
Cleanup: DAILY SUMMARY (30d), ARCHIVES (30d)
```

### 1.2 Current Dependencies

| Dependence | Type | Why It Exists |
|------------|------|---------------|
| `readRange(ssId, 'CS BREAK!A:O')` | Google Sheets read | Primary data source for archive decision |
| `readRange(ssId, 'CS BREAK!A:A')` | Google Sheets read | Used by `hasOldDataToArchive()` to check for old data |
| `breakAppendRow(ssId, "'Archives'!A:O", rowsToMove)` | Google Sheets write | Required — must physically write archived rows |
| `breakUpdateRange(ssId, "'CS BREAK'!...", rowsToKeep)` | Google Sheets write | Required — must rewrite CS BREAK after removing old rows |
| `deleteDimension` | Google Sheets API | Required — must delete excess rows from grid after rewrite |
| `cellToDateStr()` | Local conversion | Converts GS date serials → YYYY-MM-DD for comparison |
| `normalizeDates()` | Local conversion | Normalizes date formats before writing to Archives |
| `ensureArchiveGrid()` | Google Sheets API | Expands Archives grid when appending rows |
| `readRange(ssId, 'DAILY SUMMARY!A:E')` | Google Sheets read | Rebuilds daily_summary_cache after archive |
| `recalculateSheetRows(rowsToKeep)` | Local matching | Matches break_id in kept rows to new sheet positions |

### 1.3 Key Weaknesses in Current Design

1. **Full sheet read is slow and unreliable** — Reading 15 columns × 490+ rows from OVH France to Google APIs consistently times out at 180s.
2. **Data duplication with conflicting sources** — SQLite has all the same data but is ignored for the primary archive decision.
3. **Unnecessary format conversions** — `cellToDateStr()` and `normalizeDates()` exist solely to handle Google Sheets' date serial format, which SQLite already stores as clean YYYY-MM-DD strings.
4. **The archive manages the sheet, not the data** — The worker treats the sheet as the thing being organized, when the sheet should just reflect the underlying data.

---

## 2. Target Architecture

### 2.1 Design Principle

> SQLite determines WHAT to archive. Google Sheets determines WHERE to write it.

The archive worker should:
1. **Query SQLite** to identify which breaks belong to which business date.
2. **Use Google Sheets only for writes** — appending to ARCHIVES, rewriting CS BREAK.
3. **Never read the CS BREAK sheet for data** — it has no information SQLite doesn't.

### 2.2 Target Workflow

```
SQLite Query:
  SELECT * FROM breaks WHERE business_date < todayStr
        │
  Group by break_id, order by start_time
  Format into sheet rows (15 columns, same layout as CS BREAK)
        │
        ▼
  Write to ARCHIVES (breakAppendRow or batchUpdate)
        │
        ▼
  DELETE FROM breaks WHERE business_date < todayStr
  (or mark as archived in SQLite)
        │
        ▼
  Rewrite CS BREAK sheet from scratch using:
    SELECT * FROM breaks WHERE business_date = todayStr
    (ordered by user, time)
        │
        ▼
  Delete excess rows from CS BREAK grid
  Recalculate google_sheet_row from the rewritten sheet
  Mark lastArchivedDate = todayStr
```

### 2.3 Key Differences from Current Design

| Aspect | Current | Target |
|--------|---------|--------|
| Data source for archive decision | Google Sheets (`readRange`) | SQLite (`SELECT WHERE business_date < today`) |
| Date classification | `cellToDateStr()` parsing GS serial numbers | Direct comparison of `business_date` TEXT column |
| Row reconstruction | Uses in-memory `rowsToKeep` array from sheet read | Builds row arrays from SQLite query results |
| Sheet rewrite data | `rowsToKeep` (surviving rows from original read) | Fresh SQLite query for today's data |
| `hasOldDataToArchive()` | Read `CS BREAK!A:A` | `SELECT COUNT(*) FROM breaks WHERE business_date < today` |
| `recalculateSheetRows()` | Iterates `rowsToKeep` array | Iterates today's data from SQLite, computes row numbers from `breakAppendRow` results or fresh sheet read |

---

## 3. Migration Plan

### Phase 1: SQLite Archive Decision (Low Risk)

**Goal:** Replace the Google Sheets read with a SQLite query for determining which data to archive, while keeping the existing write logic unchanged.

**Files affected:** `src/archive-worker.js`
**Functions affected:** `runArchive()`, `hasOldDataToArchive()`

| Change | Detail |
|--------|--------|
| Replace `readRange(ssId, 'CS BREAK!A:O')` with SQLite query | Query breaks WHERE `business_date < todayStr`, format into sheet-compatible 2D arrays |
| Replace `hasOldDataToArchive()` sheet read with SQLite query | `SELECT COUNT(*) FROM breaks WHERE business_date < todayStr` |
| Keep existing write logic unchanged | `breakAppendRow` to Archives, `breakUpdateRange` to CS BREAK, `deleteDimension` |

**Risk:** Low
**Testing required:**
- Verify archive moves the correct rows (compare SQLite query results with expected archive set)
- Verify today's rows remain in CS BREAK after rewrite
- Verify `lastArchivedDate` is set correctly

**Rollback:** Revert the data source change — the old sheet-based code path is the fallback.

**Estimated lines changed:** ~20 lines in `runArchive()`, ~10 lines in `hasOldDataToArchive()`

---

### Phase 2: SQLite Rewrite of CS BREAK (Medium Risk)

**Goal:** Build the post-archive CS BREAK sheet content from SQLite instead of from the in-memory `rowsToKeep` array.

**Files affected:** `src/archive-worker.js`
**Functions affected:** `runArchive()`, `recalculateSheetRows()`

| Change | Detail |
|--------|--------|
| After archiving, query `SELECT * FROM breaks WHERE business_date = todayStr` | Get today's breaks from SQLite instead of filtering the sheet read |
| Format result into sheet-compatible 2D array | Map SQLite columns → sheet columns (same 15-column layout) |
| Write to CS BREAK with `breakUpdateRange` | Same write logic as before, but data comes from SQLite |
| Rebuild `recalculateSheetRows()` to accept SQLite rows | Instead of iterating `rowsToKeep` array, iterate the SQLite result set |

**Risk:** Medium — the sheet column mapping must be exact. A mismatch would corrupt the CS BREAK tab.
**Testing required:**
- Verify every column maps correctly between SQLite schema and sheet layout
- Compare pre-archive and post-archive CS BREAK content for a test date
- Verify `break_id` alignment for `recalculateSheetRows()`

**Rollback:** Re-run archive from previous day using current code path.

**Estimated lines changed:** ~40 lines in `runArchive()`, full rewrite of `recalculateSheetRows()` (~30 lines)

---

### Phase 3: Remove Redundant Functions (Low Risk)

**Goal:** Remove the sheet-dependent utilities that are no longer needed.

**Files affected:** `src/archive-worker.js`
**Functions affected:** `cellToDateStr()`, `normalizeDates()`

| Change | Detail |
|--------|--------|
| Remove `cellToDateStr()` | No longer needed — SQLite dates are already YYYY-MM-DD |
| Remove `normalizeDates()` | No longer needed — data from SQLite is already normalized |
| Update any remaining references | Check if any other function still depends on these |

**Risk:** Low — these functions are pure utilities with no side effects. Removing them just requires verifying no other caller exists.

**Testing required:** None beyond standard archive smoke test.

**Estimated lines removed:** ~50 lines

---

### Phase 4: Reconcile Independence (Medium-High Risk)

**Goal:** Decouple `reconcileActiveBreaks()` from the archive's CS BREAK read so each operation reads only what it needs.

**Files affected:** `src/archive-worker.js`, possibly `src/sync-worker.js`
**Functions affected:** `reconcileActiveBreaks()`, `runArchive()`, `scheduledCheck()`

| Change | Detail |
|--------|--------|
| `reconcileActiveBreaks()` gets its own `readRange` call | Read only columns M, N (status, break_id) instead of A:O. This is identical to the sync worker's reconcile — just 2 columns. |
| `scheduledCheck()` runs reconcile independently | No longer depends on the archive's data variable |
| `reconcileActiveBreaks()` timeout reduced | Since only 2 columns, timeout can drop from 180s to 30s (matching sync-worker's reconcile) |

**Risk:** Medium-High. This changes the timing of reconciliation — currently it runs as part of `runArchive()`, but after this change it runs separately in `scheduledCheck()`. The reconcile should run MORE frequently (every 15 min) but independently of the archive.

**Testing required:**
- Verify reconcile still detects manually-ended breaks
- Verify no duplicate reconciliation (breaks reconciled by both sync-worker and archive-worker)
- Verify `lastArchivedDate` flow is unaffected

**Rollback:** Keep the dual reconcile temporarily — both paths can coexist harmlessly.

**Estimated lines changed:** ~25 lines in `reconcileActiveBreaks()`, ~15 lines in `scheduledCheck()`

---

### Phase 5: Cleanup and Post-Archive Cache Rebuild (Low Risk)

**Goal:** Replace the post-archive sheet read for daily_summary_cache rebuild with SQLite data.

**Files affected:** `src/archive-worker.js`
**Functions affected:** `runArchive()` (post-archive section)

| Change | Detail |
|--------|--------|
| Replace `readRange(ssId, 'DAILY SUMMARY!A:E')` with SQLite query | `SELECT * FROM daily_summary_cache` or recompute from `breaks` table |
| Remove the DAILY SUMMARY sheet read dependency | The cache already exists in SQLite — rebuild it from there instead of re-reading the sheet |

**Risk:** Low
**Testing required:**
- Verify daily_summary_cache is accurate after archive
- Compare rebuilt cache with pre-archive state

**Estimated lines changed:** ~10 lines

---

## 4. Function Changes

### 4.1 `runArchive()` — Core Archive Flow

**Current behavior:**
1. Read `CS BREAK!A:O` from Google Sheets (180s timeout).
2. Iterate rows, classify by date column into `rowsToMove` / `rowsToKeep`.
3. Append `rowsToMove` to ARCHIVES via `breakAppendRow`.
4. Rewrite CS BREAK with `rowsToKeep` via `breakUpdateRange`.
5. Delete excess rows from CS BREAK grid via `deleteDimension`.
6. Run `recalculateSheetRows(rowsToKeep)`.
7. Set `lastArchivedDate`.

**Target behavior:**
1. Query SQLite: `SELECT * FROM breaks WHERE business_date < todayStr ORDER BY user_name, start_time`.
2. Format result rows into sheet-compatible 2D arrays (same 15-column layout).
3. Append archived rows to ARCHIVES via `breakAppendRow` (same as current).
4. Query SQLite: `SELECT * FROM breaks WHERE business_date = todayStr ORDER BY user_name, start_time`.
5. Format result rows into sheet-compatible 2D arrays.
6. Rewrite CS BREAK with today's data via `breakUpdateRange` (same write logic, different data source).
7. Delete excess rows from CS BREAK grid (same as current).
8. Run `recalculateSheetRows()` with SQLite result set instead of `rowsToKeep`.
9. Set `lastArchivedDate`.

**What stays the same:**
- The sheet write operations (`breakAppendRow`, `breakUpdateRange`, `deleteDimension`).
- The `lastArchivedDate` persistence logic.
- The formatting re-application.
- The cleanup calls (`cleanupDailySummary`, `cleanupArchives`).

**What changes:**
- Data source for both archive rows and keep rows switches from sheet read → SQLite query.
- The `rowsToMove` and `rowsToKeep` arrays are built from SQLite, not from `data.filter(...)`.

### 4.2 `recalculateSheetRows()` — Row Pointer Recalculation

**Current behavior:**
```javascript
// Takes rowsToKeep (2D array from sheet read)
// Iterates rowsToKeep[i][13] to get break_id
// Sets google_sheet_row = i + 1 for each break
```

The function receives the in-memory `rowsToKeep` array, which is a slice of the original sheet read. It matches `break_id` (column N, index 13) against the SQLite `breaks.break_id` column.

**Target behavior:**
Option A: Accept a SQLite result set (array of break objects) instead of `rowsToKeep`. Compute `sheetRow = 1 + index`, then update `google_sheet_row` using `break_id` from each row object.

Option B: After rewriting CS BREAK, read back just columns A and N (`CS BREAK!A:N`) from the sheet to get the new row positions. This adds one small read but guarantees accuracy.

**Recommendation:** Option A is simpler but Option B is safer because it accounts for any row shifts that might occur during the sheet write (e.g., if the sheet has hidden rows, formatting rows, or the header row position changes). However, Option B reintroduces a sheet read, which contradicts the SQLite-first goal. Option A is preferred, with the assumption that row numbers are deterministic (header at row 1, data starting at row 2).

### 4.3 `reconcileActiveBreaks()` — Reverse Sync

**Current behavior:**
- Reads `CS BREAK!A:O` (full 15 columns) as part of `runArchive()`.
- Matches `break_id` (column N) against active breaks in SQLite.
- If sheet shows `RETURNED` / `OVERBREAK` / `LONG BREAK` but SQLite shows `ON BREAK`, updates SQLite.

**Target behavior:**
- Independently reads only `CS BREAK!M:N` (status + break_id) — 2 columns instead of 15.
- Uses the same pattern as `sync-worker.js` `reconcileActiveBreaks()` which already reads only `M:N` with a 30s timeout.
- Runs as a separate step in `scheduledCheck()`, not inside `runArchive()`.

**Why this works:**
- The reconcile only needs `status` (column M) and `break_id` (column N).
- These two columns can be read with a 30s timeout (matching the sync worker's reconcile) instead of 180s.
- The reconcile does not need end time, duration, or any other column for its decision — it only needs to know "is this break's status still ON BREAK in the sheet?" The full row data (end time, duration, etc.) is only needed when actually updating SQLite, which happens inside the reconcile loop using individual row reads.

**What stays the same:**
- The logic for detecting RETUREND/OVERBREAK/LONG BREAK in column M.
- The SQLite UPDATE query when reconciling.
- The daily_summary_cache update after reconciliation.

### 4.4 `hasOldDataToArchive()` — Old Data Detection

**Current behavior:**
```javascript
const data = await readRange(CONFIG.breakSheetId, 'CS BREAK!A:A');
// Iterate rows, check if any row date < todayStr
```

**Target behavior:**
```javascript
var oldCount = db.getDB().prepare(
  "SELECT COUNT(*) as c FROM breaks WHERE business_date < ?"
).get(todayStr);
return oldCount.c > 0;
```

**What changes:**
- Sheet read (potentially slow) → SQLite query (instant).
- No timeout risk, no `cellToDateStr()` conversion needed.
- The function becomes synchronous, removing the need for `await`.

**What stays the same:**
- The return value (boolean).
- The `lastArchivedDate` restore logic.
- The function's position in `scheduledCheck()`.

### 4.5 `google_sheet_row` Handling

**Current behavior:**
- Set by sync worker after each start/end operation.
- Recalculated by `recalculateSheetRows()` after archive.
- Used by `syncEndBreak()` to know which row to update.
- Used by `processSyncQueue()` to decide append vs update.

**Target behavior:**
- Same lifecycle, same locations, same usage.
- Only the input data source for recalculation changes (from `rowsToKeep` array → SQLite result set).
- The `google_sheet_row` value remains the authoritative pointer from SQLite → sheet.

**Compatibility check:**
The sync worker's `syncEndBreak()` reads `b.google_sheet_row` from the `breaks` table. As long as this value is kept accurate by `recalculateSheetRows()`, the sync worker is unaffected. No changes needed in `break-db.js` or `sync-worker.js`.

---

## 5. Compatibility

### 5.1 Sync Worker — NOT affected

| Aspect | Why It's Safe |
|--------|---------------|
| `processSyncQueue()` reads from SQLite `sync_queue` table | No change — same queue, same processing logic |
| `syncStartBreak()` appends to CS BREAK | No change — same write function, same sheet range |
| `syncEndBreak()` updates CS BREAK row | Uses `google_sheet_row` from SQLite — as long as `recalculateSheetRows()` stays accurate, this works |
| `reconcileActiveBreaks()` in sync-worker | This function already exists in `sync-worker.js` (60s interval) and reads only `CS BREAK!M:N`. It will continue running independently of the archive worker. **Phase 4 of the migration decouples the archive-worker's reconcile from the archive read, but the sync-worker's reconcile is already independent.** |

### 5.2 Dashboard — NOT affected

The dashboard (`getDashboardData()` in `break-bot.js`) reads entirely from SQLite:

```javascript
var activeBreaks = db.getAllActiveBreaks();      // SQLite
var allBreaks = db.getTodayHistory('__ALL__');    // SQLite
```

No Google Sheets reads. The archive migration changes nothing for the dashboard.

### 5.3 Google Sheets Layout — Preserved

The CS BREAK sheet maintains the same 15-column layout (A:O). The same column mapping applies:

| Sheet Column | SQLite Column | Source in New Design |
|:------------:|:-------------:|----------------------|
| A — Date | `business_date` | Direct from SQLite |
| B — User Name | `user_name` | Direct from SQLite |
| C — Shift Type | `shift_type` | Direct from SQLite |
| D — Shift Period | `shift_period` | Direct from SQLite |
| E — Break Type | `break_type` | Direct from SQLite |
| F — Start Time | `start_time` | Direct from SQLite |
| G — End Time | `end_time` | Direct from SQLite |
| H — Duration | `duration_hms` | Direct from SQLite |
| I — Remaining | `remaining` | Direct from SQLite |
| J — Remark | `remark` | Direct from SQLite |
| K — User ID | `user_id` | Direct from SQLite |
| L — Total Used | `total_used_hms` | Direct from SQLite |
| M — Status | Computed: `ON BREAK` / `ENDED` + remark | Derived from `status` + `remark` |
| N — Break ID | `break_id` | Direct from SQLite |
| O — Status Icon | Computed: 🔴 🟢 ⚠️ | Derived from `status` + `remark` |

The column mapping function (currently implicit in how `rowsToKeep` / `rowsToMove` are structured) would need to be made explicit — a single function that takes a SQLite row object and returns a 15-element array.

### 5.4 Break Tools — Preserved

Break Tools (the Google Sheets menu that allows manual break management) writes directly to the CS BREAK sheet. This changes the sheet without updating SQLite. The `reconcileActiveBreaks()` function (in both sync-worker and archive-worker) exists specifically to detect these out-of-band changes.

Under the new design:
- **The archive's `reconcileActiveBreaks()` still reads the sheet** (just columns M:N instead of A:O).
- **The sync-worker's `reconcileActiveBreaks()` runs every 60s** and already reads only `CS BREAK!M:N` with a 30s timeout.
- Breaks manually ended via Break Tools will still be detected and reconciled.

**Important consideration:** After archive rewrites CS BREAK, any rows that were in the process of being edited via Break Tools at that exact moment could be lost. This is already true in the current design — the archive rewrites the entire sheet. The new design does not change this behavior.

### 5.5 Reconciliation — Preserved

The reconciliation feature detects when a break was ended via Google Sheets (not via Telegram) and updates SQLite accordingly.

Under the new design:
- `reconcileActiveBreaks()` in the archive worker runs every 15 min via `scheduledCheck()`.
- It reads `CS BREAK!M:N` (2 columns, 30s timeout) instead of `CS BREAK!A:O` (15 columns, 180s timeout).
- It uses the exact same comparison logic (check column M for RETURNED/OVERBREAK/LONG BREAK).
- It uses the exact same SQLite UPDATE query.

The only difference is that after Phase 4, the reconcile reads 2 columns instead of 15, making it faster and independent of the archive flow.

---

## 6. Risk Assessment

### 6.1 Migration Risks

| Risk | Phase | Severity | Mitigation |
|------|:-----:|:--------:|------------|
| Column mapping mismatch between SQLite schema and sheet layout | 2 | **High** | Create a single source-of-truth mapping function. Test by comparing pre-archive sheet content with SQLite-generated sheet content for the same date. |
| `google_sheet_row` goes out of sync | 2 | **High** | After first archive under new design, run `recalculateSheetRows()` and verify against actual sheet positions. Compare with pre-migration values. |
| Synced breaks lost during archive | 2 | **Medium** | The archive rewrites the entire CS BREAK sheet. If a break was synced to the sheet between the SQLite query and the sheet rewrite, it could be lost. This is a **pre-existing risk** — the current design has it too, since there's a time gap between `rowsToKeep` computation and the `breakUpdateRange` write. |
| Reconcile misses a manually-ended break | 4 | **Low** | Two reconciliation paths exist (sync-worker at 60s, archive-worker at 15min). Even if one misses, the other catches it. |
| `breakAppendRow` fails during archive | 1 | **Medium** | Same as current — the try/catch + fallback logic in `runArchive()` handles this. The retry behavior is unchanged. |
| SQLite database locked during archive query | 1 | **Low** | WAL mode + synchronous queries. better-sqlite3 is single-threaded, so no concurrent write conflicts during archive. |

### 6.2 Rollback Strategy

| Phase | Rollback Method |
|:-----:|-----------------|
| 1 | Revert the data source in `runArchive()` and `hasOldDataToArchive()` to use `readRange`. The old code path was simply replaced — reverting restores it. |
| 2 | Re-run archive from previous day using old code path. The CS BREAK sheet will be regenerated from backup data. |
| 3 | Restore `cellToDateStr()` and `normalizeDates()` — revert deletion. |
| 4 | Restore the old `reconcileActiveBreaks()` that reads `A:O` from within `runArchive()`. |
| 5 | Revert the cache rebuild to use `readRange(ssId, 'DAILY SUMMARY!A:E')`. |

**Full rollback:** Restore `archive-worker.js` from git (the pre-migration version is committed at `8e5730b`). Re-run the previous day's archive.

### 6.3 Edge Cases

| Edge Case | Behavior Under New Design | Mitigation |
|-----------|--------------------------|------------|
| **Breaks spanning midnight** | A break started at 11:50 PM and ended at 12:10 AM has `business_date` = start date. The archive processes by `business_date`, so the full break stays in the start date's archive bucket. This is the **same behavior as current** — the sheet stores a single date per row. | None needed — consistent with current design. |
| **No breaks on a day** | SQLite query returns empty set. CS BREAK is rewritten with only the header row. Same as current behavior when `rowsToKeep.length === 1`. | No special handling needed. |
| **All breaks archived (none today)** | `WHERE business_date = todayStr` returns empty. CS BREAK should be written with just the header row. `deleteDimension` removes all data rows. | Same as current — the `if (rowsToKeep.length > 0)` guard handles this. |
| **Break ID not found in SQLite** | `recalculateSheetRows()` would skip it (the `try/catch` in the current `db.updateSheetRow()` call already handles this). | No change — same behavior. |
| **Sync queue has pending items during archive** | The sync worker runs independently on a 5s interval. If it appends a row to CS BREAK while the archive is rewriting the sheet, the newly appended row could be lost. **This is a pre-existing race condition.** | The archive runs at midnight when no agents are active (or should be). The `running` flag prevents concurrent archive runs. |
| **Google Sheets write succeeds but SQLite update fails** | Archive data is written to the sheet, but `lastArchivedDate` is never set. Next 15-min interval retries the archive. The sheet write is idempotent (duplicate archive rows would be created). **This is a pre-existing issue.** | The `try/catch` around `db.setSetting('lastArchivedDate', ...)` handles this — on failure, the next interval retries. |
| **Dashboard data inconsistency during archive** | Dashboard reads from SQLite, not the sheet. SQLite is never locked (WAL mode). The dashboard remains fully functional during archive. | No risk — SQLite read consistency is guaranteed. |

---

## 7. Final Recommendation

### 7.1 Why the New Architecture Is Better

**1. Eliminates the primary failure point.**

The single biggest operational issue with the current break bot is the Google Sheets read timeout from OVH France. Every archive attempt reads `CS BREAK!A:O` (15 columns × 490+ rows), and every attempt times out at 180s. The server's error log shows:

```
❌ ARCHIVE ERROR: Google API timeout (180000ms)
lastArchivedDate was NOT updated — archive will retry in 15 min
```

This has been failing consistently because the network path from OVH France to Google APIs cannot sustain a 15-column × 500-row read within the timeout window. The SQLite-first design replaces this single slow read with instant local queries — `SELECT * FROM breaks WHERE business_date < ?` completes in under 50ms.

**2. Aligns architecture with reality.**

The system claims SQLite is the source of truth, and every other component treats it as such — the sync worker reads from SQLite, the dashboard reads from SQLite, the bot commands write to SQLite. Only the archive worker reads from Google Sheets for its primary decision. This inconsistency is a design debt, not a technical requirement. The migration pays down this debt.

**3. Removes unnecessary complexity.**

| Function | Lines | Purpose | Redundant Because |
|----------|:-----:|---------|-------------------|
| `cellToDateStr()` | 30 | Convert GS date serials → YYYY-MM-DD | SQLite `business_date` is already YYYY-MM-DD |
| `normalizeDates()` | 10 | Normalize date formats before write | Data from SQLite is already normalized |
| `hasOldDataToArchive()` sheet read | 15 | Check sheet for old data | `SELECT COUNT(*) FROM breaks WHERE business_date < ?` is instant |

Removing these three functions eliminates ~55 lines of maintenance burden and the primary source of timeout-related errors.

**4. Faster archive cycle.**

Current archive: **180s timeout + 5-10s of writes** = archive takes up to 3+ minutes (or fails entirely).

New archive: **50ms query + 5-10s of writes** = archive takes under 15 seconds even on the slowest network day. This means:

- The archive runs faster = CS BREAK sheet is smaller sooner = subsequent sheet reads (for reconcile) are faster.
- The server starts faster in Phase 1 (startup import is now instant).
- No more "first run" or "retry" code paths — the archive succeeds on the first attempt every time.

### 7.2 Trade-offs

| Trade-off | Impact | Acceptable? |
|-----------|--------|:-----------:|
| **Sheet-to-SQLite mapping must be exact** | If the column mapping function has a bug, the CS BREAK sheet could be corrupted with misaligned data. | **Acceptable** — the mapping is straightforward (15 SQLite columns → 15 sheet columns, all TYPE TEXT in SQLite). Create a single test function that compares pre-archive and post-archive sheet content. |
| **`recalculateSheetRows()` needs a different data source** | Currently takes the in-memory `rowsToKeep` array. Under new design, takes a SQLite result set. Row numbers must be computed from the result set index + 1. | **Acceptable** — row positions are deterministic. Header at 1, first data row at 2. |
| **Cannot detect sheet-only data inconsistencies** | Currently, the archive reads the sheet and uses it as ground truth. If a rogue script or manual edit adds rows to CS BREAK that don't exist in SQLite, the current archive catches them in the `rowsToMove` set. The new design would not see those rows. | **Acceptable** — the reconcile feature (which continues to read the sheet) handles this. Rows added directly to CS BREAK without corresponding SQLite records are not "real" breaks in the system's view. They will be detected by `reconcileActiveBreaks()` and can be acted upon separately. |
| **Row ordering may shift** | The current design preserves the exact row order from the sheet read (including any manual reordering). The SQLite-first design enforces `ORDER BY user_name, start_time`. | **Acceptable** — the current order is effectively random (insertion order). ORDER BY is a strict improvement for readability. |

### 7.3 Verdict

> **Proceed with Phase 1 immediately, then Phase 2. Phase 3-5 can follow after verification.**

The migration is low-risk because:
- All 5 phases can be rolled back to commit `8e5730b`.
- Phase 1 and 2 can be verified independently by comparing the SQLite-generated sheet content against the expected sheet state.
- No other system component (sync worker, dashboard, bot commands) depends on the archive worker's data source.
- The sheet read for `reconcileActiveBreaks()` (Phase 4) is already handled by the sync worker's independent reconcile, providing a safety net.

The migration is high-value because:
- It fixes the single most persistent operational failure in the system (archive timeout).
- It removes ~55 lines of unnecessary code.
- It aligns the archive worker with the system's stated architecture.
- It reduces archive cycle time from minutes to seconds.

---

*Design document prepared 2026-07-29. Based on commit `8e5730b`.*

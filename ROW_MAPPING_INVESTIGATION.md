# Break Bot Row Mapping Investigation

> **Issue:** Break records updated on wrong Google Sheets row  
> **Status:** Analysis Complete — No Code Modified  
> **Date:** 2026-07-29  
> **Source Files Examined:** `src/sync-worker.js` (425 lines), `src/break-db.js` (~620 lines), `src/archive-worker.js` (896 lines), `src/break-bot.js` (~1230 lines)

---

## 1. Trace One Complete Break Record

### 1.1 Row Mapping at Each Step

| Step | Function | File | Sheet Row Used | SQLite `google_sheet_row` | Row Source |
|:----:|----------|------|:--------------:|:-------------------------:|------------|
| **Start break** | `db.startBreak()` | break-db.js | — | **0** (default) | SQLite INSERT default |
| **Sync start** | `syncStartBreak()` | sync-worker.js:200-205 | **Row N** | **N** | `breakAppendRow` response `updatedRange` |
| **End break** | `db.endBreak()` | break-db.js | — | N (unchanged) | No change |
| **Sync end** | `syncEndBreak()` | sync-worker.js:215-257 | **Row N** | N (unchanged) | `item.google_sheet_row` |
| **Archive** | `recalculateSheetRows()` | archive-worker.js:638-660 | **Row M** | **M** | Computed: `i + 1` from `rowsToKeep` position |
| **Reconcile** | `reconcileActiveBreaks()` | sync-worker.js:387-392 | **Row S** | **S** | From `CS BREAK!M:N` read position |

### 1.2 Critical Observation

Every write to the CS BREAK sheet depends on `google_sheet_row` being correct. If it becomes stale, all three end-break writes (G-J, L-M, O) land on the wrong row. The start data remains at the correct position, but the end data is orphaned on a different row.

---

## 2. Every Function That Writes to CS BREAK

| Function | File | Write Operation | Range | Row Determination |
|----------|------|----------------|-------|-------------------|
| `syncStartBreak()` | sync-worker.js:200 | `breakAppendRow` | `CS BREAK!A:O` | **API response**: `updatedRange` match |
| `syncEndBreak()` (G-J) | sync-worker.js:247 | `breakUpdateRange` | `CS BREAK!G{row}:J{row}` | **`item.google_sheet_row`** |
| `syncEndBreak()` (L-M) | sync-worker.js:252 | `breakUpdateRange` | `CS BREAK!L{row}:M{row}` | **`item.google_sheet_row`** |
| `syncEndBreak()` (O) | sync-worker.js:257 | `breakUpdateRange` | `CS BREAK!O{row}` | **`item.google_sheet_row`** |
| End fallback append | sync-worker.js:84 | `breakAppendRow` | `CS BREAK!A:O` | **API response**: `updatedRange` |
| Archive rewrite | archive-worker.js:328 | `breakUpdateRange` | `CS BREAK!A1:O{n}` | **Positional**: `rowsToKeep[i]` → row `i+1` |
| Archive empty fallback | archive-worker.js:375 | `breakUpdateRange` | `CS BREAK!A2:O1000` | Fixed range (clears all rows 2-1000) |

### 2.1 The Three-Write Problem in `syncEndBreak()`

The end-break sync makes **three separate API calls** to update a single break row:

```javascript
// sync-worker.js lines 247-257
await breakUpdateRange(SH, 'CS BREAK!G' + rowIndex + ':J' + rowIndex, [[endData]]);
await breakUpdateRange(SH, 'CS BREAK!L' + rowIndex + ':M' + rowIndex, [[statusData]]);
await breakUpdateRange(SH, 'CS BREAK!O' + rowIndex, [[statusIcon]]);
```

All three use the same `rowIndex = item.google_sheet_row`. If `rowIndex` is correct → all three land correctly. If `rowIndex` is stale → all three land on the wrong row, producing the exact symptom described: "remaining data on a different row."

---

## 3. Root Cause: Archive-Sync Race Condition

### 3.1 The Mechanism

The archive worker and sync worker run independently with **no cross-worker synchronization**. The sync worker fires every **5 seconds**. The archive worker takes **180+ seconds** to complete. Within that window:

```
Time    Archive Worker                     Sync Worker
────    ───────────────                    ───────────
T+0s    Reads CS BREAK!A:O (all rows)
T+90s   (still reading from GS API)
T+180s  Classifies rows into rowsToMove / rowsToKeep
T+181s  Appends rowsToMove to ARCHIVES
T+182s                                     Fires (5s tick)
                                            Appends new break at ROW 501
                                            google_sheet_row = 501
T+183s  Rewrites CS BREAK with rowsToKeep
        breakUpdateRange("CS BREAK!A1:O251", rowsToKeep)
        → Writes rows 1-251
        → Row 501 is OUTSIDE this range → UNCHANGED
T+184s  deleteDimension(start=251, end=1000)
        → Deletes rows 251 through 1000
        → **ROW 501 IS DELETED**
T+185s  recalculateSheetRows(rowsToKeep)
        → Only processes breaks IN rowsToKeep
        → Break at row 501 is NOT in rowsToKeep
        → Its google_sheet_row stays at 501 (STALE)
```

**Later, when the agent ends the break:**

```
T+300s  Sync worker processes 'end' sync
        Reads google_sheet_row = 501 from SQLite
        syncEndBreak() updates CS BREAK!G501:J501
        → Row 501 was deleted → "exceeds grid limits" error
        → OR: if fallback path was used, row 501 is empty → writes silently
```

### 3.2 Why the Fallback Path Is Worse

If `deleteDimension` fails, the archive uses an empty-row fallback:

```javascript
// archive-worker.js line 375
await breakUpdateRange(ssId, "'CS BREAK'!A2:O1000", Array(999).fill(['',...'']));
```

This overwrites rows 2-1000 with empty cells:
- The kept data at rows 2-251 **is overwritten by empty cells**
- Row 501 is now empty but EXISTS
- `syncEndBreak(501)` **succeeds silently** — writing to an existing empty row does not error
- End data (G-O) lands on row 501, but start data was at rows 2-251 (now empty) 
- **Result: Orphaned end data at row 501 with no visible start data**

### 3.3 Why the Error Handler Fails

The sync worker's error handler only catches one specific error:

```javascript
// sync-worker.js lines 148-153
if (err.message && err.message.indexOf('exceeds grid limits') >= 0) {
  db.getDB().prepare('UPDATE breaks SET google_sheet_row = 0 WHERE id = ?').run(item.sq_break_id);
}
```

| Scenario | Error Fired? | google_sheet_row Reset? | Outcome |
|----------|:-----------:|:-----------------------:|---------|
| `deleteDimension` succeeded | "exceeds grid limits" | **Yes** → reset to 0 | **Recoverable**: fallback append on retry |
| `deleteDimension` fell back to empty write | **No error** (writes silently) | **No** | **Silent corruption**: stale row, orphaned data |

---

## 4. Secondary Root Cause: recalculateSheetRows Skips Breaks Outside rowsToKeep

`recalculateSheetRows()` iterates only the `rowsToKeep` array — which was derived from the pre-archive sheet read. Any break appended BY THE SYNC WORKER during the archive is NOT in `rowsToKeep`. Therefore:

- Its `google_sheet_row` is **never updated** to reflect the post-archive sheet state
- It retains the pre-archive row number (which is now wrong)
- The break is invisible to the recalculation logic

### 4.1 Break ID Mismatch Risk

```javascript
// archive-worker.js lines 644-656
for (var i = 1; i < rowsToKeep.length; i++) {
  var row = rowsToKeep[i];
  if (!row || !row[13]) continue;           // column N = break_id
  var breakId = String(row[13]).trim();
  if (!breakId) continue;
  var sheetRow = i + 1;
  try {
    db.updateSheetRow(breakId, sheetRow);    // UPDATE breaks SET google_sheet_row = ? WHERE break_id = ?
  } catch (e) { /* skip */ }
}
```

If column N is empty or the `break_id` doesn't match any record in the `breaks` table, the catch block silently skips the break. Its `google_sheet_row` remains at the pre-archive value — even though the break was moved to a new position by the archive rewrite.

**When could column N be empty?** If a row was added to the sheet via Break Tools or manual editing without a `break_id`. These rows would be invisible to `recalculateSheetRows` and would never get their `google_sheet_row` updated.

---

## 5. Tertiary Root Cause: Reconcile Can Overwrite google_sheet_row

Both workers have `reconcileActiveBreaks()` functions that set `google_sheet_row`:

```
Sync-worker reconcile (every 60s):
  Reads CS BREAK!M:N → computes sheetRow = i+1
  → UPDATE breaks SET google_sheet_row = sheetRow

Archive-worker reconcile (every 15min):
  Reads CS BREAK!A:O → computes sheetRow = i+1
  → UPDATE breaks SET google_sheet_row = sheetRow
```

Both compute `sheetRow` from the **position in the read data**, NOT from an actual sheet row lookup. If the two reconciles run at different times and the sheet has changed in between (e.g., due to sync appends or archive rewrites), they can produce **different `google_sheet_row` values** for the same break.

The last writer wins. If the sync-worker reconcile runs after the archive's `recalculateSheetRows`, it overwrites the carefully computed post-archive row number with its own position-based value — which might be stale if the sync worker's read happened before the archive rewrite.

---

## 6. Affected Files and Functions

### 6.1 Directly Affected

| File | Functions | Role in Issue |
|------|-----------|---------------|
| `src/sync-worker.js` | `processSyncQueue()` lines 38-174 | Race participant — syncs during archive window |
| `src/sync-worker.js` | `syncEndBreak()` lines 215-283 | Writes to stale `google_sheet_row` |
| `src/sync-worker.js` | Error handler lines 148-153 | Only catches "exceeds grid limits", misses silent fallback |
| `src/archive-worker.js` | `runArchive()` lines 186-452 | Race participant — takes 180s+ |
| `src/archive-worker.js` | `recalculateSheetRows()` lines 638-660 | Skips breaks not in `rowsToKeep` |
| `src/archive-worker.js` | Empty-row fallback lines 374-377 | Hides row deletion, causes silent corruption |
| `src/break-db.js` | `markSyncDone()` line 309-318 | Writes `google_sheet_row` from sync response |
| `src/break-db.js` | `updateSheetRow()` line ~370 | Used by `recalculateSheetRows` |

### 6.2 Indirectly Affected

| File | Functions | Role in Issue |
|------|-----------|---------------|
| `src/sync-worker.js` | `reconcileActiveBreaks()` lines 340-405 | Can overwrite `google_sheet_row` separately |
| `src/archive-worker.js` | `reconcileActiveBreaks()` lines 677-756 | Same as above |
| `src/break-bot.js` | `startBreak()`, `endBreak()` | Trigger the sync queue entries |

---

## 7. Data Corruption Assessment

### 7.1 Has Any Data Been Corrupted?

**Yes — but only in the Google Sheet presentation layer. SQLite data is intact.**

The corruption is limited to:
1. **Orphaned end-column data** (G-O) on a wrong/empty sheet row
2. **Start data that appears orphaned** (A-F) on its original row, now missing the linked end data
3. These are **presentation issues** — the actual break records in SQLite are complete

### 7.2 Severity by Scenario

| Scenario | Data Lost? | Recovery | Severity |
|----------|:---------:|----------|:--------:|
| Primary path: `deleteDimension` + "exceeds grid limits" | **Start data lost from sheet** | `google_sheet_row = 0` → auto-heals on retry | **Medium** (auto-recovered) |
| Fallback path: empty-row write | **Start AND end columns lost for the break** | No auto-recovery, `google_sheet_row` stays stale | **High** (silent, no recovery) |
| Reconcile overwrite | No data lost, but wrong row mapping | Next archive run re-fixes | **Low** (temporary) |
| `recalculateSheetRows` skip | No data lost, but wrong row mapping | Only fixed if archive re-runs | **Low-Medium** |

### 7.3 Can Existing Breaks Be Affected?

**Yes, any break that was synced DURING an archive window is at risk.** The window is approximately **180 seconds** per archive attempt. The risk increases if:

- The archive repeatedly times out (as it has been — 180s timeout, multiple retries)
- The fallback empty-row path is triggered
- The sync worker is under heavy load (more breaks, higher chance of overlap)

---

## 8. Deliverables

### 8.1 Root Cause

**Primary:** Race condition between archive worker and sync worker. The archive rewrites the CS BREAK sheet while the sync worker appends new breaks. The appended breaks are deleted by `deleteDimension` or overwritten by the empty-row fallback. Their `google_sheet_row` becomes stale, causing end-break writes to land on the wrong row.

**Secondary:** The archive's empty-row fallback silently corrupts data without triggering the "exceeds grid limits" error handler. The sync worker has no mechanism to detect this silent corruption.

### 8.2 Affected Files

- `src/sync-worker.js`
- `src/archive-worker.js`
- `src/break-db.js` (indirectly — `google_sheet_row` is the vulnerability point)

### 8.3 Affected Functions

| Function | File | Risk |
|----------|------|:----:|
| `syncStartBreak()` | sync-worker.js | **High** — appends during archive window |
| `syncEndBreak()` | sync-worker.js | **High** — writes to stale `google_sheet_row` |
| `processSyncQueue()` | sync-worker.js | **High** — error handler misses silent fallback |
| `runArchive()` | archive-worker.js | **High** — empty-row fallback causes silent corruption |
| `recalculateSheetRows()` | archive-worker.js | **Medium** — skips breaks outside `rowsToKeep` |

### 8.4 Risk Level

**Overall: HIGH**

The issue has likely already affected production data. The archive has been timing out repeatedly (as documented in previous investigations), and each failed archive attempt creates a 180-second window during which the race can occur.

### 8.5 Recommended Fix (High-Level)

**Fix 1 — Pause sync worker during archive (Critical):**
Introduce a shared mutex/lock between workers. Before the archive rewrites CS BREAK, pause the sync worker. After the archive completes (including `recalculateSheetRows`), resume the sync worker. This eliminates the race condition at the source.

**Fix 2 — Detect and reset stale google_sheet_row (Critical):**
In `syncEndBreak()`, before writing, verify that the target row in the sheet contains the expected `break_id` (column N). If it doesn't match, reset `google_sheet_row = 0` and re-run the sync as a fallback append. This catches both the "exceeds grid limits" case AND the silent fallback case.

**Fix 3 — Replace the archive's empty-row fallback (Medium):**
Instead of writing 999 empty rows, use a targeted `deleteDimension` with proper error handling. If `deleteDimension` fails, log the error and skip the cleanup — the extra rows are harmless and will be cleaned up in the next archive cycle.

**Fix 4 — Cross-validate google_sheet_row during reconcile (Medium):**
During reconciliation, after computing `match.sheetRow`, read column N from the target row and compare it with the SQLite `break_id`. If they don't match, the row mapping is wrong and should be corrected.

### 8.6 Recommended Order

1. **Fix 2** (detect stale `google_sheet_row` in `syncEndBreak`) — Most impactful, protects against ALL scenarios
2. **Fix 3** (replace archive empty-row fallback) — Prevents the silent corruption path
3. **Fix 1** (pause sync during archive) — Architectural fix, eliminates root cause
4. **Fix 4** (cross-validate during reconcile) — Defensive check, catches any remaining mismatches

---

*Investigation completed 2026-07-29. Based on commit `8f87a7c`.*  
*No code was modified during this investigation.*

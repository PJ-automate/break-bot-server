/**
 * archive-worker.js — Automatically archives old break data from CS BREAK sheet
 * to ARCHIVE sheet after midnight. Runs on a scheduled interval.
 *
 * FIXED July 2026:
 *  - Serial number dates handled correctly (not just YYYY-MM-DD strings)
 *  - All CS BREAK writes use RAW input to prevent date-to-serial conversion
 *  - Off-by-one error in Archives append fixed
 *  - ssId scope bug in cleanup calls fixed
 *  - Same date comparison fix applied to cleanupDailySummary and cleanupArchives
 *
 * FIXED July 5, 2026 — PERMANENT ARCHIVE FIX:
 *  - ROOT CAUSE: lastArchivedDate was SET BEFORE Google Sheets writes succeeded.
 *    If a write failed (quota, timeout), lastArchivedDate was already updated to the
 *    new day's date and ALL subsequent archive attempts for that day were skipped.
 *  - FIX: lastArchivedDate is now set ONLY AFTER all write operations succeed.
 *    On failure, lastArchivedDate is NOT updated, so the next 15-min interval retries.
 *  - FIX: Added retry-on-failure — clears `lastArchivedDate` so next interval re-attempts.
 *  - FIX: Broadened window — also triggers archive outside midnight window if old rows
 *    exist in CS BREAK (handles PM2 restarts at any time).
 *  - FIX: Comprehensive detailed logging with PH timestamps for every step.
 */
'use strict';

const CONFIG = require('./config');
const { readRange, getOrCreateSheet, updateRange, breakAppendRow, breakUpdateRange, breakBatchUpdate, formatBreakSheets } = require('./google');
const { google } = require("googleapis");
const key = require(CONFIG.breakServiceAccountPath);

// Lazy-init sheets client for grid expansion
let _gridSheets = null;
async function _getGridSheets() {
  if (_gridSheets) return _gridSheets;
  const auth = new google.auth.GoogleAuth({ credentials: key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  _gridSheets = google.sheets({ version: "v4", auth });
  return _gridSheets;
}

/**
 * Expand Archives sheet grid if it doesn't have enough rows.
 */
async function ensureArchiveGrid(ssId, neededRows) {
  try {
    const sheets = await _getGridSheets();
    const ss = await sheets.spreadsheets.get({ spreadsheetId: ssId });
    const archSheet = ss.data.sheets.find(function(s) { return s.properties.title.toUpperCase() === "ARCHIVES"; });
    if (!archSheet) return;
    const currentRows = archSheet.properties.gridProperties.rowCount || 0;
    if (neededRows > currentRows) {
      const addRows = neededRows - currentRows;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: ssId,
        requestBody: {
          requests: [{
            appendDimension: {
              sheetId: archSheet.properties.sheetId,
              dimension: "ROWS",
              length: addRows
            }
          }]
        }
      });
      console.log('[ArchiveWorker] Expanded Archives grid by ' + addRows + ' rows (was ' + currentRows + ', now ' + neededRows + ')');
    }
  } catch(e) {
    console.warn('[ArchiveWorker] Grid expansion warning:', e.message);
  }
}

/**
 * Get current PH time as a formatted log prefix: "YYYY-MM-DD HH:MM:SS PH"
 */
function _logTimestamp() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour12: false });
  return '[' + dateStr + ' ' + timeStr + ' PH]';
}

// Track the last date we SUCCESSFULLY archived (YYYY-MM-DD)
// IMPORTANT: This is ONLY set after ALL Google Sheets writes succeed.
// If a write fails, this is NOT updated, so the next interval retries.
let lastArchivedDate = null;
let running = false;

// Track whether auto-close already ran today (runs once per day to avoid redundant SQLite writes)
let autoCloseToday = '';

/**
 * Get today's date in PH time as YYYY-MM-DD string.
 */
function getPHDateStr() {
  // en-CA locale formats as YYYY-MM-DD — handles timezone correctly
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

/**
 * Get PH time hours and minutes for checking midnight crossover.
 */
function getPHTimeComponents() {
  const now = new Date();
  const phDateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const phTimeStr = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour12: false });
  const parts = phTimeStr.split(':');
  return {
    hours: parseInt(parts[0], 10),
    minutes: parseInt(parts[1], 10),
    dateStr: phDateStr
  };
}

/**
 * Convert a Google Sheets cell value to a YYYY-MM-DD date string.
 * Handles:
 *  - Date strings already in YYYY-MM-DD format ("2026-07-04")
 *  - Google Sheets serial numbers (46207 = July 4, 2026)
 *  - Date strings in other formats (parseable by Date constructor)
 *  - Empty/null values (returns empty string)
 *
 * Google Sheets stores dates as serial numbers: days since Dec 30, 1899.
 * Serial 46207 = July 4, 2026 (46207 days after Dec 30, 1899).
 * The conversion formula: Date = (serial - 25569) * 86400000 ms.
 */
function cellToDateStr(value) {
  if (value === null || value === undefined || value === '') return '';

  // Case 1: Already a YYYY-MM-DD string — fast path
  var str = String(value).trim();
  var match = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];

  // Case 2: Google Sheets serial number (stored as number or numeric string)
  var num = Number(value);
  if (!isNaN(num) && Number.isFinite(num)) {
    // Sanity check: valid serial dates are in a known range
    // Serial 40000 ≈ June 2009, 55000 ≈ August 2050
    if (num > 40000 && num < 55000) {
      // Excel/Sheets epoch: Dec 30, 1899 = serial 0
      // Unix epoch: Jan 1, 1970 = serial 25569
      var d = new Date((num - 25569) * 86400000);
      return d.toISOString().substring(0, 10);
    }
    // Also handle smaller serials (time-only values or near-epoch)
    if (num > 0 && num < 1) return ''; // time-only value, skip
  }

  // Case 3: Try parsing as a generic date string
  var parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  }

  return str; // fallback — return as-is
}

/**
 * Normalize the date column (index 0) in a 2D array of rows to YYYY-MM-DD strings.
 * Mutates rows in-place and returns the array for chaining.
 */
function normalizeDates(rows) {
  if (!rows || rows.length === 0) return rows;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i][0]) {
      rows[i][0] = cellToDateStr(rows[i][0]);
    }
  }
  return rows;
}

/**
 * Archive old data from CS BREAK sheet to ARCHIVE sheet.
 * Moves any rows whose date is before today's PH date.
 *
 * CRITICAL FIX: lastArchivedDate is only set AFTER all writes succeed.
 * If any write fails, lastArchivedDate is NOT updated, so the next
 * 15-min interval will retry the archive.
 */
async function runArchive() {
  const ts = _logTimestamp();
  if (running) {
    console.log(ts + ' [ArchiveWorker] Archive already in progress, skipping');
    return;
  }
  running = true;

  // ssId declared HERE (outside try) so cleanup calls below can access it
  const ssId = CONFIG.breakSheetId;

  try {
    if (!ssId) throw new Error('breakSheetId not configured');

    const todayStr = getPHDateStr();

    // ============================================================
    //  STEP 0: Auto-close stale breaks from previous business dates
    //  Run BEFORE archive so ended breaks get archived correctly.
    // ============================================================
    try {
      await autoCloseStaleBreaks();
    } catch (acErr) {
      console.warn(ts + ' [ArchiveWorker] Auto-close warning (non-fatal): ' + acErr.message);
    }
    // Restore lastArchivedDate from SQLite (persists across PM2 restarts)
    try {
      var db = require('./break-db');
      var storedDate = db.getSetting('lastArchivedDate');
      if (storedDate && storedDate !== todayStr) {
        console.log(ts + ' [ArchiveWorker] Restored lastArchivedDate from SQLite: ' + storedDate);
        lastArchivedDate = storedDate;
      }
    } catch(e) {}
    console.log(ts + ' [ArchiveWorker] === ARCHIVE JOB START ===');
    console.log(ts + ' [ArchiveWorker] Timezone: Asia/Manila');
    console.log(ts + ' [ArchiveWorker] Today PH date: ' + todayStr);
    console.log(ts + ' [ArchiveWorker] Last archived date: ' + (lastArchivedDate || '(never)'));

    // Skip if already successfully archived today
    if (lastArchivedDate === todayStr) {
      console.log(ts + ' [ArchiveWorker] Already archived today, skipping');
      running = false;
      return;
    }

    console.log(ts + ' [ArchiveWorker] Checking CS BREAK for old data...');

    // Read all data from CS BREAK sheet
    const data = await readRange(ssId, 'CS BREAK!A:O');
    if (!data || data.length < 2) {
      console.log(ts + ' [ArchiveWorker] No data rows in CS BREAK (0 rows to archive)');
      // Mark as archived so we don't keep checking on every interval
      lastArchivedDate = todayStr;
    try { require('./break-db').setSetting('lastArchivedDate', todayStr); } catch(e) {}
      console.log(ts + ' [ArchiveWorker] === ARCHIVE JOB COMPLETE (no data) ===');
      running = false;
      return;
    }

    console.log(ts + ' [ArchiveWorker] Total rows in CS BREAK: ' + data.length + ' (including header)');

    // Identify rows to move (date before today)
    const rowsToMove = [];
    const rowsToKeep = [data[0]]; // Header row stays

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      // Skip completely empty rows (all blank cells) — don't preserve them
      if (!row || row.every(function(cell) { return !cell && cell !== 0; })) continue;

      // Rows with no date value get archived (they're incomplete/error rows)
      if (!row[0]) { rowsToMove.push(row); continue; }

      // Normalize date to YYYY-MM-DD for comparison
      var rowDateStr = cellToDateStr(row[0]);
      if (!rowDateStr) { rowsToKeep.push(row); continue; } // Unparseable = keep

      // Compare: if row date is before today, archive it
      if (rowDateStr < todayStr) {
        rowsToMove.push(row);
      } else {
        rowsToKeep.push(row);
      }
    }

    console.log(ts + ' [ArchiveWorker] Rows to archive (before today): ' + rowsToMove.length);
    console.log(ts + ' [ArchiveWorker] Rows to keep (today or future): ' + (rowsToKeep.length - 1) + ' + header');

    if (rowsToMove.length === 0) {
      console.log(ts + ' [ArchiveWorker] No old data to archive (all rows are from today ' + todayStr + ')');
      lastArchivedDate = todayStr;
    try { require('./break-db').setSetting('lastArchivedDate', todayStr); } catch(e) {}
      console.log(ts + ' [ArchiveWorker] === ARCHIVE JOB COMPLETE (no data to move) ===');
      running = false;
      return;
    }

    console.log(ts + ' [ArchiveWorker] Moving ' + rowsToMove.length + ' rows to Archives...');

    // Ensure Archives sheet exists
    await getOrCreateSheet(ssId, "ARCHIVES");

    // Normalize dates before writing
    normalizeDates(rowsToMove);
    normalizeDates(rowsToKeep);

    // ============================================================
    //  WRITE TO ARCHIVES SHEET — use APPEND, no read needed
    // ============================================================
    console.log(ts + ' [ArchiveWorker] Appending ' + rowsToMove.length + ' rows to Archives...');

    // Ensure Archives sheet exists (uses getOrCreateSheet with error handling)
    await getOrCreateSheet(ssId, "ARCHIVES");

    // Write header + all rows using breakAppendRow (auto-finds next empty row)
    // First write header if Archives might be empty
    try {
      await breakAppendRow(ssId, "'Archives'!A:O", rowsToMove);
      console.log(ts + ' [ArchiveWorker] ✓ Appended ' + rowsToMove.length + ' rows to Archives via append API');
    } catch (appendErr) {
      console.warn(ts + ' [ArchiveWorker] Append failed (' + appendErr.message + '), trying update with grid expansion...');
      // Fallback: try to read just the first column to determine row count
      var archCount = [];
      try {
        var archColA = await readRange(ssId, "'Archives'!A:A");
        if (archColA) archCount = archColA;
      } catch(e) {}
      var startRow2 = (archCount && archCount.length > 0) ? archCount.length + 1 : 2;
      var endRow3 = startRow2 + rowsToMove.length - 1;
      await ensureArchiveGrid(ssId, endRow3 + 5);
      await breakUpdateRange(ssId, "'Archives'!A" + startRow2 + ":O" + endRow3, rowsToMove);
      console.log(ts + ' [ArchiveWorker] ✓ Appended ' + rowsToMove.length + ' rows to Archives via fallback (A' + startRow2 + ':O' + endRow3 + ')');
    }

    // ============================================================
    //  REWRITE CS BREAK SHEET with only today's data
    // ============================================================
    console.log(ts + ' [ArchiveWorker] Rewriting CS BREAK with ' + rowsToKeep.length + ' rows...');

    if (rowsToKeep.length > 0) {
      await breakUpdateRange(ssId, "'CS BREAK'!A1:O" + rowsToKeep.length, rowsToKeep);
      console.log(ts + ' [ArchiveWorker] ✓ Rewrote CS BREAK with ' + rowsToKeep.length + ' rows (RAW mode)');

      // Delete rows beyond what we wrote — removes old data from the grid
      try {
        var gsheets2 = google.sheets({
          version: "v4",
          auth: new google.auth.GoogleAuth({
            credentials: key,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"]
          })
        });
        var ssInfo = await gsheets2.spreadsheets.get({ spreadsheetId: ssId });
        var csSheet = ssInfo.data.sheets.find(function(s) { return s.properties.title === "CS BREAK"; });
        if (csSheet) {
          var totalRows = csSheet.properties.gridProperties.rowCount || 1000;
          var startDelete = rowsToKeep.length; // delete from first row past kept data

          // Safety: never delete row 0 (header), and only delete if there are rows to remove
          if (startDelete < totalRows) {
            // Google Sheets requires at least 1 non-frozen row; if only header remains,
            // delete from row 1 (0-indexed) which is row 2 in the sheet UI.
            // This leaves the header (row 0) intact.
            if (startDelete < 1) startDelete = 1;

            await gsheets2.spreadsheets.batchUpdate({
              spreadsheetId: ssId,
              requestBody: {
                requests: [{
                  deleteDimension: {
                    range: {
                      sheetId: csSheet.properties.sheetId,
                      dimension: "ROWS",
                      startIndex: startDelete,
                      endIndex: totalRows
                    }
                  }
                }]
              }
            });
            console.log(ts + ' [ArchiveWorker] ✓ Deleted ' + (totalRows - startDelete) + ' excess rows from CS BREAK (kept ' + rowsToKeep.length + ')');
          }
        }
      } catch(e) {
        console.warn(ts + ' [ArchiveWorker] Row cleanup warning (non-fatal): ' + e.message);
        // Fallback: clear residual data if delete fails
        try {
          await breakUpdateRange(ssId, "'CS BREAK'!A2:O1000", Array(999).fill(['','','','','','','','','','','','','','','']));
          console.log(ts + ' [ArchiveWorker] ✓ Fallback: cleared rows 2-1000 via empty write');
        } catch(e2) {}
      }
    }

    // ============================================================
    //  RECALCULATE google_sheet_row for all kept breaks
    //  After archive rewrites CS BREAK, the old row numbers in SQLite
    //  are stale. This updates them to match the new positions.
    // ============================================================
    try {
      var rowCount = recalculateSheetRows(rowsToKeep);
      console.log(ts + ' [ArchiveWorker] ✓ Recalculated google_sheet_row for ' + rowCount + ' breaks');
    } catch (recalcErr) {
      console.warn(ts + ' [ArchiveWorker] Row recalculation warning (non-fatal): ' + recalcErr.message);
    }

    // ============================================================
    //  ALL WRITES SUCCEEDED — NOW mark as archived for today
    // ============================================================
    lastArchivedDate = todayStr;
    try { require('./break-db').setSetting('lastArchivedDate', todayStr); } catch(e) {}
    console.log(ts + ' [ArchiveWorker] ✅ MARKED: lastArchivedDate = ' + todayStr);

    // Re-apply professional formatting to all sheets
    try {
      await formatBreakSheets(ssId);
      console.log(ts + ' [ArchiveWorker] ✓ Formatting re-applied');
    } catch (fmtErr) {
      console.warn(ts + ' [ArchiveWorker] Formatting error (non-fatal): ' + fmtErr.message);
    }

    // Rebuild daily_summary_cache from fresh sheet data (rows shifted after archive)
    try {
      var db = require('./break-db');
      var freshData = await readRange(ssId, 'DAILY SUMMARY!A:E');
      if (freshData && freshData.length > 1) {
        var imported = db.importSummaryCacheFromSheet(freshData);
        console.log(ts + ' [ArchiveWorker] ✓ Rebuilt daily_summary_cache: ' + imported + ' entries');
      } else {
        db.clearSummaryCache();
        console.log(ts + ' [ArchiveWorker] ✓ Cleared daily_summary_cache (no summary data)');
      }
    } catch (dsErr) {
      console.warn(ts + ' [ArchiveWorker] Summary cache rebuild warning (non-fatal): ' + dsErr.message);
    }


    console.log(ts + ' [ArchiveWorker] === ARCHIVE JOB COMPLETE ===');
    console.log(ts + ' [ArchiveWorker] ✅ Archived ' + rowsToMove.length + ' rows into Archives. CS BREAK now has ' + rowsToKeep.length + ' rows.');

  } catch (err) {
    console.error(ts + ' [ArchiveWorker] ❌ ARCHIVE ERROR:', err.message);
    console.error(ts + ' [ArchiveWorker] lastArchivedDate was NOT updated — archive will retry in 15 min');
    // CRITICAL: Do NOT set lastArchivedDate on error.
    // The next 15-min interval will retry the archive.
    // The `running` flag is released after cleanup below.
  }

  // After archive (success or failure): clean up old records from DAILY SUMMARY and Archives
  // ssId is accessible here because it was declared outside the try block
  try {
    var dsCount = await cleanupDailySummary(ssId);
    if (dsCount > 0) console.log('[ArchiveWorker] Cleanup: removed ' + dsCount + ' old rows from DAILY SUMMARY');
  } catch(e) {
    console.error('[ArchiveWorker] Daily summary cleanup error:', e.message);
  }

  try {
    var archCount = await cleanupArchives(ssId);
    if (archCount > 0) console.log('[ArchiveWorker] Cleanup: removed ' + archCount + ' old rows from Archives cleanup');
  } catch(e) {
    console.error('[ArchiveWorker] Archives cleanup error:', e.message);
  }

  running = false;
}

/**
 * Get date string N days ago in PH timezone as YYYY-MM-DD.
 */
function getDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

/**
 * Delete excess rows from a sheet after rewriting (reduces grid size).
 */
async function deleteExcessRows(ssId, sheetName, keepCount) {
  try {
    const { google } = require("googleapis");
    const key = require(CONFIG.breakServiceAccountPath);
    const auth = new google.auth.GoogleAuth({ credentials: key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const gsheets = google.sheets({ version: "v4", auth });
    const ssInfo = await gsheets.spreadsheets.get({ spreadsheetId: ssId });
    const sheet = ssInfo.data.sheets.find(function(s) { return s.properties.title === sheetName; });
    if (sheet) {
      const totalRows = sheet.properties.gridProperties.rowCount || 1000;
      if (keepCount < totalRows) {
        await gsheets.spreadsheets.batchUpdate({
          spreadsheetId: ssId,
          requestBody: {
            requests: [{
              deleteDimension: {
                range: { sheetId: sheet.properties.sheetId, dimension: "ROWS", startIndex: keepCount, endIndex: totalRows }
              }
            }]
          }
        });
      }
    }
  } catch(e) {
    // Non-fatal
  }
}

/**
 * Clean up DAILY SUMMARY — keep only last 30 days of data.
 * Deletes rows where date is older than 30 days from today (PH time).
 */
async function cleanupDailySummary(ssId) {
  try {
    const data = await readRange(ssId, 'DAILY SUMMARY!A:E');
    if (!data || data.length < 2) return 0;

    const cutoffDate = getDateDaysAgo(30);
    const header = data[0];
    const rowsToKeep = [header];
    let deletedCount = 0;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[0]) { rowsToKeep.push(row); continue; }
      const rowDateStr = cellToDateStr(row[0]);
      if (!rowDateStr) { rowsToKeep.push(row); continue; }
      if (rowDateStr >= cutoffDate) {
        rowsToKeep.push(row);
      } else {
        deletedCount++;
      }
    }

    if (deletedCount === 0) return 0;

    // Always enforce correct header — prevents data from corrupting row 1
    rowsToKeep[0] = ['Date','User','Shift','Total Used','Remaining'];
    normalizeDates(rowsToKeep);
    await breakUpdateRange(ssId, "'DAILY SUMMARY'!A1:E" + rowsToKeep.length, rowsToKeep);
    await deleteExcessRows(ssId, 'DAILY SUMMARY', rowsToKeep.length);
    console.log('[ArchiveWorker] ✅ DAILY SUMMARY cleanup: removed ' + deletedCount + ' rows older than ' + cutoffDate);
    return deletedCount;
  } catch (err) {
    console.error('[ArchiveWorker] DAILY SUMMARY cleanup error:', err.message);
    return 0;
  }
}

/**
 * Clean up Archives — keep only last 1 month of data.
 * Deletes rows where date is older than 30 days from today (PH time).
 */
async function cleanupArchives(ssId) {
  try {
    const data = await readRange(ssId, "'Archives'!A:O");
    if (!data || data.length < 2) return 0;

    const cutoffDate = getDateDaysAgo(30);
    const header = data[0];
    const rowsToKeep = [header];
    let deletedCount = 0;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[0]) { rowsToKeep.push(row); continue; }
      const rowDateStr = cellToDateStr(row[0]);
      if (!rowDateStr) { rowsToKeep.push(row); continue; }
      if (rowDateStr >= cutoffDate) {
        rowsToKeep.push(row);
      } else {
        deletedCount++;
      }
    }

    if (deletedCount === 0) return 0;

    normalizeDates(rowsToKeep);
    await ensureArchiveGrid(ssId, rowsToKeep.length + 5);
    await breakUpdateRange(ssId, "'Archives'!A1:O" + rowsToKeep.length, rowsToKeep);
    await deleteExcessRows(ssId, 'ARCHIVES', rowsToKeep.length);
    console.log('[ArchiveWorker] ✅ Archives cleanup: removed ' + deletedCount + ' rows older than ' + cutoffDate);
    return deletedCount;
  } catch (err) {
    console.error('[ArchiveWorker] Archives cleanup error:', err.message);
    return 0;
  }
}

// ============================================================
//  AUTO-CLOSE: End stale ON BREAK records from previous days
// ============================================================

/**
 * Auto-close breaks that are still ON BREAK from previous business dates.
 * These breaks were never ended via /end command and are still marked
 * as active in SQLite. The GS rows have already been archived.
 *
 * This runs before archive to ensure:
 *  1. Dashboard stops showing them as active
 *  2. Archive moves the completed breaks to ARCHIVES
 *  3. Total used is properly calculated for the correct business date
 *
 * Uses endBreakAuto() which does NOT queue a GS sync (rows already archived).
 */
async function autoCloseStaleBreaks() {
  const ts = _logTimestamp();
  const todayStr = getPHDateStr();

  // Skip if already ran today
  if (autoCloseToday === todayStr) return;

  var db = require('./break-db');
  var staleBreaks = db.getStaleActiveBreaks(todayStr);

  if (!staleBreaks || staleBreaks.length === 0) {
    autoCloseToday = todayStr;
    return;
  }

  console.log(ts + ' [ArchiveWorker] Auto-closing ' + staleBreaks.length + ' stale break(s) from previous date(s)...');

  for (var i = 0; i < staleBreaks.length; i++) {
    var b = staleBreaks[i];
    try {
      // Close at 23:59:59 of the business date (end of shift)
      var result = db.endBreakAuto(b, '23:59:59');
      if (result) {
        console.log(ts + ' [ArchiveWorker] ✓ Auto-closed #' + b.id + ' ' + b.user_name + ' (' + b.break_type + ' ' + b.start_time + ') → ' + result.curHMS + ' ' + (result.remark || ''));
      }
    } catch (err) {
      console.warn(ts + ' [ArchiveWorker] Auto-close failed for #' + b.id + ': ' + err.message);
    }
  }

  autoCloseToday = todayStr;
  console.log(ts + ' [ArchiveWorker] Auto-close complete. Closed ' + staleBreaks.length + ' stale break(s).');
}

// ============================================================
//  ROW RECALCULATION: Fix stale google_sheet_row after archive
// ============================================================

/**
 * After archive rewrites CS BREAK with only today's rows, the
 * google_sheet_row values in SQLite are stale (they pointed to
 * pre-archive positions). This function recalculates them by
 * matching break_id (column N) with the new row positions.
 *
 * @param {Array} rowsToKeep — rows that remain in CS BREAK after archive
 * @returns {number} count of rows updated
 */
function recalculateSheetRows(rowsToKeep) {
  var db = require('./break-db');
  var count = 0;

  // rowsToKeep[0] = header, data starts at rowsToKeep[1]
  // Sheet row = index + 1 (1-indexed, row 1 = header)
  for (var i = 1; i < rowsToKeep.length; i++) {
    var row = rowsToKeep[i];
    if (!row || !row[13]) continue; // column N = break_id
    var breakId = String(row[13]).trim();
    if (!breakId) continue;
    var sheetRow = i + 1; // sheet row number

    try {
      db.updateSheetRow(breakId, sheetRow);
      count++;
    } catch (e) {
      // Break might not exist in SQLite (legacy/migrated data)
    }
  }

  return count;
}

// ============================================================
//  REVERSE SYNC: Reconcile breaks ended via GS Break Tools
// ============================================================

/**
 * Reverse-sync: Check if any breaks that are ON BREAK in SQLite have been
 * manually ended in Google Sheets (via Break Tools or direct editing).
 * If found, update SQLite to match the sheet.
 *
 * This solves the problem where a manager uses the GS Break Tools menu
 * to end a break, but the Node.js bot still shows it as active because
 * the bot's SQLite never received the update.
 *
 * Runs periodically alongside the archive check (every 15 min).
 */
async function reconcileActiveBreaks() {
  const ts = _logTimestamp();
  var db = require('./break-db');

  // Get all active breaks from SQLite
  var activeBreaks = db.getAllActiveBreaks();
  if (!activeBreaks || activeBreaks.length === 0) return;

  // Read current CS BREAK sheet data (only need columns M, G, H, I, J, L, N)
  var data;
  try {
    data = await readRange(CONFIG.breakSheetId, 'CS BREAK!A:O');
  } catch (e) {
    console.warn(ts + ' [ArchiveWorker] Reconcile read error: ' + e.message);
    return;
  }
  if (!data || data.length < 2) return;

  // Build break_id → sheet row map
  var sheetMap = {};
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row && row[13]) {
      sheetMap[String(row[13]).trim()] = { sheetRow: i + 1, data: row };
    }
  }

  var reconciled = 0;
  for (var b = 0; b < activeBreaks.length; b++) {
    var br = activeBreaks[b];
    var match = sheetMap[br.break_id];
    if (!match) continue;

    var sheetStatus = String(match.data[12] || '').trim();
    // Sheet shows ended but SQLite says active → reconcile
    if (sheetStatus.indexOf('RETURNED') >= 0 || sheetStatus.indexOf('OVERBREAK') >= 0 || sheetStatus.indexOf('LONG BREAK') >= 0) {
      var endTime = String(match.data[6] || '').trim();
      var durationHMS = String(match.data[7] || '').trim();
      var remaining = String(match.data[8] || '').trim();
      var remark = String(match.data[9] || '').trim();
      var totalUsed = String(match.data[11] || '').trim();
      var sheetRow = match.sheetRow;

      // Parse duration_hms ("0:02:05" or "00:02:05") to seconds
      var durParts = durationHMS.split(':').map(Number);
      var durSecs = (durParts[0] || 0) * 3600 + (durParts[1] || 0) * 60 + (durParts[2] || 0);

      try {
        db.getDB().prepare(`
          UPDATE breaks SET end_time = ?, duration_hms = ?, duration_secs = ?,
            remaining = ?, remark = ?, total_used_hms = ?, google_sheet_row = ?,
            status = 'ENDED', sync_status = 'synced'
          WHERE id = ? AND status = 'ON BREAK'
        `).run(endTime, durationHMS, durSecs, remaining, remark, totalUsed, sheetRow, br.id);

        // Also update daily_summary_cache
        var shiftKey = br.shift_type + ' (' + br.shift_period + ')';
        try {
          db.getDB().prepare(`
            INSERT INTO daily_summary_cache (business_date, user_name, shift_key, sheet_row, total_used, remaining)
            VALUES (?, ?, ?, -1, ?, ?)
            ON CONFLICT(business_date, user_name, shift_key) DO UPDATE SET
              total_used = excluded.total_used, remaining = excluded.remaining,
              updated_at = datetime('now', 'localtime')
          `).run(br.business_date, br.user_name, shiftKey, totalUsed, remaining);
        } catch (dsErr) {}

        reconciled++;
        console.log(ts + ' [ArchiveWorker] ✓ Reconciled #' + br.id + ' ' + br.user_name +
          ' (sheet: ' + sheetStatus + ' end:' + endTime + ' dur:' + durationHMS + ')');
      } catch (updateErr) {
        console.warn(ts + ' [ArchiveWorker] Reconcile update failed for #' + br.id + ': ' + updateErr.message);
      }
    }
  }

  if (reconciled > 0) {
    console.log(ts + ' [ArchiveWorker] ✅ Reverse-sync complete: ' + reconciled + ' break(s) reconciled from GS to SQLite');
  }
}

/**
 * Count how many rows in CS BREAK have dates before today.
 * Used to trigger archive outside the midnight window (e.g. after PM2 restart).
 */
async function hasOldDataToArchive() {
  try {
    const data = await readRange(CONFIG.breakSheetId, 'CS BREAK!A:A');
    if (!data || data.length < 2) return false;

    const todayStr = getPHDateStr();
    // Restore lastArchivedDate from SQLite (persists across PM2 restarts)
    try {
      var db = require('./break-db');
      var storedDate = db.getSetting('lastArchivedDate');
      if (storedDate && storedDate !== todayStr) {
        console.log(ts + ' [ArchiveWorker] Restored lastArchivedDate from SQLite: ' + storedDate);
        lastArchivedDate = storedDate;
      }
    } catch(e) {}
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!row || !row[0]) continue;
      var rowDateStr = cellToDateStr(row[0]);
      if (rowDateStr && rowDateStr < todayStr) return true;
    }
    return false;
  } catch (err) {
    console.warn('[ArchiveWorker] hasOldDataToArchive error:', err.message);
    return false;
  }
}

/**
 * Check if midnight has passed and trigger archive if needed.
 * Runs every 15 minutes to catch midnight crossover.
 *
 * FIXED: Now also triggers if old data exists in CS BREAK at any time,
 * not just in the midnight window. This handles PM2 restarts, failed
 * archive retries, and server downtime.
 */
async function scheduledCheck() {
  try {
    const { hours, minutes, dateStr } = getPHTimeComponents();
    const ts = _logTimestamp();

    // Run auto-close for stale breaks from previous days (guarded internally by autoCloseToday)
    try {
      await autoCloseStaleBreaks();
    } catch (acErr) {
      console.warn(ts + ' [ArchiveWorker] Auto-close check warning: ' + acErr.message);
    }

    // Reverse-sync: reconcile breaks ended via GS Break Tools but still ON BREAK in SQLite
    try {
      await reconcileActiveBreaks();
    } catch (rcErr) {
      console.warn(ts + ' [ArchiveWorker] Reconcile warning: ' + rcErr.message);
    }

    // Skip if already successfully archived today
    if (lastArchivedDate === dateStr) {
      return; // silently skip — no log noise on every 15-min tick
    }

    // Primary trigger: midnight window (00:00-00:30 PH time)
    var isMidnightWindow = (hours === 0 && minutes <= 30);

    // Backup trigger: first run / after failure (lastArchivedDate is null)
    var isFirstRun = !lastArchivedDate;

    if (isMidnightWindow || isFirstRun) {
      if (isMidnightWindow) {
        console.log(ts + ' [ArchiveWorker] Midnight window detected (' + hours + ':' + minutes + ' PH), running archive...');
      } else {
        console.log(ts + ' [ArchiveWorker] First run / retry (lastArchivedDate was ' + lastArchivedDate + '), checking for old data...');
      }
      await runArchive();
      return;
    }

    // FIX: Secondary trigger — check for old data even outside midnight window.
    // This handles scenarios where:
    //  - PM2 restarted after the midnight window passed
    //  - Previous archive attempt failed but lastArchivedDate was NOT updated
    //    (actually in that case lastArchivedDate is null, which isFirstRun catches)
    //  - Server was down during midnight window
    // This is a lightweight check (reads only column A) once per interval.
    // Only check if we haven't already archived today.
    if (lastArchivedDate !== dateStr) {
      var hasOldData = await hasOldDataToArchive();
      if (hasOldData) {
        console.log(ts + ' [ArchiveWorker] Found old data in CS BREAK outside midnight window — running archive...');
        await runArchive();
      }
    }

  } catch (err) {
    console.error('[ArchiveWorker] Scheduled check error:', err.message);
  }
}

/**
 * Start the archive worker.
 * @param {number} intervalMs - Check interval in ms (default: 15 min)
 */
function startArchiveWorker(intervalMs) {
  intervalMs = intervalMs || 900000; // default: every 15 minutes
  const ts = _logTimestamp();
  console.log(ts + ' [ArchiveWorker] Started (interval: ' + (intervalMs / 1000) + 's)');

  // Restore lastArchivedDate from SQLite so it survives PM2 restarts
  // Must happen BEFORE scheduledCheck() to prevent redundant archive runs
  try {
    var db = require('./break-db');
    if (typeof db.getSetting === 'function') {
      var storedArchived = db.getSetting('lastArchivedDate');
      if (storedArchived) {
        lastArchivedDate = storedArchived;
        console.log(ts + ' [ArchiveWorker] Restored lastArchivedDate from SQLite: ' + storedArchived);
      }
    }
  } catch(e) {}

  // Run immediately on startup
  scheduledCheck().catch(function() {});

  // Then every N ms
  return setInterval(function() {
    scheduledCheck().catch(function() {});
  }, intervalMs);
}

module.exports = {
  startArchiveWorker,
  runArchive,
  getPHDateStr,
  cleanupDailySummary,
  cleanupArchives
};

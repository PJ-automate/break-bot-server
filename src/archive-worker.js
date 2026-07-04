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
 */
'use strict';

const CONFIG = require('./config');
const { readRange, getOrCreateSheet, updateRange, breakUpdateRange, breakBatchUpdate, formatBreakSheets } = require('./google');
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
    const archSheet = ss.data.sheets.find(function(s) { return s.properties.title === "Archives"; });
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
      console.log("[ArchiveWorker] Expanded Archives grid by " + addRows + " rows (was " + currentRows + ", now " + neededRows + ")");
    }
  } catch(e) {
    console.warn("[ArchiveWorker] Grid expansion warning:", e.message);
  }
}


// Track the last date we checked (YYYY-MM-DD) to avoid re-archiving
let lastArchivedDate = null;
let running = false;

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
 */
async function runArchive() {
  if (running) return;
  running = true;

  // ssId declared HERE (outside try) so cleanup calls below can access it
  const ssId = CONFIG.breakSheetId;

  try {
    if (!ssId) throw new Error('breakSheetId not configured');

    const todayStr = getPHDateStr();

    // Skip if already archived today
    if (lastArchivedDate === todayStr) {
      running = false;
      return;
    }

    console.log('[ArchiveWorker] Checking CS BREAK for old data...');

    // Read all data from CS BREAK sheet
    const data = await readRange(ssId, 'CS BREAK!A:O');
    if (!data || data.length < 2) {
      lastArchivedDate = todayStr;
      console.log('[ArchiveWorker] No data rows to check');
      running = false;
      return;
    }

    // Identify rows to move (date before today)
    const rowsToMove = [];
    const rowsToKeep = [data[0]]; // Header row stays

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!row || !row[0]) { rowsToKeep.push(row); continue; } // No date = keep

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

    if (rowsToMove.length === 0) {
      lastArchivedDate = todayStr;
      console.log('[ArchiveWorker] No old data to archive (all rows are from today ' + todayStr + ')');
      running = false;
      return;
    }

    console.log('[ArchiveWorker] Moving ' + rowsToMove.length + ' rows to Archives...');

    // Ensure Archives sheet exists
    await getOrCreateSheet(ssId, 'Archives');

    // Get existing Archives data to know where to append
    const existingArchive = await readRange(ssId, "'Archives'!A:O");

    // Normalize dates in both datasets before writing
    normalizeDates(rowsToMove);
    normalizeDates(rowsToKeep);

    // Determine append position in Archives
    var archiveAppendRow = 1;
    if (existingArchive && existingArchive.length > 0) {
      archiveAppendRow = existingArchive.length + 1;
    }

    // Calculate final row position and expand grid if needed
    var lastNeed = archiveAppendRow - 1 + rowsToMove.length;
    if (!existingArchive || existingArchive.length === 0) {
      lastNeed = 1 + rowsToMove.length;
    }
    await ensureArchiveGrid(ssId, lastNeed + 5);

    // Mark as archived BEFORE write to prevent duplicate 15-min runs
    lastArchivedDate = todayStr;

    // Write to Archives sheet
    if (!existingArchive || existingArchive.length === 0) {
      // Archives is empty — write header + data rows
      await updateRange(ssId, "'Archives'!A1", [data[0]]);
      var endRow = 1 + rowsToMove.length;
      await breakUpdateRange(ssId, "'Archives'!A2:O" + endRow, rowsToMove);
      console.log('[ArchiveWorker] Wrote header + ' + rowsToMove.length + ' data rows to Archives (A1:O' + endRow + ')');
    } else {
      // Archives has data — append after the last existing row
      var startRow = archiveAppendRow;
      var endRow = archiveAppendRow + rowsToMove.length - 1;
      await breakUpdateRange(ssId, "'Archives'!A" + startRow + ":O" + endRow, rowsToMove);
      console.log('[ArchiveWorker] Appended ' + rowsToMove.length + ' rows to Archives (A' + startRow + ':O' + endRow + ')');
    }

    // Rewrite CS BREAK sheet with only today's data
    // IMPORTANT: Use breakUpdateRange (RAW input) to prevent Google Sheets
    // from auto-converting date strings to serial numbers (which would
    // break future archive comparisons).
    if (rowsToKeep.length > 0) {
      await breakUpdateRange(ssId, "'CS BREAK'!A1:O" + rowsToKeep.length, rowsToKeep);
      console.log('[ArchiveWorker] Rewrote CS BREAK with ' + rowsToKeep.length + ' rows (RAW mode)');

      // Delete rows beyond what we wrote (cleaner than writing empties)
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
          var rowsToDelete = totalRows - rowsToKeep.length;
          if (rowsToDelete > 0 && rowsToKeep.length < totalRows) {
            await gsheets2.spreadsheets.batchUpdate({
              spreadsheetId: ssId,
              requestBody: {
                requests: [{
                  deleteDimension: {
                    range: {
                      sheetId: csSheet.properties.sheetId,
                      dimension: "ROWS",
                      startIndex: rowsToKeep.length,
                      endIndex: totalRows
                    }
                  }
                }]
              }
            });
            console.log("[ArchiveWorker] Deleted " + rowsToDelete + " excess rows from CS BREAK (kept " + rowsToKeep.length + ")");
          }
        }
      } catch(e) {
        console.warn("[ArchiveWorker] Row cleanup warning:", e.message);
      }
    }

    // Re-apply professional formatting to all sheets
    try {
      await formatBreakSheets(ssId);
    } catch (fmtErr) {
      console.warn('[ArchiveWorker] Formatting error (non-fatal):', fmtErr.message);
    }

    console.log('[ArchiveWorker] ✅ Archived ' + rowsToMove.length + ' rows into Archives. CS BREAK now has ' + rowsToKeep.length + ' rows.');

  } catch (err) {
    console.error('[ArchiveWorker] Archive error:', err.message);
  }

  // After archive: clean up old records from DAILY SUMMARY (30-day) and Archives (1-month)
  // ssId is accessible here because it was declared outside the try block
  try { await cleanupDailySummary(ssId); } catch(e) { console.error('[ArchiveWorker] Daily summary cleanup error:', e.message); }
  try { await cleanupArchives(ssId); } catch(e) { console.error('[ArchiveWorker] Archives cleanup error:', e.message); }

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
        console.log("[ArchiveWorker] Deleted " + (totalRows - keepCount) + " excess rows from " + sheetName);
      }
    }
  } catch(e) {
    console.warn("[ArchiveWorker] " + sheetName + " row cleanup warning:", e.message);
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

    normalizeDates(rowsToKeep);
    await updateRange(ssId, "'DAILY SUMMARY'!A1:E" + rowsToKeep.length, rowsToKeep);
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
    await updateRange(ssId, "'Archives'!A1:O" + rowsToKeep.length, rowsToKeep);
    await deleteExcessRows(ssId, 'Archives', rowsToKeep.length);
    console.log('[ArchiveWorker] ✅ Archives cleanup: removed ' + deletedCount + ' rows older than ' + cutoffDate);
    return deletedCount;
  } catch (err) {
    console.error('[ArchiveWorker] Archives cleanup error:', err.message);
    return 0;
  }
}

/**
 * Check if midnight has passed and trigger archive if needed.
 * Runs every 15 minutes to catch midnight crossover.
 */
async function scheduledCheck() {
  try {
    const { hours, minutes, dateStr } = getPHTimeComponents();

    // Skip if already archived today
    if (lastArchivedDate === dateStr) return;

    // Run archive check between 00:00 and 00:30 PH time (after midnight)
    // Also run on startup to catch missed archives
    if (hours === 0 && minutes <= 30) {
      console.log('[ArchiveWorker] Midnight window detected (' + hours + ':' + minutes + ' PH), running archive...');
      await runArchive();
    } else if (!lastArchivedDate) {
      // First run ever — check anyway (catches missed midnights)
      console.log('[ArchiveWorker] First run, checking for old data...');
      await runArchive();
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
  console.log('[ArchiveWorker] Started (interval: ' + (intervalMs / 1000) + 's)');

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


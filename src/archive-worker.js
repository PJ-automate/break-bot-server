/**
 * archive-worker.js — Automatically archives old break data from CS BREAK sheet
 * to ARCHIVE sheet after midnight. Runs on a scheduled interval.
 *
 * Works alongside the Google Apps Script autoArchiveOldBreaks() for redundancy.
 * This Node.js version handles the case when the Apps Script trigger fails.
 */
'use strict';

const CONFIG = require('./config');
const { readRange, getOrCreateSheet, updateRange, breakBatchUpdate, formatBreakSheets } = require('./google');

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
 * Archive old data from CS BREAK sheet to ARCHIVE sheet.
 * Moves any rows whose date is before today's PH date.
 */
async function runArchive() {
  if (running) return;
  running = true;

  try {
    const ssId = CONFIG.breakSheetId;
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

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[0]) { rowsToKeep.push(row); continue; } // No date = keep

      // Parse the row's date
      let rowDateStr = String(row[0]).trim();
      // Extract just YYYY-MM-DD if it contains more
      const dateMatch = rowDateStr.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) rowDateStr = dateMatch[1];

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

    // Use the professionally formatted "Archives" sheet (with purple header, borders, alternating colors)
    console.log('[ArchiveWorker] Moving ' + rowsToMove.length + ' rows to Archives...');

    // Ensure Archives sheet exists
    await getOrCreateSheet(ssId, 'Archives');

    // Get existing Archives data to know where to append
    const existingArchive = await readRange(ssId, "'Archives'!A:O");
    const archiveStartRow = existingArchive && existingArchive.length > 0
      ? existingArchive.length + 1
      : 1;

    // If Archives is empty, write header first
    if (!existingArchive || existingArchive.length === 0) {
      await updateRange(ssId, "'Archives'!A1", [data[0]]);
      await updateRange(ssId, "'Archives'!A2:O" + (rowsToMove.length + 1), rowsToMove);
    } else {
      await updateRange(ssId, "'Archives'!A" + (archiveStartRow + 1) + ":O" + (archiveStartRow + rowsToMove.length), rowsToMove);
    }

    // Rewrite CS BREAK sheet with only today's data
    if (rowsToKeep.length > 0) {
      await updateRange(ssId, "'CS BREAK'!A1:O" + rowsToKeep.length, rowsToKeep);

      // Clear remaining rows beyond what we wrote
      if (rowsToKeep.length < 500) {
        const emptyRows = [];
        for (let i = 0; i < 500 - rowsToKeep.length; i++) emptyRows.push(Array(15).fill(''));
        try {
          await updateRange(ssId, "'CS BREAK'!A" + (rowsToKeep.length + 1) + ":O500", emptyRows);
        } catch(e) {
          // Range may be out of bounds, ignore
        }
      }
    }

    // Re-apply professional formatting to all sheets
    try {
      await formatBreakSheets(ssId);
    } catch (fmtErr) {
      console.warn('[ArchiveWorker] Formatting error (non-fatal):', fmtErr.message);
    }

    lastArchivedDate = todayStr;
    console.log('[ArchiveWorker] ✅ Archived ' + rowsToMove.length + ' rows into Archives. CS BREAK now has ' + rowsToKeep.length + ' rows.');

  } catch (err) {
    console.error('[ArchiveWorker] Archive error:', err.message);
  }

  running = false;
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
  getPHDateStr
};

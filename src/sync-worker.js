/**
 * sync-worker.js — Background Google Sheet sync for Break Tracker.
 * Reads pending syncs from SQLite and pushes to Google Sheets.
 * Runs in background — never blocks user commands.
 *
 * FIXED July 2026: Handle "exceeds grid limits" error from archive resizing
 */
'use strict';

const db = require('./break-db');
const CONFIG = require('./config');
const { breakAppendRow, breakUpdateRange, updateRange, getOrCreateSheet, formatDate, getBreakSheetId, reapplyBreakNumberFormats } = require('./google');

const SYNC_TIMEOUT = 90000; // 90s — OVH France has high latency to Google APIs
var processing = false;
var SH = CONFIG.breakSheetId;

/**
 * Race a promise against a timeout.
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(function(_, reject) {
      setTimeout(function() { reject(new Error(label + ' timed out (' + ms + 'ms)')); }, ms);
    })
  ]);
}

/**
 * Process pending sync operations in the background.
 * Called periodically and after each command.
 */
async function processSyncQueue() {
  if (processing) return;
  processing = true;

  try {
    var pending = db.getPendingSyncs();
    if (!pending || pending.length === 0) {
      processing = false;
      return;
    }

    console.log('[SyncWorker] Processing ' + pending.length + ' pending sync(s)...');

    for (var i = 0; i < pending.length; i++) {
      var item = pending[i];
      if (!item || !item.break_id) continue;

      try {
        // For end syncs: if no sheet row yet, write complete break as new row
        if (item.operation === 'end') {
          // IMPORTANT: item.break_id is the human-readable ID (text) from b.break_id
          // The actual integer pk is in item.sq_break_id (from the column rename below)
          var breakIntId = item.sq_break_id || (item.payload ? JSON.parse(item.payload).breakId : null);
          if (!breakIntId) breakIntId = item.break_id; // fallback
          var currentRow = null;
          if (typeof breakIntId === 'number' || /^\d+$/.test(String(breakIntId))) {
            currentRow = db.getDB().prepare('SELECT google_sheet_row, id, business_date, user_name, shift_type, shift_period, break_type, start_time, end_time, duration_hms, remaining, remark, total_used_hms, user_id, break_id FROM breaks WHERE id = ?').get(Number(breakIntId));
          }
          if (!currentRow || !currentRow.google_sheet_row || currentRow.google_sheet_row <= 0) {
            // Start never synced — write complete break as a new row (start + end data)
            if (currentRow && currentRow.google_sheet_row === 0) {
              try {
                var endData = JSON.parse(item.payload || '{}');
                // Payload field names: timeStr, curHMS, remHMS, finalRemark, totalHMS
                var eTime = endData.timeStr || currentRow.end_time || '';
                var eDur = endData.curHMS || currentRow.duration_hms || '';
                var eRem = endData.remHMS || endData.remaining || currentRow.remaining || '';
                var eRemark = endData.finalRemark || currentRow.remark || '';
                var eTotal = endData.totalHMS || currentRow.total_used_hms || '';
                var fullRow = [
                  currentRow.business_date || '', currentRow.user_name || '', currentRow.shift_type || '',
                  currentRow.shift_period || '', currentRow.break_type || '', currentRow.start_time || '',
                  eTime, eDur, eRem, eRemark,
                  currentRow.user_id || '', eTotal, '🟢 RETURNED',
                  currentRow.break_id || '', '🟢 RETURNED'
                ];
                var result = await withTimeout(breakAppendRow(SH, 'CS BREAK!A:O', fullRow), SYNC_TIMEOUT, 'breakAppendRow-end');
                if (result && result.updates && result.updates.updatedRange) {
                  var match = result.updates.updatedRange.match(/A(\d+):/);
                  var newRow = match ? parseInt(match[1], 10) : 0;
                  if (newRow > 0) {
                    item.google_sheet_row = newRow;
                    db.getDB().prepare('UPDATE breaks SET google_sheet_row = ? WHERE id = ?').run(newRow, item.sq_break_id);
                    console.log('[SyncWorker] End break appended as new row ' + newRow + ' for #' + item.break_id);
                    db.markSyncDone(item.id, item.sq_break_id, newRow);
                    // Fire-and-forget daily summary update
                    setTimeout(function() {
                      try {
                        var ds = require('./break-bot');
                        if (typeof ds.updateDailySummary === 'function') {
                          var dsDate = currentRow.business_date || '';
                          var dsUser = currentRow.user_name || '';
                          var dsShift = currentRow.shift_type || '';
                          var dsPeriod = currentRow.shift_period || '';
                          var dsTotal = eTotal || '';
                          var dsRem = eRem || '';
                          if (dsDate && dsUser) {
                            ds.updateDailySummary(dsDate, dsUser, dsShift, dsPeriod, dsTotal, dsRem)
                              .then(function() { console.log('[SyncWorker] Daily summary updated for ' + dsUser + ' ' + dsDate); })
                              .catch(function(e) { console.warn('[SyncWorker] Daily summary update error (non-blocking):', e.message); });
                          }
                        }
                      } catch(e) {
                        console.warn('[SyncWorker] Daily summary import error (non-blocking):', e.message);
                      }
                    }, 100);
                    continue;
                  }
                }
              } catch (appendErr) {
                console.warn('[SyncWorker] End fallback append failed for #' + item.break_id + ': ' + appendErr.message);
                continue;
              }
            } else {
              console.log('[SyncWorker] End #' + item.break_id + ' has no break record, skipping');
              continue;
            }
          } else if (currentRow && currentRow.google_sheet_row > 0) {
            item.google_sheet_row = currentRow.google_sheet_row;
          }
        }

        if (item.operation === 'start') {
          await syncStartBreak(item);
        } else if (item.operation === 'end') {
          await syncEndBreak(item);
        }
        db.markSyncDone(item.id, item.sq_break_id, item.google_sheet_row || 0);
        console.log('[SyncWorker] Synced ' + item.operation + ' #' + item.break_id);

        // After end break sync: check if violation (LONG BREAK or OVERBREAK) and write to OVERBREAK_TRACKER
        if (item.operation === 'end' && (item.remark === 'LONG BREAK' || item.remark === 'OVERBREAK')) {
          trackOverbreakViolation(item).catch(function(err) {
            console.warn('[SyncWorker] Overbreak tracking error (non-blocking):', err.message);
          });
        }
      } catch (err) {
        db.markSyncFailed(item.id, err.message);
        console.warn('[SyncWorker] Failed ' + item.operation + ' #' + item.break_id + ': ' + err.message);

        // If the sheet row was deleted by archive, reset google_sheet_row so next retry re-appends
        if (err.message && err.message.indexOf('exceeds grid limits') >= 0) {
          try {
            db.getDB().prepare('UPDATE breaks SET google_sheet_row = 0 WHERE id = ?').run(item.sq_break_id);
            console.log('[SyncWorker] Reset google_sheet_row for #' + item.break_id + ' (grid limits after archive)');
          } catch(e) {}
        }

        // Don't stop — continue to next item (each sync is independent)
      }
    }
  } catch (err) {
    console.error('[SyncWorker] Error:', err.message);
  }

  processing = false;
}

/**
 * Process ONE specific sync from a command callback (triggered inline).
 * Tries sync with a SHORTER timeout. If it fails, queues it for the periodic worker.
 */
async function processSyncInline(operation, breakId) {
  // For inline processing, just trigger the periodic worker
  processSyncQueue().catch(function() {});
}

/**
 * Sync a start break operation to Google Sheets.
 * Appends a new row to CS BREAK sheet.
 */
async function syncStartBreak(item) {
  if (!item.user_id) throw new Error('Missing user_id');

  var rowData = [
    item.business_date || '', item.user_name || '', item.shift_type || '',
    item.shift_period || '', item.break_type || '', item.start_time || '',
    '', '', '', '', item.user_id || '', '', '🔴 ON BREAK',
    item.break_id || '', '🔴 ON BREAK'
  ];

  var result = await withTimeout(breakAppendRow(SH, 'CS BREAK!A:O', rowData), SYNC_TIMEOUT, 'breakAppendRow');
  if (result && result.updates && result.updates.updatedRange) {
    var match = result.updates.updatedRange.match(/A(\d+):/);
    var row = match ? parseInt(match[1], 10) : 0;
    if (row > 0) {
      item.google_sheet_row = row; // will be saved by markSyncDone
      console.log('[SyncWorker] Start break appended at row ' + row);
    }
  }
}

/**
 * Sync an end break operation to Google Sheets.
 * Updates the existing row with end time, duration, etc.
 */
async function syncEndBreak(item) {
  // google_sheet_row is already set by processSyncQueue before calling this
  var rowIndex = item.google_sheet_row;
  if (!rowIndex || rowIndex <= 0) {
    throw new Error('No sheet row for break #' + item.break_id);
  }

  var statusIcon = item.remark ? ('⚠️ ' + item.remark) : '🟢 RETURNED';

  // Get time values from the breaks table columns (b.end_time, b.duration_hms, etc.)
  // NOTE: item.end_time = b.end_time, item.duration_hms = b.duration_hms (from SELECT)
  var endTimeStr = item.end_time || '';
  var durationStr = item.duration_hms || '';
  var remainingStr = item.remaining || '';
  var remarkStr = item.remark || '';
  var totalStr = item.total_used_hms || '';

  // Try payload as fallback (contains raw command data)
  // Payload has: timeStr, curHMS, remHMS, finalRemark, totalHMS
  if (!endTimeStr || !durationStr) {
    try {
      var pl = JSON.parse(item.payload || '{}');
      if (!endTimeStr) endTimeStr = pl.timeStr || '';
      if (!durationStr) durationStr = pl.curHMS || '';
      if (!remainingStr) remainingStr = pl.remHMS || '';
      if (!remarkStr) remarkStr = pl.finalRemark || '';
      if (!totalStr) totalStr = pl.totalHMS || '';
    } catch(e) {}
  }

  // Send time as TEXT strings (HH:MM:SS)
  // Write G(End)-J(Remark): End Time, Duration, Remaining, Remark
  await withTimeout(breakUpdateRange(SH, 'CS BREAK!G' + rowIndex + ':J' + rowIndex, [[
    endTimeStr, durationStr, remainingStr, remarkStr
  ]]), SYNC_TIMEOUT, 'breakUpdateRange G-J');

  // Write L(Total)-M(Status): Total Used, Status
  await withTimeout(breakUpdateRange(SH, 'CS BREAK!L' + rowIndex + ':M' + rowIndex, [[
    totalStr, statusIcon
  ]]), SYNC_TIMEOUT, 'breakUpdateRange L-M');

  // Write O: Status icon
  await withTimeout(breakUpdateRange(SH, 'CS BREAK!O' + rowIndex, [[statusIcon]]), SYNC_TIMEOUT, 'breakUpdateRange O');

  console.log('[SyncWorker] End break updated at row ' + rowIndex);

  // Fire-and-forget daily summary update (non-blocking — does not affect sync retry loop)
  setTimeout(function() {
    try {
      var ds = require('./break-bot');
      if (typeof ds.updateDailySummary === 'function') {
        var dsDate = item.business_date || '';
        var dsUser = item.user_name || '';
        var dsShift = item.shift_type || '';
        var dsPeriod = item.shift_period || '';
        var dsTotal = totalStr || '';
        var dsRem = remainingStr || '';
        if (dsDate && dsUser) {
          ds.updateDailySummary(dsDate, dsUser, dsShift, dsPeriod, dsTotal, dsRem)
            .then(function() { console.log('[SyncWorker] Daily summary updated for ' + dsUser + ' ' + dsDate); })
            .catch(function(e) { console.warn('[SyncWorker] Daily summary update error (non-blocking):', e.message); });
        }
      }
    } catch(e) {
      console.warn('[SyncWorker] Daily summary import error (non-blocking):', e.message);
    }
  }, 100);

}

/**
 * Convert time string "HH:MM:SS" to Google Sheets serial number.
 */
function timeStringToSerial(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return 0;
  var parts = timeStr.split(':').map(Number);
  return ((parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0)) / 86400;
}

/**
 * Track overbreak violations to OVERBREAK_TRACKER sheet.
 * Called after an end-break sync completes when remark is LONG BREAK or OVERBREAK.
 * Writes: Date, User Name, User ID, Shift, Period, Break Type (+violation type),
 *         Time Range, Duration, Total Break Used
 */
async function trackOverbreakViolation(item) {
  try {
    // Ensure OVERBREAK_TRACKER sheet exists
    await getOrCreateSheet(SH, 'OVERBREAK_TRACKER');

    var now = new Date();
    var dateStr = formatDate(now, 'yyyy-MM-dd HH:mm:ss');
    var startEnd = (item.start_time || '') + ' → ' + (item.end_time || '');
    var violationLabel = item.remark === 'OVERBREAK' ? 'OVERBREAK' : 'LONG BREAK';

    await breakAppendRow(SH, 'OVERBREAK_TRACKER!A:I', [
      dateStr,
      item.user_name || '',
      item.user_id || '',
      item.shift_type || '',
      item.shift_period || '',
      (item.break_type || '') + ' (' + violationLabel + ')',
      startEnd,
      item.duration_hms || '',
      item.total_used_hms || ''
    ]);
    console.log('[SyncWorker] Violation tracked to OVERBREAK_TRACKER: ' + violationLabel + ' for ' + item.user_name);
  } catch (err) {
    // Non-critical — don't let it affect the main sync flow
    console.warn('[SyncWorker] trackOverbreakViolation failed:', err.message);
  }
}

/**
 * Start the sync worker interval.
 */
function startSyncWorker(intervalMs) {
  intervalMs = intervalMs || 5000; // default: every 5 seconds
  console.log('[SyncWorker] Started (interval: ' + intervalMs + 'ms)');
  // Process immediately on start
  processSyncQueue().catch(function() {});
  // Then every N seconds
  return setInterval(function() {
    processSyncQueue().catch(function() {});
  }, intervalMs);
}

module.exports = {
  processSyncQueue,
  startSyncWorker
};


/**
 * sync-worker.js — Background Google Sheet sync for Break Tracker.
 *
 * Two independent paths:
 *   1. syncBreakRecord() — called inline from break-bot.js after SQLite commit.
 *      Handles immediate GS write for new/ended breaks.
 *   2. retryFailedSyncs() — called by periodic timer (every 5s).
 *      Only processes records where sync_status = 'failed'.
 *
 * sync_status values: pending → syncing → synced / failed
 */
'use strict';

const db = require('./break-db');
const coordinator = require('./coordinator');
const CONFIG = require('./config');
const { breakAppendRow, breakUpdateRange, readRange, getOrCreateSheet, formatDate } = require('./google');

const SYNC_TIMEOUT = 120000; // 120s — OVH France has high latency to Google APIs
var SH = CONFIG.breakSheetId;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(function(_, reject) {
      setTimeout(function() { reject(new Error(label + ' timed out (' + ms + 'ms)')); }, ms);
    })
  ]);
}

// ============================================================
//  SYNC START BREAK — Append new row to CS BREAK
// ============================================================

async function syncStartBreak(item) {
  if (!item.user_id) throw new Error('Missing user_id');

  // Idempotency: if google_sheet_row already set, this break was already synced
  if (item.google_sheet_row > 0) {
    console.log('[SyncWorker] Start #' + item.break_id + ' already at row ' + item.google_sheet_row + ' — skipping duplicate');
    return;
  }

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
      item.google_sheet_row = row;
      console.log('[SyncWorker] Start break appended at row ' + row);
    }
  }
}

// ============================================================
//  SYNC END BREAK — Update existing row with end data
// ============================================================

async function syncEndBreak(item) {
  var rowIndex = item.google_sheet_row;
  if (!rowIndex || rowIndex <= 0) {
    throw new Error('No sheet row for break #' + item.break_id);
  }

  var statusIcon = item.remark ? ('⚠️ ' + item.remark) : '🟢 RETURNED';

  var endTimeStr = item.end_time || '';
  var durationStr = item.duration_hms || '';
  var remainingStr = item.remaining || '';
  var remarkStr = item.remark || '';
  var totalStr = item.total_used_hms || '';

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
}

// ============================================================
//  SYNC BREAK RECORD — Bridge between break record and GS write
//  Called inline from break-bot.js after SQLite commit.
//  Manages sync_status: pending → syncing → synced / failed
// ============================================================

async function syncBreakRecord(breakRecord) {
  if (!breakRecord || !breakRecord.id) return;

  // Set syncing status (prevents retry worker from picking it up)
  db.getDB().prepare("UPDATE breaks SET sync_status = 'syncing' WHERE id = ?").run(breakRecord.id);

  // Determine operation type from break state
  var isEnd = (breakRecord.status === 'ENDED' && breakRecord.end_time);
  var operation = isEnd ? 'end' : 'start';

  try {
    // Build item from break record
    var item = {
      break_id: breakRecord.break_id,
      id: breakRecord.id,
      business_date: breakRecord.business_date,
      user_name: breakRecord.user_name,
      shift_type: breakRecord.shift_type,
      shift_period: breakRecord.shift_period,
      break_type: breakRecord.break_type,
      start_time: breakRecord.start_time,
      end_time: breakRecord.end_time,
      duration_hms: breakRecord.duration_hms,
      remaining: breakRecord.remaining,
      remark: breakRecord.remark,
      total_used_hms: breakRecord.total_used_hms,
      user_id: breakRecord.user_id,
      google_sheet_row: breakRecord.google_sheet_row,
      status: breakRecord.status,
      payload: null
    };

    if (operation === 'start') {
      await syncStartBreak(item);
    } else {
      // For end sync: if no sheet row yet, append complete row (start + end in one)
      if (!item.google_sheet_row || item.google_sheet_row <= 0) {
        var fullRow = [
          breakRecord.business_date || '', breakRecord.user_name || '', breakRecord.shift_type || '',
          breakRecord.shift_period || '', breakRecord.break_type || '', breakRecord.start_time || '',
          breakRecord.end_time || '', breakRecord.duration_hms || '', breakRecord.remaining || '',
          breakRecord.remark || '', breakRecord.user_id || '', breakRecord.total_used_hms || '',
          '🟢 RETURNED', breakRecord.break_id || '', '🟢 RETURNED'
        ];
        var result = await withTimeout(breakAppendRow(SH, 'CS BREAK!A:O', fullRow), SYNC_TIMEOUT, 'breakAppendRow-end');
        if (result && result.updates && result.updates.updatedRange) {
          var match = result.updates.updatedRange.match(/A(\d+):/);
          var newRow = match ? parseInt(match[1], 10) : 0;
          if (newRow > 0) {
            item.google_sheet_row = newRow;
            console.log('[SyncWorker] End break appended as complete row ' + newRow);
          }
        }
      } else {
        await syncEndBreak(item);
      }
    }

    // Success: update google_sheet_row and sync_status
    if (item.google_sheet_row > 0) {
      db.getDB().prepare("UPDATE breaks SET google_sheet_row = ?, sync_status = 'synced' WHERE id = ?")
        .run(item.google_sheet_row, breakRecord.id);
    } else {
      db.getDB().prepare("UPDATE breaks SET sync_status = 'synced' WHERE id = ?")
        .run(breakRecord.id);
    }

    // Log success
    var logRow = item.google_sheet_row || '?';
    if (operation === 'start') {
      console.log('[SyncWorker] Synced start #' + breakRecord.break_id + ' at row ' + logRow);
    } else {
      console.log('[SyncWorker] Synced end #' + breakRecord.break_id + ' at row ' + logRow);
    }
    return true;

  } catch (err) {
    // Failure: mark as failed (retry worker will pick it up)
    db.getDB().prepare("UPDATE breaks SET sync_status = 'failed' WHERE id = ?")
      .run(breakRecord.id);
    console.warn('[SyncWorker] Sync failed for #' + breakRecord.break_id + ': ' + err.message);
    return false;
  }
}

// ============================================================
//  RETRY FAILED SYNCS — Periodic, processes only failed records
//  Independent from syncBreakRecord — no overlap possible
// ============================================================

async function retryFailedSyncs() {
  // Pause if archive is running
  if (coordinator.isArchiveRunning()) return;

  var failed = db.getDB().prepare("SELECT * FROM breaks WHERE sync_status = 'failed' LIMIT 20").all();
  if (failed.length === 0) return;

  console.log('[SyncWorker] Retrying ' + failed.length + ' failed sync(s)...');

  for (var i = 0; i < failed.length; i++) {
    var b = failed[i];

    // Re-check: inline sync may have just synced it
    if (b.sync_status !== 'failed') continue;

    try {
      var item = {
        break_id: b.break_id,
        id: b.id,
        business_date: b.business_date,
        user_name: b.user_name,
        shift_type: b.shift_type,
        shift_period: b.shift_period,
        break_type: b.break_type,
        start_time: b.start_time,
        end_time: b.end_time,
        duration_hms: b.duration_hms,
        remaining: b.remaining,
        remark: b.remark,
        total_used_hms: b.total_used_hms,
        user_id: b.user_id,
        google_sheet_row: b.google_sheet_row,
        payload: null
      };

      db.getDB().prepare("UPDATE breaks SET sync_status = 'syncing' WHERE id = ?").run(b.id);

      if (b.status === 'ENDED' && b.end_time) {
        // End sync
        if (!item.google_sheet_row || item.google_sheet_row <= 0) {
          // Append complete row (never had a sheet row)
          var fullRow = [
            b.business_date||'', b.user_name||'', b.shift_type||'', b.shift_period||'',
            b.break_type||'', b.start_time||'', b.end_time||'', b.duration_hms||'',
            b.remaining||'', b.remark||'', b.user_id||'', b.total_used_hms||'',
            '🟢 RETURNED', b.break_id||'', '🟢 RETURNED'
          ];
          var r = await withTimeout(breakAppendRow(SH, 'CS BREAK!A:O', fullRow), SYNC_TIMEOUT, 'breakAppendRow-retry');
          if (r && r.updates && r.updates.updatedRange) {
            var m = r.updates.updatedRange.match(/A(\d+):/);
            item.google_sheet_row = m ? parseInt(m[1], 10) : 0;
          }
        } else {
          await syncEndBreak(item);
        }
      } else {
        // Start sync
        await syncStartBreak(item);
      }

      // Mark synced
      if (item.google_sheet_row > 0) {
        db.getDB().prepare("UPDATE breaks SET google_sheet_row = ?, sync_status = 'synced' WHERE id = ?")
          .run(item.google_sheet_row, b.id);
      } else {
        db.getDB().prepare("UPDATE breaks SET sync_status = 'synced' WHERE id = ?").run(b.id);
      }
      console.log('[SyncWorker] Retry success #' + b.break_id + ' row=' + (item.google_sheet_row || '?'));

    } catch (err) {
      db.getDB().prepare("UPDATE breaks SET sync_status = 'failed' WHERE id = ?").run(b.id);
      console.warn('[SyncWorker] Retry failed for #' + b.break_id + ': ' + err.message);
    }
  }
}

// ============================================================
//  START SYNC WORKER — Periodic timer
//  Only calls retryFailedSyncs — never touches pending records
// ============================================================

function startSyncWorker(intervalMs) {
  intervalMs = intervalMs || 5000;
  console.log('[SyncWorker] Started (interval: ' + intervalMs + 'ms)');
  console.log('[SyncWorker] Normal sync: inline via syncBreakRecord after SQLite');
  console.log('[SyncWorker] Retry timer: failed records only');
  return setInterval(function() {
    retryFailedSyncs().catch(function() {});
  }, intervalMs);
}

module.exports = {
  syncBreakRecord,
  startSyncWorker
};

function getHistoryByDate(d,u){u=u||'__ALL__';var p=getDB().prepare(u==='__ALL__'?'SELECT * FROM breaks WHERE business_date = ? ORDER By start_time ASC':'SELECT * FROM breaks WHERE user_id = ? AND business_date = ? ORDER By id ASC');return u==='__ALL__'?p.all(d):p.all(u,d);}
function getHistoryByDateRange(fr,to,u){u=u||'__ALL__';var s=u==='__ALL__'?'SELECT * FROM breaks WHERE business_date >= ? AND business_date <= ? ORDER BY business_date ASC, start_time ASC':'SELECT * FROM breaks WHERE user_id = ? AND business_date >= ? AND business_date <= ? ORDER BY business_date ASC, start_time ASC';return getDB().prepare(s).all.apply(null,u==='__ALL__'?[fr,to]:[u,fr,to]);}
﻿/**
 * break-db.js ??? SQLite database for Break Tracker Bot.
 * Source of truth for all break data. Google Sheets is updated asynchronously.
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'break-bot.db');
let db = null;

/**
 * Initialize the database ??? creates tables if they don't exist.
 */
function initDB() {
  var dir = path.dirname(DB_PATH);
  var fs = require('fs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');    // Faster writes
  db.pragma('synchronous = NORMAL');  // Good balance of speed/safety

  // Breaks table ??? all break records
  db.exec(`
    CREATE TABLE IF NOT EXISTS breaks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_date TEXT NOT NULL,
      user_name TEXT NOT NULL,
      shift_type TEXT DEFAULT '12h',
      shift_period TEXT DEFAULT 'DayShift',
      break_type TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT DEFAULT '',
      duration_secs INTEGER DEFAULT 0,
      duration_hms TEXT DEFAULT '',
      remaining TEXT DEFAULT '',
      remark TEXT DEFAULT '',
      total_used_hms TEXT DEFAULT '',
      user_id TEXT NOT NULL,
      status TEXT DEFAULT 'ON BREAK',
      break_id TEXT,
      sync_status TEXT DEFAULT 'pending',
      google_sheet_row INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // Daily summary cache ??? tracks which rows exist in DAILY SUMMARY sheet
  // Eliminates the need to read the full sheet to find matching rows,
  // which was causing 40s timeouts from OVH France to Google APIs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_summary_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_date TEXT NOT NULL,
      user_name TEXT NOT NULL,
      shift_key TEXT NOT NULL,
      sheet_row INTEGER NOT NULL DEFAULT 0,
      total_used TEXT DEFAULT '',
      remaining TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      UNIQUE(business_date, user_name, shift_key)
    )
  `);
  // Settings table for persistent key-value storage across restarts
  // Used to persist lastArchivedDate, lastChecked times, etc.
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      break_id INTEGER,
      payload TEXT,
      retries INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // Indexes for fast lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_breaks_user ON breaks(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_breaks_date ON breaks(business_date);
    CREATE INDEX IF NOT EXISTS idx_breaks_sync ON breaks(sync_status);
    CREATE INDEX IF NOT EXISTS idx_sync_created ON sync_queue(created_at);
  `);

  console.log('[DB] Initialized: ' + DB_PATH);
  return db;
}

/**
 * Get the database instance.
 */
function getDB() {
  if (!db) throw new Error('Database not initialized. Call initDB() first.');
  return db;
}

/**
 * Start a break ??? insert record.
 * @returns {object} { id, breakId }
 */
function startBreak(businessDate, userName, shiftType, shiftPeriod, breakType, startTime, userId) {
  const d = getDB();
  var dateStr = new Date(businessDate);
  var dd = String(dateStr.getDate()).padStart(2, '0');
  var mm = String(dateStr.getMonth() + 1).padStart(2, '0');
  var yy = String(dateStr.getFullYear()).slice(-2);
  var ts = Date.now();
  var rnd = Math.floor(Math.random() * 10000);
  var breakId = 'CSB' + yy + mm + dd + String(ts).slice(-8) + String(rnd).padStart(4, '0');

  var info = d.prepare(`
    INSERT INTO breaks (business_date, user_name, shift_type, shift_period, break_type, start_time, user_id, status, break_id, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ON BREAK', ?, 'pending')
  `).run(businessDate, userName, shiftType, shiftPeriod, breakType, startTime, userId, breakId);

  // Queue sync for this break
  queueSync('start', info.lastInsertRowid, {
    bd: businessDate, userName: userName, shiftType: shiftType,
    shiftPeriod: shiftPeriod, breakType: breakType, timeStr: startTime,
    userId: userId, breakId: breakId
  });

  return { id: info.lastInsertRowid, breakId: breakId };
}

/**
 * End a break ??? update the active break for a user.
 * @returns {object|null} { row, duration, totalHMS, remHMS, remark } or null if no active break
 */
function endBreak(userId, endTimeStr) {
  const d = getDB();

  // Find active break
  var active = d.prepare(`
    SELECT * FROM breaks WHERE user_id = ? AND status = 'ON BREAK' ORDER BY id DESC LIMIT 1
  `).get(userId);

  if (!active) return null;

  // Calculate duration
  var startParts = active.start_time.split(':').map(Number);
  var endParts = endTimeStr.split(':').map(Number);
  var startSecs = startParts[0] * 3600 + startParts[1] * 60 + (startParts[2] || 0);
  var endSecs = endParts[0] * 3600 + endParts[1] * 60 + (endParts[2] || 0);
  var diffSecs = endSecs - startSecs;
  if (diffSecs < 0) diffSecs += 86400; // crossed midnight

  var durH = Math.floor(diffSecs / 3600);
  var durM = Math.floor((diffSecs % 3600) / 60);
  var durS = diffSecs % 60;
  var curHMS = String(durH).padStart(2, '0') + ':' + String(durM).padStart(2, '0') + ':' + String(durS).padStart(2, '0');

  // Calculate previous total from today's ended breaks
  var prevTotal = d.prepare(`
    SELECT COALESCE(SUM(duration_secs), 0) as total FROM breaks
    WHERE user_id = ? AND business_date = ? AND status != 'ON BREAK'
  `).get(userId, active.business_date);
  var prevSecs = prevTotal ? prevTotal.total : 0;

  var totalSecs = prevSecs + diffSecs;
  var allowance = 7200; // 2 hours (12h shift only, 8h removed)
  var remaining = allowance - totalSecs;
  var remHMS = (remaining >= 0 ? '' : '-') +
    String(Math.floor(Math.abs(remaining) / 3600)).padStart(2, '0') + ':' +
    String(Math.floor((Math.abs(remaining) % 3600) / 60)).padStart(2, '0') + ':' +
    String(Math.abs(remaining) % 60).padStart(2, '0');

  var totalH = Math.floor(totalSecs / 3600);
  var totalM = Math.floor((totalSecs % 3600) / 60);
  var totalS = totalSecs % 60;
  var totalHMS = String(totalH).padStart(2, '0') + ':' + String(totalM).padStart(2, '0') + ':' + String(totalS).padStart(2, '0');

  var remark = '';
  if (diffSecs > 3600) remark = 'LONG BREAK';
  if (totalSecs > allowance) remark = 'OVERBREAK';
  var statusIcon = remark ? ('?????? ' + remark) : '???? RETURNED';

  // Update the break record
  d.prepare(`
    UPDATE breaks SET end_time = ?, duration_secs = ?, duration_hms = ?,
      remaining = ?, remark = ?, total_used_hms = ?, status = 'ENDED',
      sync_status = 'pending'
    WHERE id = ?
  `).run(endTimeStr, diffSecs, curHMS, remHMS, remark, totalHMS, active.id);

  // Queue sync
  queueSync('end', active.id, {
    rowIndex: active.google_sheet_row || 0,
    timeStr: endTimeStr, curHMS: curHMS, remHMS: remHMS,
    finalRemark: remark || '', totalHMS: totalHMS,
    bd: active.business_date, userName: active.user_name,
    shiftType: active.shift_type, shiftPeriod: active.shift_period
  });

  // Immediately update daily_summary_cache so DAILY SUMMARY data is never lost
  // even if the background sheet write times out
  var shiftKey = active.shift_type + ' (' + active.shift_period + ')';
  d.prepare(`
    INSERT INTO daily_summary_cache (business_date, user_name, shift_key, sheet_row, total_used, remaining)
    VALUES (?, ?, ?, -1, ?, ?)
    ON CONFLICT(business_date, user_name, shift_key) DO UPDATE SET
      total_used = excluded.total_used,
      remaining = excluded.remaining,
      updated_at = datetime('now', 'localtime')
  `).run(active.business_date, active.user_name, shiftKey, totalHMS, remHMS);

  return {
    row: active,
    breakType: active.break_type,
    startTime: active.start_time,
    curHMS: curHMS,
    totalHMS: totalHMS,
    remHMS: remHMS,
    remark: remark
  };
}

/**
 * Get active break for a user.
 * @returns {object|null}
 */
function getActiveBreak(userId) {
  const d = getDB();
  return d.prepare(`
    SELECT * FROM breaks WHERE user_id = ? AND status = 'ON BREAK' ORDER BY id DESC LIMIT 1
  `).get(userId);
}

/**
 * Get user's break history for today.
 * Pass '__ALL__' as userId to get all users' breaks for today.
 * @returns {Array}
 */
function getTodayHistory(userId, shiftPeriod) {
  const d = getDB();
  var now = new Date();
  var today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

  if (userId === '__ALL__') {
    if (shiftPeriod) {
      return d.prepare(`
        SELECT * FROM breaks WHERE business_date = ? AND shift_period = ? ORDER BY start_time ASC
      `).all(today, shiftPeriod);
    }
    return d.prepare(`
      SELECT * FROM breaks WHERE business_date = ? ORDER BY start_time ASC
    `).all(today);
  }

  if (shiftPeriod) {
    return d.prepare(`
      SELECT * FROM breaks WHERE user_id = ? AND business_date = ? AND shift_period = ?
      ORDER BY id ASC
    `).all(userId, today, shiftPeriod);
  }

  return d.prepare(`
    SELECT * FROM breaks WHERE user_id = ? AND business_date = ?
    ORDER BY id ASC
  `).all(userId, today);
}

/**
 * Queue a sync operation for Google Sheets.
 */
function queueSync(operation, breakId, payload) {
  const d = getDB();
  d.prepare(`
    INSERT INTO sync_queue (operation, break_id, payload) VALUES (?, ?, ?)
  `).run(operation, breakId, JSON.stringify(payload));
  return true;
}

/**
 * Get all pending sync operations, oldest first.
 */
function getPendingSyncs() {
  const d = getDB();
  return d.prepare(`
    SELECT sq.*, sq.break_id as sq_break_id,
      b.google_sheet_row, b.business_date, b.user_name,
      b.shift_type, b.shift_period, b.break_type, b.start_time, b.end_time,
      b.duration_hms, b.remaining, b.remark, b.total_used_hms, b.user_id,
      b.break_id, b.status
    FROM sync_queue sq
    LEFT JOIN breaks b ON sq.break_id = b.id
    WHERE sq.retries < 100
    ORDER BY sq.created_at ASC
    LIMIT 20
  `).all();
}

/**
 * Mark sync as completed and update google_sheet_row.
 */
function markSyncDone(syncId, breakId, sheetRow) {
  const d = getDB();
  if (sheetRow > 0) {
    d.prepare(`UPDATE breaks SET google_sheet_row = ?, sync_status = 'synced' WHERE id = ?`)
      .run(sheetRow, breakId);
  } else {
    d.prepare(`UPDATE breaks SET sync_status = 'synced' WHERE id = ?`)
      .run(breakId);
  }
  d.prepare(`DELETE FROM sync_queue WHERE id = ?`).run(syncId);
}

/**
 * Mark sync as failed (increment retry counter).
 */
function markSyncFailed(syncId, errorMsg) {
  const d = getDB();
  var item = d.prepare(`SELECT retries FROM sync_queue WHERE id = ?`).get(syncId);
  if (item) {
    d.prepare(`UPDATE sync_queue SET retries = retries + 1, last_error = ? WHERE id = ?`)
      .run(errorMsg, syncId);
  }
}

/**
 * Get all users currently on break (for dashboard).
 * @returns {Array}
 */
function getAllActiveBreaks() {
  const d = getDB();
  return d.prepare(`
    SELECT * FROM breaks WHERE status = 'ON BREAK' ORDER BY start_time ASC
  `).all();
}

/**
 * Load active breaks from Google Sheet into SQLite (one-time migration).
 * Called on first startup to populate DB from existing sheet data.
 */
function importFromSheetData(sheetData) {
  const d = getDB();
  if (!sheetData || sheetData.length < 2) return 0;

  // IDEMPOTENT: skip if breaks already imported (prevents duplicates on restart)
  var existingCount = d.prepare('SELECT COUNT(*) as c FROM breaks').get();
  if (existingCount && existingCount.c > 0) {
    console.log('[DB] Breaks table has ' + existingCount.c + ' records, skipping import');
    return 0;
  }

  var count = 0;
  var insert = d.prepare(`
    INSERT OR IGNORE INTO breaks (business_date, user_name, shift_type, shift_period,
      break_type, start_time, end_time, duration_hms, remaining, remark,
      total_used_hms, user_id, status, break_id, google_sheet_row, sync_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
  `);

  var tx = d.transaction(function(rows) {
    for (let i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r[10]) continue; // no user_id
      var endTime = r[6] ? String(r[6]).trim() : '';
      var shift = r[2] ? String(r[2]).trim() : '';
      var btype = r[4] ? String(r[4]).trim() : '';
      if (shift === 'RESET' || btype === 'SHIFT_SET') continue;
      var status = (!endTime && (shift === '8h' || shift === '12h')) ? 'ON BREAK' : 'ENDED';
      insert.run(
        String(r[0] || '').substring(0, 10), r[1] || '', shift, r[3] || '',
        btype, r[5] || '', endTime, r[7] || '', r[8] || '', r[9] || '',
        r[11] || '', String(r[10]).trim(), status, r[13] || '', i + 1
      );
      count++;
    }
  });
  tx(sheetData);
  return count;
}

/**
 * Get cached sheet row for a daily summary entry.
 * Returns { sheet_row, total_used, remaining } or null.
 */
function getSummaryCache(businessDate, userName, shiftKey) {
  const d = getDB();
  return d.prepare(`
    SELECT sheet_row, total_used, remaining FROM daily_summary_cache
    WHERE business_date = ? AND user_name = ? AND shift_key = ?
  `).get(businessDate, userName, shiftKey);
}

/**
 * Set/update cached sheet row for a daily summary entry.
 */
function setSummaryCache(businessDate, userName, shiftKey, sheetRow, totalUsed, remaining) {
  const d = getDB();
  d.prepare(`
    INSERT INTO daily_summary_cache (business_date, user_name, shift_key, sheet_row, total_used, remaining)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(business_date, user_name, shift_key) DO UPDATE SET
      sheet_row = excluded.sheet_row,
      total_used = excluded.total_used,
      remaining = excluded.remaining,
      updated_at = datetime('now', 'localtime')
  `).run(businessDate, userName, shiftKey, sheetRow, totalUsed, remaining);
}

/**
 * Get all summary cache entries for a given date.
 * Used after archive to rebuild cache from sheet data.
 */
function getSummaryCacheByDate(businessDate) {
  const d = getDB();
  return d.prepare(`
    SELECT * FROM daily_summary_cache WHERE business_date = ?
  `).all(businessDate);
}

/**
 * Clear all summary cache entries (after archive, when rows shift).
 */
function clearSummaryCache() {
  const d = getDB();
  d.prepare(`DELETE FROM daily_summary_cache`).run();
}

/**
 * Convert a cell value to a YYYY-MM-DD date string for caching.
 * Handles serial numbers (46204), Date objects, and strings.
 */
function _cellToDateStr(value) {
  if (!value) return '';
  // Already a YYYY-MM-DD string
  var str = String(value);
  var m = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  // Google Sheets serial number
  var num = Number(value);
  if (!isNaN(num) && num > 40000 && num < 60000) {
    var d = new Date((num - 25569) * 86400000);
    return d.toISOString().substring(0, 10);
  }
  return str.substring(0, 10);
}

/**
 * Bulk insert summary cache entries from sheet data.
 * Used after archive to rebuild cache from fresh sheet read.
 */
function importSummaryCacheFromSheet(sheetData) {
  const d = getDB();
  if (!sheetData || sheetData.length < 2) return 0;
  var count = 0;
  // Clear existing cache first
  d.prepare(`DELETE FROM daily_summary_cache`).run();
  var insert = d.prepare(`
    INSERT OR IGNORE INTO daily_summary_cache (business_date, user_name, shift_key, sheet_row, total_used, remaining)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (let i = 1; i < sheetData.length; i++) {
    var r = sheetData[i];
    if (!r || !r[0] || !r[1]) continue;
    var dateStr = _cellToDateStr(r[0]);
    if (!dateStr) continue;
    var shiftKey = String(r[2] || '');
    if (!shiftKey) continue;
    insert.run(dateStr, r[1], shiftKey, i + 1, String(r[3] || ''), String(r[4] || ''));
    count++;
  }
  return count;
}
/**
 * End a break by its database ID (used for auto-close of stale breaks).
 * Unlike endBreak(), this does NOT queue a Google Sheets sync because
 * the GS row was already archived. Sets sync_status = 'synced' directly.
 * @returns {object|null} { id, breakType, curHMS, totalHMS, remHMS, remark }
 */
function endBreakAuto(activeBreakRow, endTimeStr) {
  const d = getDB();
  if (!activeBreakRow || activeBreakRow.status !== 'ON BREAK') return null;

  // Calculate duration from start_time to end_time
  var startParts = activeBreakRow.start_time.split(':').map(Number);
  var endParts = endTimeStr.split(':').map(Number);
  var startSecs = startParts[0] * 3600 + startParts[1] * 60 + (startParts[2] || 0);
  var endSecs = endParts[0] * 3600 + endParts[1] * 60 + (endParts[2] || 0);
  var diffSecs = endSecs - startSecs;
  if (diffSecs < 0) diffSecs += 86400; // crossed midnight

  var durH = Math.floor(diffSecs / 3600);
  var durM = Math.floor((diffSecs % 3600) / 60);
  var durS = diffSecs % 60;
  var curHMS = pad2(durH) + ':' + pad2(durM) + ':' + pad2(durS);

  // Calculate previous total from ended breaks on same business date
  var prevTotal = d.prepare(`
    SELECT COALESCE(SUM(duration_secs), 0) as total FROM breaks
    WHERE user_id = ? AND business_date = ? AND status != 'ON BREAK'
  `).get(activeBreakRow.user_id, activeBreakRow.business_date);
  var prevSecs = prevTotal ? prevTotal.total : 0;

  var totalSecs = prevSecs + diffSecs;
  var allowance = 7200; // 2 hours (12h shift)
  var remaining = allowance - totalSecs;
  var remHMS = (remaining >= 0 ? '' : '-') +
    pad2(Math.floor(Math.abs(remaining) / 3600)) + ':' +
    pad2(Math.floor((Math.abs(remaining) % 3600) / 60)) + ':' +
    pad2(Math.abs(remaining) % 60);

  var totalH = Math.floor(totalSecs / 3600);
  var totalM = Math.floor((totalSecs % 3600) / 60);
  var totalS = totalSecs % 60;
  var totalHMS = pad2(totalH) + ':' + pad2(totalM) + ':' + pad2(totalS);

  var remark = '';
  if (diffSecs > 3600) remark = 'LONG BREAK';
  if (totalSecs > allowance) remark = 'OVERBREAK';

  // Update break record ??? sync_status = 'synced' (no GS sync since row was archived)
  d.prepare(`
    UPDATE breaks SET end_time = ?, duration_secs = ?, duration_hms = ?,
      remaining = ?, remark = ?, total_used_hms = ?, status = 'ENDED',
      sync_status = 'synced'
    WHERE id = ?
  `).run(endTimeStr, diffSecs, curHMS, remHMS, remark, totalHMS, activeBreakRow.id);

  // Update daily_summary_cache
  var shiftKey = activeBreakRow.shift_type + ' (' + activeBreakRow.shift_period + ')';
  d.prepare(`
    INSERT INTO daily_summary_cache (business_date, user_name, shift_key, sheet_row, total_used, remaining)
    VALUES (?, ?, ?, -1, ?, ?)
    ON CONFLICT(business_date, user_name, shift_key) DO UPDATE SET
      total_used = excluded.total_used, remaining = excluded.remaining,
      updated_at = datetime('now', 'localtime')
  `).run(activeBreakRow.business_date, activeBreakRow.user_name, shiftKey, totalHMS, remHMS);

  return {
    id: activeBreakRow.id,
    breakType: activeBreakRow.break_type,
    curHMS: curHMS,
    totalHMS: totalHMS,
    remHMS: remHMS,
    remark: remark
  };
}

/** Helper: zero-pad a number to 2 digits */
function pad2(n) { return String(Math.floor(n)).padStart(2, '0'); }

/**
 * Update the google_sheet_row for a break identified by break_id.
 * Called after archive to correct stale row numbers.
 */
function updateSheetRow(breakId, sheetRow) {
  const d = getDB();
  d.prepare("UPDATE breaks SET google_sheet_row = ? WHERE break_id = ?").run(sheetRow, breakId);
}

/**
 * Get all ON BREAK breaks from previous business dates (for auto-close).
 * @returns {Array}
 */
function getStaleActiveBreaks(todayStr) {
  const d = getDB();
  return d.prepare(`
    SELECT * FROM breaks WHERE status = 'ON BREAK' AND business_date < ?
  `).all(todayStr);
}

function closeDB() {
  if (db) { db.close(); db = null; }
}

/**
 * Get a persistent setting value.
 */
function getSetting(key) {
  const d = getDB();
  var row = d.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Set a persistent setting value.
 */
function setSetting(key, value) {
  const d = getDB();
  d.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', 'localtime')
  `).run(key, value);
}

module.exports = {
  getHistoryByDate,
  getHistoryByDateRange,
  initDB, getDB, closeDB,
  startBreak, endBreak, getActiveBreak, getTodayHistory,
  getPendingSyncs, markSyncDone, markSyncFailed, queueSync,
  getAllActiveBreaks, importFromSheetData,
  getSummaryCache, setSummaryCache, getSummaryCacheByDate,
  clearSummaryCache, importSummaryCacheFromSheet,
  getSetting, setSetting,
  endBreakAuto, updateSheetRow, getStaleActiveBreaks
};

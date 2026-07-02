/**
 * break-db.js — SQLite database for Break Tracker Bot.
 * Source of truth for all break data. Google Sheets is updated asynchronously.
 */
'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'break-bot.db');
let db = null;

/**
 * Initialize the database — creates tables if they don't exist.
 */
function initDB() {
  var dir = path.dirname(DB_PATH);
  var fs = require('fs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');    // Faster writes
  db.pragma('synchronous = NORMAL');  // Good balance of speed/safety

  // Breaks table — all break records
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

  // Sync queue — pending Google Sheet operations
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
 * Start a break — insert record.
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
 * End a break — update the active break for a user.
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
  var remHMS = (remaining > 0 ? '' : '-') +
    String(Math.floor(Math.abs(remaining) / 3600)).padStart(2, '0') + 'h ' +
    String(Math.floor((Math.abs(remaining) % 3600) / 60)).padStart(2, '0') + 'm';

  var totalH = Math.floor(totalSecs / 3600);
  var totalM = Math.floor((totalSecs % 3600) / 60);
  var totalS = totalSecs % 60;
  var totalHMS = String(totalH).padStart(2, '0') + ':' + String(totalM).padStart(2, '0') + ':' + String(totalS).padStart(2, '0');

  var remark = '';
  if (diffSecs > 3600) remark = 'LONG BREAK';
  if (totalSecs > allowance) remark = 'OVERBREAK';
  var statusIcon = remark ? ('⚠️ ' + remark) : '🟢 RETURNED';

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
function getTodayHistory(userId) {
  const d = getDB();
  var now = new Date();
  var today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

  if (userId === '__ALL__') {
    return d.prepare(`
      SELECT * FROM breaks WHERE business_date = ? ORDER BY start_time ASC
    `).all(today);
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
 * Close the database.
 */
function closeDB() {
  if (db) { db.close(); db = null; }
}

module.exports = {
  initDB, getDB, closeDB,
  startBreak, endBreak, getActiveBreak, getTodayHistory,
  getPendingSyncs, markSyncDone, markSyncFailed, queueSync,
  getAllActiveBreaks, importFromSheetData
};

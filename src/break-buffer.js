/**
 * break-buffer.js — Local JSON buffer for break records.
 * Writes happen instantly to a local file, then sync to Google Sheets in background.
 * Survives server restarts — pending records are re-processed on startup.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');

const BUFFER_FILE = path.join(__dirname, '..', 'data', 'break-buffer.json');
var buffer = null;
var processing = false;

// Ensure data directory exists
function ensureDir() {
  var dir = path.dirname(BUFFER_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load the buffer from disk (or create empty).
 */
function loadBuffer() {
  if (buffer) return buffer;
  ensureDir();
  try {
    if (fs.existsSync(BUFFER_FILE)) {
      var raw = fs.readFileSync(BUFFER_FILE, 'utf8');
      buffer = JSON.parse(raw);
      if (!buffer.pending || !Array.isArray(buffer.pending)) buffer.pending = [];
    } else {
      buffer = { pending: [] };
    }
  } catch (e) {
    console.error('[Buffer] Load error:', e.message);
    buffer = { pending: [] };
  }
  return buffer;
}

/**
 * Write buffer to disk atomically.
 */
function saveBuffer() {
  ensureDir();
  var tmp = BUFFER_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(buffer, null, 2), 'utf8');
  fs.renameSync(tmp, BUFFER_FILE);
}

/**
 * Add a pending break record to the buffer.
 * @param {string} type — 'start' or 'end'
 * @param {object} data — the data needed to replay this operation
 * @returns {string} the entry ID
 */
function addPending(type, data) {
  loadBuffer();
  var entry = {
    id: data.breakId || ('PEND_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    type: type,
    createdAt: Date.now(),
    retries: 0,
    lastError: null,
    data: data
  };
  buffer.pending.push(entry);
  saveBuffer();
  console.log('[Buffer] Added ' + type + ' pending: ' + entry.id);
  return entry.id;
}

/**
 * Remove a pending entry from the buffer after successful sync.
 */
function removePending(id) {
  loadBuffer();
  var before = buffer.pending.length;
  buffer.pending = buffer.pending.filter(function(e) { return e.id !== id; });
  if (buffer.pending.length !== before) {
    saveBuffer();
    console.log('[Buffer] Removed pending: ' + id);
  }
}

/**
 * Get all pending entries.
 */
function getPending() {
  loadBuffer();
  return buffer.pending;
}

/**
 * Get pending count.
 */
function getPendingCount() {
  return getPending().length;
}

/**
 * Process the buffer — sync all pending entries to Google Sheets one at a time.
 * Called on startup and after each successful write.
 * Only one processBuffer runs at a time (processing flag).
 */
async function processBuffer(breakBotModule) {
  if (processing) return;
  processing = true;

  var pending = getPending();
  if (pending.length === 0) {
    processing = false;
    return;
  }

  console.log('[Buffer] Processing ' + pending.length + ' pending entries...');

  for (var i = 0; i < pending.length; i++) {
    var entry = pending[i];
    if (!entry) continue;

    try {
      if (entry.type === 'start') {
        await replayStart(entry, breakBotModule);
      } else if (entry.type === 'end') {
        await replayEnd(entry, breakBotModule);
      }
      // Success — remove from buffer
      removePending(entry.id);
      console.log('[Buffer] Synced: ' + entry.id);
    } catch (err) {
      entry.retries++;
      entry.lastError = err.message;
      console.warn('[Buffer] Sync failed for ' + entry.id + ' (retry ' + entry.retries + '): ' + err.message);
      // Save updated retry count
      saveBuffer();
      // Stop processing on failure — next call will retry
      break;
    }
  }

  processing = false;
}

/**
 * Replay a start break operation to Google Sheets.
 * Uses the saved data from the buffer entry.
 */
async function replayStart(entry, bot) {
  var d = entry.data;
  const { breakAppendRow } = require('./google');
  const SH = CONFIG.breakSheetId;

  // breakAppendRow returns the raw Google API response:
  // { spreadsheetId: "...", updates: { updatedRange: "CS BREAK!A369:O369", ... } }
  // Extract the row number from updatedRange.
  var result = await breakAppendRow(SH, 'CS BREAK!A:O', [
    d.bd, d.userName, d.shiftType, d.shiftPeriod, d.breakType, d.timeStr,
    '', '', '', '', d.userId, '', '🔴 ON BREAK', d.breakId, '🔴 ON BREAK'
  ]);

  if (result && result.updates && result.updates.updatedRange) {
    var range = result.updates.updatedRange;
    var match = range.match(/A(\d+):/);
    var row = match ? parseInt(match[1], 10) : 0;
    if (row > 0) {
      if (bot && bot.activeBreakIndex) {
        bot.activeBreakIndex.set(String(d.userId), {
          row: row,
          data: [d.bd, d.userName, d.shiftType, d.shiftPeriod, d.breakType,
                 d.timeStr, '', '', '', '', d.userId, '', '🔴 ON BREAK', d.breakId, '🔴 ON BREAK']
        });
      }
      return true;
    }
  }
  throw new Error('breakAppendRow failed');
}

/**
 * Replay an end break operation to Google Sheets.
 */
async function replayEnd(entry, bot) {
  const { writeEndBreakToSheet } = bot || require('./break-bot');
  const SH = CONFIG.breakSheetId;

  // writeEndBreakToSheet expects: (rowIndex, timeStr, curHMS, remHMS, finalRemark, totalHMS)
  await writeEndBreakToSheet(
    entry.data.rowIndex,
    entry.data.timeStr,
    entry.data.curHMS,
    entry.data.remHMS,
    entry.data.finalRemark || '',
    entry.data.totalHMS
  );

  // Also update daily summary
  const { updateDailySummary } = require('./break-bot');
  await updateDailySummary(
    entry.data.bd,
    entry.data.userName,
    entry.data.shiftType,
    entry.data.shiftPeriod,
    entry.data.totalHMS,
    entry.data.remHMS
  );
}

module.exports = {
  addPending,
  removePending,
  getPending,
  getPendingCount,
  processBuffer
};

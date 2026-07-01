/**
 * break-bot.js — CS Break Tracker Telegram Bot (Node.js version)
 * Handles /start, /end, /history, callback queries, and break logic.
 * Replaces the Google Apps Script version entirely.
 */

const axios = require('axios');
const CONFIG = require('./config');
const { readRange, appendRow, updateRange, breakAppendRow, breakUpdateRange, getOrCreateSheet, formatBreakSheets, reapplyBreakNumberFormats, getBreakSheetId, breakBatchUpdate } = require('./google');
const buffer = require('./break-buffer');

// In-memory shift cache (5 min TTL)
const shiftCache = new Map();

// Sheet-ready flag — skip getOrCreateSheet after first successful check (saves ~2s/op)
var BREAK_SHEETS_READY = false;

// Data cache — reuses readBreakData result across multiple reads within the same interaction.
// Clears after 8 seconds so subsequent operations within a single interaction
// (start + sheet write + notification) all share one read instead of re-reading.
var dataCache = { data: null, timestamp: 0 };
var DATA_CACHE_TTL = 8000;

// Active break in-memory index — userId → { row, data }
// Eliminates the 1-2s readRange('CS BREAK!A:O') call in getActiveBreakRow.
// Populated lazily on first getActiveBreakRow hit; updated on start/end.
// Process-lifetime — survives across webhooks but not restarts (graceful fallback to sheet read).
var activeBreakIndex = new Map();

// Total-used cache — key: userId_businessDate_shift_period → seconds used.
// Eliminates readRange('CS BREAK!A:O') in endBreak for prev totals.
// Updated on each endBreak; read from DAILY SUMMARY on first call per day.
var totalUsedCache = new Map();

function getTotalUsedCacheKey(userId, bd, shiftType, shiftPeriod) {
  return String(userId) + '_' + bd + '_' + shiftType + '_' + shiftPeriod;
}

/** Extract break ID from row data (column N, index 13) */
function breakIdFromRow(d) {
  return d && d[13] ? String(d[13]).trim() : ('UNKNOWN_' + Date.now());
}

function getCachedData() {
  if (dataCache.data && Date.now() - dataCache.timestamp < DATA_CACHE_TTL) {
    return dataCache.data;
  }
  return null;
}

function setCachedData(data) {
  dataCache.data = data;
  dataCache.timestamp = Date.now();
}

// Summary data cache — readSummaryData also benefits from caching.
// Tied to dataCache timestamp so they invalidate together.
var summaryCache = { data: null, timestamp: 0 };

function getCachedSummary() {
  if (summaryCache.data && Date.now() - summaryCache.timestamp < DATA_CACHE_TTL) {
    return summaryCache.data;
  }
  return null;
}

function setCachedSummary(data) {
  summaryCache.data = data;
  summaryCache.timestamp = Date.now();
}

// Callback dedup — prevents duplicate processing of the same callback query
const processedCallbacks = new Set();
const CB_CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 min
setInterval(function() { processedCallbacks.clear(); }, CB_CLEANUP_INTERVAL);

// Time helpers
const TZ_BKK = 'GMT+7';
const TZ_PH = 'GMT+8';

/**
 * Returns PH time components as a plain object.
 * Pure integer math — NO Date timezone confusion.
 * Handles Google Sheets serial numbers, strings, and Date objects.
 */
function getPHComponents(date) {
  // Convert Google Sheets serial number to Date (46202 = June 29, 2026)
  if (typeof date === 'number') {
    date = new Date((date - 25569) * 86400000);
  } else if (!(date instanceof Date)) {
    date = new Date(date);
  }
  var phStr = date.toLocaleString("en-US", { timeZone: "Asia/Manila", hour12: false });
  var parts = phStr.split(/[,\/\s]+/);
  var timeParts = (parts[3] || '0:0:0').split(':');
  return {
    year: parseInt(parts[2], 10),
    month: parseInt(parts[0], 10),
    day: parseInt(parts[1], 10),
    hour: parseInt(timeParts[0], 10) || 0,
    min: parseInt(timeParts[1], 10) || 0,
    sec: parseInt(timeParts[2], 10) || 0
  };
}

/**
 * Returns a Date where local getHours/getDate return PH values.
 * Uses UTC math to compensate for server timezone.
 */
function toPH(date) {
  var c = getPHComponents(date);
  var offsetHours = -(date.getTimezoneOffset()) / 60; // +7 for BKK
  return new Date(Date.UTC(c.year, c.month - 1, c.day, c.hour - offsetHours, c.min, c.sec));
}

function fmtDate(date, pattern) {
  const pad = (n) => String(n).padStart(2, '0');
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return pattern
    .replace('yyyy', date.getFullYear())
    .replace('MMMM', months[date.getMonth()])
    .replace('MM', pad(date.getMonth() + 1))
    .replace('dd', pad(date.getDate()))
    .replace('HH', pad(date.getHours()))
    .replace('mm', pad(date.getMinutes()))
    .replace('ss', pad(date.getSeconds()));
}

function fmtTime(date, tz) {
  tz = tz || "Asia/Manila";
  var str = date.toLocaleString("en-US", { timeZone: tz, hour12: false });
  var timePart = str.split(", ")[1] || str.split(" ")[1] || "00:00:00";
  return timePart;
}

function fmtHMS(s) {
  s = Math.round(Math.abs(Number(s) || 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function fmtRemaining(s) {
  const abs = Math.abs(s);
  if (s < 0) return `⚠️ Over: -${fmtHMS(abs)}`;
  return `✅ ${fmtHMS(abs)}`;
}

function getBusinessDate(date, shiftType) {
  var c = getPHComponents(date);
  if (shiftType === 'Graveyard' || shiftType === 'NightShift') {
    if (c.hour >= 0 && c.hour < 12) return formatYMD(c.year, c.month, c.day);
    // Add one day with proper month/year rollover using Date
    var next = new Date(c.year, c.month - 1, c.day + 1);
    return formatYMD(next.getFullYear(), next.getMonth() + 1, next.getDate());
  }
  return formatYMD(c.year, c.month, c.day);
}

function formatYMD(year, month, day) {
  var pad = (n) => String(n).padStart(2, '0');
  return year + '-' + pad(month) + '-' + pad(day);
}

function getPHHour() {
  return getPHComponents(new Date()).hour;
}

function pad(n) { return String(n).padStart(2, '0'); }

/**
 * Convert a date string ("2026-07-01") to a Google Sheets serial number (46204).
 * Used for writing dates with RAW input to prevent auto-format override.
 */
function dateToSerial(dateStr) {
  if (typeof dateStr === 'number') return dateStr; // already a serial
  var d = new Date(dateStr + 'T00:00:00Z'); // parse as UTC midnight to avoid timezone shift
  // Excel/Sheets serial: days since Dec 30, 1899
  return (d.getTime() / 86400000) + 25569;
}

/**
 * Convert a time string ("00:23:46") to a Google Sheets time serial (0.0165046...).
 * Used for writing times with RAW input to prevent auto-format override.
 * Works identically for day shift (14:00 → 0.58333) and night shift (00:23 → 0.01650).
 */
function timeToSerial(timeStr) {
  if (typeof timeStr === 'number' && timeStr > 0 && timeStr < 1) return timeStr; // already a serial
  var parts = String(timeStr || '0:0:0').split(':');
  var h = parseInt(parts[0], 10) || 0;
  var m = parseInt(parts[1], 10) || 0;
  var s = parseInt(parts[2], 10) || 0;
  return (h * 3600 + m * 60 + s) / 86400;
}

/**
 * Convert a Google Sheets cell value to a Date object.
 * Handles serial numbers (46202 = June 29, 2026), Date objects, and strings.
 */
function parseDateCell(cell) {
  // Handle string serial numbers like "46203" (Google Sheets returns as string when column format is NUMBER)
  if (typeof cell === 'string' && /^[0-9]+$/.test(cell)) {
    cell = parseInt(cell, 10);
  }
  if (typeof cell === 'number') {
    // Google Sheets serial date: days since Dec 30, 1899
    return new Date((cell - 25569) * 86400000);
  }
  if (cell instanceof Date) return cell;
  return new Date(cell);
}

/**
 * Convert a Google Sheets cell value to a time string "HH:mm:ss".
 * Handles time serial numbers (0.5 = 12:00:00, 0.5416667 = 13:00:00).
 */
function parseTimeCell(cell) {
  if (typeof cell === 'number' && cell > 0 && cell < 1) {
    // Time serial number: fraction of a day
    var totalSecs = Math.round(cell * 86400);
    var h = Math.floor(totalSecs / 3600) % 24;
    var m = Math.floor((totalSecs % 3600) / 60);
    var s = totalSecs % 60;
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  var str = String(cell ?? '');
  // Handle 12-hour AM/PM format, e.g. "12:20:04 AM" → "00:20:04"
  var m2 = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (m2) {
    var hh = parseInt(m2[1], 10);
    var isPM = m2[4].toUpperCase() === 'PM';
    var isAM = m2[4].toUpperCase() === 'AM';
    if (isPM && hh !== 12) hh += 12;
    if (isAM && hh === 12) hh = 0;
    return pad(hh) + ':' + m2[2] + ':' + (m2[3] || '00');
  }
  return str;
}


// -- ARCHIVE: Move old data to Archives sheet, keep CS BREAK clean --
var ARCHIVED_DATE = '';

async function archiveOldData() {
  var now = new Date();
  var phNow = getPHComponents(now);
  if (phNow.hour !== 0) return; // only at midnight PH 12:00-12:59 AM

  var today = formatYMD(phNow.year, phNow.month, phNow.day);
  if (ARCHIVED_DATE === today) return;
  ARCHIVED_DATE = today;

  console.log('[Archive] Archiving previous day data...');
  var data = await readBreakData();
  if (!data || data.length < 2) { console.log('[Archive] No data'); return; }

  var oldRows = [data[0]];
  var todayRows = [data[0]];
  for (var i = 1; i < data.length; i++) {
    var rd = data[i][0];
    var rdStr = rd instanceof Date ? fmtDate(rd, 'yyyy-MM-dd') : (typeof rd === 'number' ? fmtDate(parseDateCell(rd), 'yyyy-MM-dd') : String(rd || '').substring(0, 10));
    if (rdStr && rdStr !== today) oldRows.push(data[i]);
    else todayRows.push(data[i]);
  }
  if (oldRows.length <= 1) { console.log('[Archive] No old data'); return; }

  try {
    // Batch 1: Write all old rows to Archives (header + data in one shot)
    var archCreated = await getOrCreateSheet(SH, 'Archives');
    var archRange = 'Archives!A1:O' + oldRows.length;
    await updateRange(SH, archRange, oldRows);
    console.log('[Archive] Archived ' + (oldRows.length - 1) + ' rows');

    // Apply professional formatting to Archives if newly created
    if (archCreated.created) {
      try { await formatBreakSheets(SH); } catch (e) { console.error('[Archive] Format error:', e.message); }
    }

    // Batch 2: Clear all old rows from CS BREAK, rewrite today rows
    var clearPayload = [];
    for (var k = 1; k < data.length; k++) {
      clearPayload.push(['','','','','','','','','','','','','','','']);
    }
    if (todayRows.length > 1) {
      // Replace old positions 0..old-1 with today rows
      for (var t = 1; t < todayRows.length; t++) {
        clearPayload[t - 1] = todayRows[t];
      }
    }
    await updateRange(SH, 'CS BREAK!A2:O' + (1 + clearPayload.length), clearPayload);
    console.log('[Archive] Done. ' + (todayRows.length - 1) + ' today rows kept');
  } catch(e) {
    console.error('[Archive] Error:', e.message);
  }
}

// ============================================================
//  TELEGRAM API HELPERS
// ============================================================

const BOT_URL = `https://api.telegram.org/bot${CONFIG.breakBotToken}`;

async function tg(method, payload, attempt) {
  if (attempt === undefined) attempt = 0;
  try {
    const res = await axios.post(`${BOT_URL}/${method}`, payload, { timeout: 10000 });
    return res.data;
  } catch (err) {
    var resp = err.response;
    // 429 Too Many Requests — respect retry_after
    if (resp && resp.status === 429) {
      var retryAfter = (resp.data && resp.data.parameters && resp.data.parameters.retry_after) || 5;
      if (attempt < 3) {
        console.log('[BreakBot] TG 429 rate limited on ' + method + ', retry after ' + retryAfter + 's (attempt ' + (attempt + 1) + '/3)');
        await new Promise(function(r) { setTimeout(r, retryAfter * 1000 + 200); });
        return tg(method, payload, attempt + 1);
      }
    }
    console.error('[BreakBot] TG error:', method, resp ? JSON.stringify(resp.data) : err.message);
    return null;
  }
}

async function sendMsg(chatId, text, extra = {}) {
  return tg('sendMessage', { chat_id: String(chatId), text, parse_mode: 'Markdown', ...extra });
}

async function answerCb(callbackId, text) {
  // show_alert: false → brief toast at bottom of screen, auto-dismisses (no OK button)
  // show_alert: true  → modal popup requiring user to tap OK
  return tg('answerCallbackQuery', { callback_query_id: callbackId, text, show_alert: false });
}

async function delMsg(chatId, msgId) {
  return tg('deleteMessage', { chat_id: String(chatId), message_id: msgId });
}

// ============================================================
//  SHEET HELPERS
// ============================================================

const SH = CONFIG.breakSheetId;

// One-time formatting flag (applies professional formatting to existing sheets on first run)
var FORMAT_APPLIED = false;

async function getBreakSheet() {
  // Skip API calls if sheets already known to exist (saves ~2s per interaction)
  if (BREAK_SHEETS_READY) return { breakSheet: 'CS BREAK', summarySheet: 'DAILY SUMMARY' };

  var anyCreated = false;

  // Create CS BREAK sheet if missing
  var bs = await getOrCreateSheet(SH, 'CS BREAK');
  if (bs.created) {
    await updateRange(SH, 'CS BREAK!A1:O1', [[
      'Date','Name','Shift','Period','Break Type','Start Time',
      'End Time','Duration','Remaining','Remark','User ID','Total Used','Status','Break ID','Notes'
    ]]);
    anyCreated = true;
  }

  // Create DAILY SUMMARY sheet if missing
  var ds = await getOrCreateSheet(SH, 'DAILY SUMMARY');
  if (ds.created) {
    await updateRange(SH, 'DAILY SUMMARY!A1:E1', [[
      'Date','User','Shift','Total Used','Remaining'
    ]]);
    anyCreated = true;
  }

  // If any sheet was new, apply professional formatting
  if (anyCreated) {
    try { await formatBreakSheets(SH); } catch (err) { console.error('[BreakBot] Formatting error:', err.message); }
  }

  BREAK_SHEETS_READY = true; // Cache: skip API calls on next interaction
  return { breakSheet: 'CS BREAK', summarySheet: 'DAILY SUMMARY' };
}

async function appendBreakRow(values) {
  // Convert date/time to serial numbers and use RAW input to prevent
  // Google Sheets from auto-formatting cells (which causes the day/night
  // shift flip-flop: USER_ENTERED interprets "00:xx" as 12h AM/PM).
  // Serial values + RAW means the HH:mm:ss format ALWAYS controls display.
  var raw = values.slice(); // shallow copy
  if (raw[0]) raw[0] = dateToSerial(raw[0]);         // column A: date → serial
  if (raw[5]) raw[5] = timeToSerial(raw[5]);         // column F: start time → serial
  try {
    const res = await breakAppendRow(SH, 'CS BREAK!A:O', raw);
    // Extract row number from response: "CS BREAK!A16:O16" → 16
    const range = res?.updates?.updatedRange || '';
    const match = range.match(/A(\d+):/);
    const row = match ? parseInt(match[1], 10) : 0;
    console.log('[BreakBot] appendBreakRow: row=' + row + ' via RAW (serials)');
    return { ok: true, row };
  } catch (err) {
    console.error('[BreakBot] appendBreakRow FAILED:', err.message);
    return { ok: false, row: 0 };
  }
}

async function readBreakData() {
  // Use cached data if fresh (<2s) — saves API calls when multiple functions
  // (e.g. getActiveBreakRow + findTodayShift) read the same data in one interaction.
  var cached = getCachedData();
  if (cached) return cached;
  var fresh = await readRange(SH, 'CS BREAK!A:O');
  setCachedData(fresh);
  return fresh;
}

async function readSummaryData() {
  var cached = getCachedSummary();
  if (cached) return cached;
  var fresh = await readRange(SH, 'DAILY SUMMARY!A:E');
  setCachedSummary(fresh);
  return fresh;
}

function fmtCell(val) {
  if (val instanceof Date && val.getFullYear() === 1899) {
    return `${pad(val.getHours())}:${pad(val.getMinutes())}:${pad(val.getSeconds())}`;
  }
  if (val instanceof Date) return fmtDate(val, 'yyyy-MM-dd');
  return String(val ?? '');
}

function getStartTimestamp(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return Date.now();
  const parts = timeStr.split(':').map(Number);
  if (parts.length < 2) return Date.now();
  // Get today's PH date components
  var phNow = getPHComponents(new Date());
  // Create a PH-time-based timestamp (seconds since epoch)
  var d = new Date();
  d.setFullYear(phNow.year, phNow.month - 1, phNow.day);
  d.setHours(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
  // If this time is in the future, it's from a previous day (e.g. started at 23:00, now 01:00)
  if (d > new Date()) d.setDate(d.getDate() - 1);
  return d.getTime();
}

function parseDur(dur) {
  if (!dur) return 0;
  // Handle Google Sheets time serial number (0.009618 = 0:13:51)
  if (typeof dur === 'number' && dur > 0 && dur < 1) {
    return Math.round(dur * 86400);
  }
  const m = String(dur).match(/(\d+):(\d+):(\d+)/);
  if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
  return 0;
}

// ============================================================
//  USER STATE (cache)
// ============================================================

function getCachedShift(userId) {
  const cached = shiftCache.get(userId);
  if (cached && cached.expiry > Date.now()) return cached;
  return null;
}

function setCachedShift(userId, shift, period) {
  shiftCache.set(userId, { shift, period, expiry: Date.now() + 5 * 60 * 1000 });
}

function clearCachedShift(userId) {
  shiftCache.delete(userId);
}

async function findTodayShift(userId) {
  const cached = getCachedShift(userId);
  if (cached) return cached;

  const data = await readBreakData();
  if (!data || data.length < 2) return null;

  const phNow = toPH(new Date());
  const today = fmtDate(phNow, 'yyyy-MM-dd');

  for (let i = data.length - 1; i >= 1; i--) {
    const rowUserId = fmtCell(data[i][10]);
    if (rowUserId !== String(userId)) continue;
    const shift = fmtCell(data[i][2]);
    if (shift !== '8h' && shift !== '12h') continue;
    const period = fmtCell(data[i][3]);
    const rowDate = data[i][0];
    if (!rowDate) continue;

    const bd = getBusinessDate(parseDateCell(rowDate), period);
    if (bd === today) {
      const result = { shift, period };
      setCachedShift(userId, shift, period);
      return result;
    }
  }
  return null;
}

async function getUserName(userId) {
  const data = await readBreakData();
  if (!data) return '';
  for (let i = data.length - 1; i >= 1; i--) {
    if (fmtCell(data[i][10]) === String(userId) && data[i][1]) {
      return fmtCell(data[i][1]);
    }
  }
  return '';
}

async function getActiveBreakRow(userId) {
  // Check in-memory index first — instant, no API calls.
  // The index is populated lazily on first hit and updated on every start/end.
  var idx = activeBreakIndex.get(String(userId));
  if (idx) return idx;

  // Fall back to sheet read (slow path: happens after restart or external edit).
  const data = await readBreakData();
  if (!data) return null;
  for (let i = data.length - 1; i >= 1; i--) {
    const uid = fmtCell(data[i][10]);
    const endTime = data[i][6];
    const shift = fmtCell(data[i][2]);
    const btype = fmtCell(data[i][4]);
    if (uid === String(userId) && (!endTime || String(endTime).trim() === '') && shift !== 'RESET' && btype !== 'SHIFT_SET') {
      var result = { row: i + 1, data: data[i] };
      activeBreakIndex.set(String(userId), result); // populate index for future
      return result;
    }
  }
  return null;
}

// ============================================================
//  CORE HANDLER
// ============================================================

async function handleBreakUpdate(update) {
  try {
    await getBreakSheet();

    // One-time professional formatting for existing sheets
    if (!FORMAT_APPLIED) {
      FORMAT_APPLIED = true;
      console.log('[BreakBot] Applying professional formatting to existing sheets...');
      try {
        await formatBreakSheets(SH);
        console.log('[BreakBot] Professional formatting applied');
      } catch (err) {
        console.error('[BreakBot] Formatting error (non-fatal):', err.message);
      }
    }

    // Archive check: runs on EVERY interaction so midnight archive works
    // even if no one ends a break at exactly 12:00 AM.
    // Returns near-instantly except at midnight (PH hour 0).
    await archiveOldData().catch(function() {});

    // Callback query
    if (update.callback_query) {
      return handleCallback(update.callback_query);
    }

    // Message
    if (update.message) {
      return handleMessage(update.message);
    }
  } catch (err) {
    console.error('[BreakBot] Error:', err.message);
  }
}

// ============================================================
//  CALLBACK HANDLER
// ============================================================

async function handleCallback(cb) {
  const cbId = cb.id;
  const action = cb.data;
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const clickerId = String(cb.from.id);
  const userName = cb.from.first_name + (cb.from.last_name ? ' ' + cb.from.last_name : '');

  // DEDUP: skip callback if already processed
  if (processedCallbacks.has(cbId)) {
    console.log('[BreakBot] Duplicate callback ignored:', cbId, action);
    return;
  }
  processedCallbacks.add(cbId);

  console.log('[BreakBot] Callback:', action, 'from', userName, 'ID:', clickerId);

  // Ownership check
  const ownerMatch = (cb.message.text || '').match(/ID:\s*(\d+)/);
  const ownerId = ownerMatch ? ownerMatch[1] : null;
  if (ownerId && clickerId !== ownerId) {
    await answerCb(cbId, `⚠️ ACCESS DENIED — This menu is not yours!`);
    return;
  }

  // Send IMMEDIATE visual feedback to the user so they know the bot is working.
  // Without this, pressing a break-type button makes the message disappear and then
  // the user stares at a blank screen for 2-8 seconds wondering if anything happened.
  var feedbackText = '⏳ Processing...';
  if (action.startsWith('setshift_')) feedbackText = '⏳ Setting shift...';
  else if (action.startsWith('start_')) feedbackText = '⏳ Starting break...';
  else if (action === 'end_break') feedbackText = '⏳ Ending break...';
  else if (action === 'view_history') feedbackText = '⏳ Loading history...';
  await answerCb(cbId, feedbackText);

  // Delete command messages for clean UX
  if (action.startsWith('setshift_') || action.startsWith('period_') || action.startsWith('start_') || action === 'end_break') {
    await delMsg(chatId, msgId).catch(() => {});
  }

  if (action.startsWith('setshift_')) {
    const shift = action.split('_')[1];
    // 12h: auto-detect period from current PH time
    if (shift === '12h') {
      var phStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila', hour12: false });
      var phHour = parseInt(phStr.split(/[,\s]+/)[3].split(':')[0], 10);
      var period = (phHour >= 12) ? 'DayShift' : 'NightShift';
      await updateShiftInSheet(clickerId, shift, period);
      setCachedShift(clickerId, shift, period);
      return sendBreakTypeMenu(chatId, shift, period, userName, clickerId);
    }
    return sendShiftPeriodMenu(chatId, shift, userName, clickerId);
  }

  if (action.startsWith('period_')) {
    const parts = action.split('_');
    await updateShiftInSheet(clickerId, parts[1], parts[2]);
    setCachedShift(clickerId, parts[1], parts[2]);
    return sendBreakTypeMenu(chatId, parts[1], parts[2], userName, clickerId);
  }

  if (action.startsWith('start_')) {
    const parts = action.split('_');
    console.log('[BreakBot] Starting break:', { userName, shift: parts[1], period: parts[2], type: parts[3] });
    await delMsg(chatId, msgId).catch(() => {});
    return startBreak(chatId, clickerId, userName, parts[1], parts[2], parts[3]);
  }

  if (action === 'end_break') {
    await delMsg(chatId, msgId).catch(() => {});
    return endBreak(chatId, clickerId, userName);
  }

  if (action === 'view_history') {
    return sendUserHistory(chatId, clickerId, userName);
  }
}

// ============================================================
//  MESSAGE HANDLER
// ============================================================

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const userId = String(msg.from.id);
  const userName = msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '');

  switch (text) {
    case '/start':
    case '/menu':
      return showMenu(chatId, userName, userId);
    case '/end':
      return endBreak(chatId, userId, userName);
    case '/history':
    case '/mybreak':
      return sendUserHistory(chatId, userId, userName);
    case '/myid':
      return sendMsg(chatId, `🆔 Your Telegram ID: \`${userId}\``);
    default:
      if (text.startsWith('/manual_start')) {
        return sendManualStartMenu(chatId, userName, userId);
      }
      if (text.startsWith('/manual_end')) {
        return sendManualEndMenu(chatId, userName, userId);
      }
      return sendMsg(chatId, 'Unknown command. Use /start, /end, /history, /myid');
  }
}

// ============================================================
//  MENU / SHIFT SELECTION
// ============================================================

async function showMenu(chatId, user, userId) {
  // Auto-correct period: for 12h shifts, determine DayShift/NightShift from current PH time
  function autoCorrectPeriod(shift, period) {
    if (shift === '12h') {
      var phHour = getPHHour();
      return (phHour >= 12) ? 'DayShift' : 'NightShift';
    }
    return period;
  }

  const cached = getCachedShift(userId);
  if (cached) {
    cached.period = autoCorrectPeriod(cached.shift, cached.period);
    setCachedShift(userId, cached.shift, cached.period);
    await updateShiftInSheet(userId, cached.shift, cached.period).catch(() => {});
    return sendBreakTypeMenu(chatId, cached.shift, cached.period, user, userId);
  }

  const existing = await findTodayShift(userId);
  if (existing) {
    existing.period = autoCorrectPeriod(existing.shift, existing.period);
    setCachedShift(userId, existing.shift, existing.period);
    await updateShiftInSheet(userId, existing.shift, existing.period).catch(() => {});
    return sendBreakTypeMenu(chatId, existing.shift, existing.period, user, userId);
  }

  // AUTO-DETECT shift based on current PH time
  var phHour = getPHHour();
  var phDebugStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Manila", hour12: false });
  console.log('[BreakBot] showMenu auto-detect:', { phHour, phDebugStr, serverHour: new Date().getHours(), tzOffset: new Date().getTimezoneOffset() });

  let shift = '12h';
  let period;
  if (phHour >= 12) {
    period = 'DayShift';
  } else {
    period = 'NightShift';
  }

  // Auto-set shift in sheet and cache
  await updateShiftInSheet(userId, shift, period);
  setCachedShift(userId, shift, period);

  const labels = {
    DayShift: '☀️ Day Shift', NightShift: '🌑 Night Shift'
  };

  return sendBreakTypeMenu(chatId, shift, period, user, userId,
    `👋 *Welcome ${user}*\n🕐 *PH Time:* ${fmtTime(new Date())}\n✅ Auto-selected *${labels[period]}*\n\nSelect break type:`);
}

async function sendShiftPeriodMenu(chatId, shift, user, userId) {
  var phHour = getPHHour();

  let keyboard;
  if (shift === '8h') {
    const opts = [];
    if (phHour >= 12 && phHour < 16)
      opts.push('Morning');
    if (phHour >= 16 && phHour < 20)
      opts.push('Middle');
    if (phHour >= 20 || phHour < 12)
      opts.push('Graveyard');

    const labels = { Morning: '🌅 Morning (11AM-3PM BKK / 12PM-4PM PH)', Middle: '🌤 Middle (3PM-7PM BKK / 4PM-8PM PH)', Graveyard: '🌑 Graveyard (7PM-11PM BKK / 8PM-12AM PH)' };
    keyboard = opts.map(o => [{ text: labels[o], callback_data: `period_${shift}_${o}` }]);
    if (keyboard.length === 0) keyboard = [[{ text: '🌑 Graveyard', callback_data: `period_${shift}_Graveyard` }]]; // fallback
  } else {
    // 12h: only allow period matching current PH time
    if (phHour >= 12) {
      keyboard = [[{ text: '☀️ Day Shift (11AM-11PM BKK / 12PM-12AM PH)', callback_data: `period_${shift}_DayShift` }]];
    } else {
      keyboard = [[{ text: '🌑 Night Shift (11PM-11AM BKK / 12AM-12PM PH)', callback_data: `period_${shift}_NightShift` }]];
    }
  }
  return sendMsg(chatId,
    `👤 *User:* ${user}\n*Shift:* ${shift}\n\nChoose your period:\n\n[ID: ${userId}]`,
    { reply_markup: JSON.stringify({ inline_keyboard: keyboard }) }
  );
}

async function sendBreakTypeMenu(chatId, shift, period, user, userId, customMsg) {
  const labels = {
    Morning: '🌅 Morning', Middle: '🌤 Middle', Graveyard: '🌑 Graveyard',
    DayShift: '☀️ Day Shift', NightShift: '🌑 Night Shift'
  };
  const defaultMsg = `👤 *${user}*\n⚡ *${shift}* (${labels[period] || period})\n\nSelect break type:\n\n[ID: ${userId}]`;
  return sendMsg(chatId, customMsg || defaultMsg,
    {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: '🍱 Meal', callback_data: `start_${shift}_${period}_Meal` },
           { text: '🚽 Bio', callback_data: `start_${shift}_${period}_Bio` }],
          [{ text: '🚬 Smoke', callback_data: `start_${shift}_${period}_Smoke` },
           { text: '🧘 Relax', callback_data: `start_${shift}_${period}_Relax` }],
          [{ text: '🍎 Snack', callback_data: `start_${shift}_${period}_Snack` },
           { text: '🕌 Prayer', callback_data: `start_${shift}_${period}_Prayer` }],
          [{ text: '🚨 Emergency', callback_data: `start_${shift}_${period}_Emergency` }],
          [{ text: '⏹ End Active Break', callback_data: 'end_break' }]
        ]
      })
    }
  );
}

// ============================================================
//  MANUAL START / END
// ============================================================

async function sendManualStartMenu(chatId, user, userId) {
  return sendMsg(chatId,
    `🛠 *MANUAL START — ${user}*\n\nSelect break type:\n[ID: ${userId}]`,
    {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: '🍱 Meal', callback_data: 'manual_start_Meal' },
           { text: '🚽 Bio', callback_data: 'manual_start_Bio' }],
          [{ text: '🚬 Smoke', callback_data: 'manual_start_Smoke' },
           { text: '🧘 Relax', callback_data: 'manual_start_Relax' }],
          [{ text: '🍎 Snack', callback_data: 'manual_start_Snack' },
           { text: '🕌 Prayer', callback_data: 'manual_start_Prayer' }],
          [{ text: '🚨 Emergency', callback_data: 'manual_start_Emergency' }]
        ]
      })
    }
  );
}

async function sendManualEndMenu(chatId, user, userId) {
  const active = await getActiveBreakRow(userId);
  if (!active) {
    return sendMsg(chatId, '❌ No active breaks found.');
  }
  return sendMsg(chatId,
    `🛠 *MANUAL END — ${user}*\n\nSelect break to end:\n[ID: ${userId}]`,
    {
      reply_markup: JSON.stringify({
        inline_keyboard: [[{
          text: `${active.data[4] || 'Break'} (Started: ${fmtCell(active.data[5])})`,
          callback_data: `manual_end_${active.row}`
        }]]
      })
    }
  );
}

// ============================================================
//  UPDATE SHIFT IN SHEET
// ============================================================

async function updateShiftInSheet(userId, shift, period) {
  const data = await readBreakData();
  if (!data) return;

  const phNow = toPH(new Date());
  const today = fmtDate(phNow, 'yyyy-MM-dd');

  for (let i = data.length - 1; i >= 1; i--) {
    if (fmtCell(data[i][10]) !== String(userId)) continue;
    const rowDate = data[i][0];
    if (!rowDate) continue;
    const bd = getBusinessDate(parseDateCell(rowDate), data[i][3]);
    if (bd === today && (data[i][2] === '8h' || data[i][2] === '12h')) {
      // Only update if the stored period matches the new period.
      // This prevents corrupting break rows across the night/day boundary
      // (e.g., a NightShift break row at 11:30 AM should NOT get overwritten to DayShift at 12:30 PM)
      var storedPeriod = fmtCell(data[i][3]);
      if (storedPeriod === period) {
        await updateRange(SH, `CS BREAK!C${i + 1}:D${i + 1}`, [[shift, period]]);
      }
      return;
    }
  }
}

// ============================================================
//  START BREAK
// ============================================================

async function startBreak(chatId, userId, userName, shiftType, shiftPeriod, breakType) {
  console.log('[BreakBot] startBreak called:', { userId, userName, shiftType, shiftPeriod, breakType });
  const now = new Date();
  const timeStr = fmtTime(now);

  // Check for active break
  const active = await getActiveBreakRow(userId);
  if (active) {
    return sendMsg(chatId, `⚠️ *${userName}*, you already have an active break!\n\nUse /end to close it first.`);
  }

  // Get or find shift info
  let sType = shiftType;
  let sPeriod = shiftPeriod;
  if (!sType || !sPeriod) {
    const cached = await findTodayShift(userId);
    if (cached) { sType = cached.shift; sPeriod = cached.period; }
  }
  if (!sType || !sPeriod) {
    return sendMsg(chatId, '⚠️ Please set your shift first using /start');
  }

  // Auto-correct period based on current PH time (prevents stale callback data)
  var phHour = getPHHour();
  var correctPeriod = (phHour >= 12) ? 'DayShift' : 'NightShift';
  if (sType === '12h' && sPeriod !== correctPeriod) {
    console.log('[BreakBot] Auto-correcting period:', sPeriod, '→', correctPeriod);
    sPeriod = correctPeriod;
  }
  if (sType === '8h') {
    // For 8h shifts, also validate period against current hour
    // (Morning 12-4PM, Middle 4-8PM, Graveyard 8PM-12AM PH)
    if (sPeriod === 'Morning' && !(phHour >= 12 && phHour < 16)) {
      sPeriod = (phHour >= 20 || phHour < 12) ? 'Graveyard' : (phHour >= 16 ? 'Middle' : 'Morning');
    } else if (sPeriod === 'Middle' && !(phHour >= 16 && phHour < 20)) {
      sPeriod = (phHour >= 20 || phHour < 12) ? 'Graveyard' : (phHour >= 12 ? 'Morning' : 'Middle');
    } else if (sPeriod === 'Graveyard' && !(phHour >= 20 || phHour < 12)) {
      sPeriod = (phHour >= 16) ? 'Middle' : 'Morning';
    }
  }

  // Compute business date (MUST use corrected period)
  const bd = getBusinessDate(now, sPeriod);
  console.log('[BreakBot] startBreak time:', { timeStr, bd, finalPeriod: sPeriod });

  // Generate break ID
  const dateStr = fmtDate(new Date(bd), 'yyMMdd');
  const ts = Date.now();
  const rnd = Math.floor(Math.random() * 10000);
  const breakId = `CSB${dateStr}${String(ts).slice(-8)}${String(rnd).padStart(4, '0')}`;

  // Send notification to the group monitoring channel FIRST (~0.5s)
  const phTime = fmtTime(now);
  const bkkTime = fmtTime(now, "Asia/Bangkok");
  console.log('[BreakBot] Sending break start notification to', CONFIG.breakGroupId);
  await sendMsg(CONFIG.breakGroupId,
    `🔴 *BREAK STARTED*\n👤 ${userName}\n☕ ${breakType}\n🆔 ${breakId}\n🕐 ${bkkTime} BKK / ${phTime} PH`
  ).catch(() => {});

  // Send personal confirmation IMMEDIATELY — user sees response in <1s
  // Sheet append happens asynchronously after; if it fails, we send a correction.
  if (CONFIG.breakGroupId !== String(chatId)) {
    await sendMsg(chatId,
      `☕ *${breakType} break started!*\n🕐 ${phTime} PH\n\n_Use /end when you return._`
    ).catch(() => {});
  }

  // Pre-populate active break index so /end works even before sheet write completes
  var pendingRowData = [dateToSerial(bd), userName, sType, sPeriod, breakType, timeToSerial(timeStr), '', '', '', '', userId, '', '🔴 ON BREAK', breakId, '🔴 ON BREAK'];
  activeBreakIndex.set(String(userId), { row: 0, data: pendingRowData });

  // Save to local buffer IMMEDIATELY — survives server restart even if Google Sheets is down
  buffer.addPending('start', {
    bd: bd, userName: userName, shiftType: sType, shiftPeriod: sPeriod,
    breakType: breakType, timeStr: timeStr, userId: userId, breakId: breakId
  });

  // Append to sheet — DO NOT AWAIT.
  // The sheet write is the slowest part (1-25s). By not awaiting, the user gets
  // instant feedback and the sheet catches up in the background.
  appendBreakRow([
    bd, userName, sType, sPeriod, breakType, timeStr,
    '', '', '', '', userId, '', '🔴 ON BREAK', breakId, '🔴 ON BREAK'
  ]).then(function(saved) {
    if (saved && saved.ok) {
      // Update the index with the actual row number
      var newRowData = [dateToSerial(bd), userName, sType, sPeriod, breakType, timeToSerial(timeStr), '', '', '', '', userId, '', '🔴 ON BREAK', breakId, '🔴 ON BREAK'];
      activeBreakIndex.set(String(userId), { row: saved.row, data: newRowData });
      console.log('[BreakBot] Sheet append complete, row=' + saved.row);
    } else {
      // Sheet append failed — send correction
      console.warn('[BreakBot] Sheet append returned ok:false');
      sendMsg(CONFIG.breakGroupId,
        `⚠️ *CORRECTION* — ${userName}'s ${breakType} break FAILED to save to sheet. Please try /start again.`
      ).catch(() => {});
      if (CONFIG.breakGroupId !== String(chatId)) {
        sendMsg(chatId,
          `❌ *Failed to log ${breakType} break in sheet.*\nPlease try /start again or contact support.`
        ).catch(() => {});
      }
      activeBreakIndex.delete(String(userId));
    }
  }).catch(function(appendErr) {
    console.error('[BreakBot] Sheet append error:', appendErr.message);
    sendMsg(CONFIG.breakGroupId,
      `⚠️ *ERROR* — ${userName}'s ${breakType} break failed to save: ${appendErr.message}`
    ).catch(() => {});
    if (CONFIG.breakGroupId !== String(chatId)) {
      sendMsg(chatId,
        `❌ *Failed to log ${breakType} break in sheet.*\nPlease try /start again or contact support.`
      ).catch(() => {});
    }
    activeBreakIndex.delete(String(userId));
  });
}

// ============================================================
//  END BREAK
// ============================================================

async function endBreak(chatId, userId, userName) {
  console.log('[BreakBot] endBreak called:', { userId, userName });
  const now = new Date();
  const timeStr = fmtTime(now);

  const active = await getActiveBreakRow(userId);
  console.log('[BreakBot] Active break found:', active ? 'yes' : 'no', active ? 'row=' + active.row : '');
  if (!active) {
    return sendMsg(chatId, `❌ *${userName}*, no active break found to end!`);
  }

  const rowIndex = active.row;
  const d = active.data;

  const breakDate = parseDateCell(d[0]);
  const shiftPeriod = fmtCell(d[3]);
  const shiftType = fmtCell(d[2]);
  const breakType = fmtCell(d[4]);

  // --- DURATION CALCULATION USING UTC TIMESTAMPS ---
  // PH time = UTC+8, so we convert PH components to UTC for clean math.
  // This handles day/month/year boundaries correctly (no day-of-month hacks).
  var phNow = getPHComponents(new Date());

  var startStr = parseTimeCell(d[5]);
  var tp = startStr.split(':');
  var startH = parseInt(tp[0], 10) || 0;
  var startM = parseInt(tp[1], 10) || 0;
  var startS = parseInt(tp[2], 10) || 0;

  // Get the business date from the stored break date (Column A)
  // Use breakDate (parsed via parseDateCell) instead of raw d[0], because
  // readRange returns d[0] as the string "46204" when the cell has no DATE
  // format, and new Date("46204") yields Invalid Date → NaN → zero duration.
  var breakPH = getPHComponents(breakDate);

  // Convert PH date+time to UTC timestamps (PH = UTC+8)
  var startTs = Date.UTC(breakPH.year, breakPH.month - 1, breakPH.day, startH - 8, startM, startS);
  var endTs = Date.UTC(phNow.year, phNow.month - 1, phNow.day, phNow.hour - 8, phNow.min, phNow.sec);

  // Elapsed seconds in PH time (timestamp difference is timezone-independent)
  var diffSecs = Math.floor((endTs - startTs) / 1000);
  if (diffSecs < 0) diffSecs = 0;

  var remark = '';
  if (diffSecs > 3600) remark = 'LONG BREAK';

  const allowanceSecs = (shiftType === '12h') ? 7200 : 5400;
  const bd = getBusinessDate(breakDate, shiftPeriod);

  // Get previous totals — check cache FIRST (no API call on hit).
  // Cache key includes date+shift so it auto-expires per day.
  // Cache miss → read DAILY SUMMARY (5 rows, ~0.5s) instead of full CS BREAK (15+ rows, ~2s).
  const cacheKey = getTotalUsedCacheKey(userId, bd, shiftType, shiftPeriod);
  let prevSecs = totalUsedCache.has(cacheKey) ? totalUsedCache.get(cacheKey) : null;

  if (prevSecs === null) {
    // Cache miss — fast read from DAILY SUMMARY (only 5 rows)
    var summaryData = await readSummaryData();
    prevSecs = 0;
    if (summaryData) {
      var summaryDateStr = bd; // same business date format
      for (var si = 1; si < summaryData.length; si++) {
        var sDate = summaryData[si][0] instanceof Date ? fmtDate(summaryData[si][0], 'yyyy-MM-dd') : fmtCell(summaryData[si][0]);
        if (sDate === summaryDateStr && fmtCell(summaryData[si][1]) === userName && fmtCell(summaryData[si][2]) === (shiftType + ' (' + shiftPeriod + ')')) {
          var usedVal = summaryData[si][3];
          if (usedVal) prevSecs = parseDur(usedVal);
          break;
        }
      }
    }
  }

  const finalTotal = prevSecs + diffSecs;
  totalUsedCache.set(cacheKey, finalTotal); // cache for next endBreak (no re-read needed)
  const finalRemaining = allowanceSecs - finalTotal;
  const curHMS = fmtHMS(diffSecs);
  const totalHMS = fmtHMS(finalTotal);
  const remHMS = fmtRemaining(finalRemaining);

  // Determine final remark before any I/O
  let finalRemark = remark;
  if (finalTotal > allowanceSecs) {
    finalRemark = 'OVERBREAK';
  }


  // ===== SEND INSTANT FEEDBACK — user sees response in <1s =====
  const phTime = fmtTime(now, "Asia/Manila");
  const bkkTime = fmtTime(now, "Asia/Bangkok");

  // Group notification (fast)
  await sendMsg(CONFIG.breakGroupId,
    `🟢 *BREAK ENDED*\n👤 ${userName}\n☕ ${breakType}\n⏱️ *Duration:* ${curHMS}\n📊 *Total:* ${totalHMS}\n⏳ *Remaining:* ${remHMS}\n🕐 ${bkkTime} BKK / ${phTime} PH`
  ).catch(function() {});

  // Personal confirmation IMMEDIATELY (fast — just Telegram API, no sheet I/O)
  if (CONFIG.breakGroupId !== String(chatId)) {
    await sendMsg(chatId,
      `✅ *Break ended*\n☕ ${breakType}\n⏱️ ${curHMS}\n📊 Total: ${totalHMS}\n⏳ Remaining: ${remHMS}`
    ).catch(function() {});
  }

  // Remove from active break index (user no longer on break)
  activeBreakIndex.delete(String(userId));

  // ===== SHEET OPERATIONS — ASYNC (don't block user) =====
  // These run in the background. If they fail, a correction is sent.
  // Local buffer ensures data survives a server restart.
  (async function() {
    // Save to local buffer FIRST — instant, no network I/O
    buffer.addPending('end', {
      breakId: breakIdFromRow(d),
      rowIndex: rowIndex, timeStr: timeStr, curHMS: curHMS,
      remHMS: remHMS, finalRemark: finalRemark || '', totalHMS: totalHMS,
      bd: bd, userName: userName, shiftType: shiftType, shiftPeriod: shiftPeriod
    });
    try {
      if (finalRemark === 'OVERBREAK') {
        await trackOverbreak(userName, userId, shiftType, shiftPeriod, breakType, startStr, timeStr, curHMS, bd);
      }
      await writeEndBreakToSheet(rowIndex, timeStr, curHMS, remHMS, finalRemark, totalHMS);
      await updateDailySummary(bd, userName, shiftType, shiftPeriod, totalHMS, remHMS);
    } catch (sheetErr) {
      console.error('[BreakBot] endBreak sheet error:', sheetErr.message);
      sendMsg(CONFIG.breakGroupId,
        `⚠️ *CORRECTION* — ${userName}'s ${breakType} end-break failed to save: ${sheetErr.message}`
      ).catch(function() {});
      if (CONFIG.breakGroupId !== String(chatId)) {
        sendMsg(chatId,
          `⚠️ *Break ended but sheet save failed.*\nError: ${sheetErr.message}`
        ).catch(function() {});
      }
    }
  })();
}

/**
 * Write end-break values to the CS BREAK sheet via single batchUpdate.
 * Extracted from endBreak for clearer error handling.
 */
async function writeEndBreakToSheet(rowIndex, timeStr, curHMS, remHMS, finalRemark, totalHMS) {
  const statusIcon = finalRemark ? ("⚠️ " + finalRemark) : "🟢 RETURNED";
  const batchSid = await getBreakSheetId(SH);
  if (batchSid) {
    const ri = rowIndex - 1; // 0-indexed
    const reqs = [];

    // G-J: End Time (serial+TIME), Duration (serial+TIME), Remaining (text), Remark (text)
    reqs.push({
      updateCells: {
        range: { sheetId: batchSid, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 6, endColumnIndex: 10 },
        rows: [{ values: [
          { userEnteredValue: { numberValue: timeToSerial(timeStr) }, userEnteredFormat: { numberFormat: { type: 'TIME', pattern: 'HH:mm:ss' } } },
          { userEnteredValue: { numberValue: timeToSerial(curHMS) }, userEnteredFormat: { numberFormat: { type: 'TIME', pattern: 'HH:mm:ss' } } },
          { userEnteredValue: { stringValue: remHMS } },
          { userEnteredValue: { stringValue: finalRemark } }
        ] }],
        fields: 'userEnteredValue,userEnteredFormat.numberFormat'
      }
    });

    // L-M: Total Used (serial+TIME), Status (text)
    reqs.push({
      updateCells: {
        range: { sheetId: batchSid, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 11, endColumnIndex: 13 },
        rows: [{ values: [
          { userEnteredValue: { numberValue: timeToSerial(totalHMS) }, userEnteredFormat: { numberFormat: { type: 'TIME', pattern: 'HH:mm:ss' } } },
          { userEnteredValue: { stringValue: statusIcon } }
        ] }],
        fields: 'userEnteredValue,userEnteredFormat.numberFormat'
      }
    });

    // O: Notes (text)
    reqs.push({
      updateCells: {
        range: { sheetId: batchSid, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 14, endColumnIndex: 15 },
        rows: [{ values: [
          { userEnteredValue: { stringValue: statusIcon } }
        ] }],
        fields: 'userEnteredValue'
      }
    });

    // A (DATE) + F (TIME) — already have values from startBreak, just apply format
    reqs.push({ repeatCell: { range: { sheetId: batchSid, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 0, endColumnIndex: 1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } }, fields: 'userEnteredFormat.numberFormat' }});
    reqs.push({ repeatCell: { range: { sheetId: batchSid, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 5, endColumnIndex: 6 },
      cell: { userEnteredFormat: { numberFormat: { type: 'TIME', pattern: 'HH:mm:ss' } } }, fields: 'userEnteredFormat.numberFormat' }});

    // One API call: 3 value writes + 2 format-only = values+formats applied together
    await breakBatchUpdate(SH, reqs);
    console.log('[BreakBot] endBreak: batch update (' + reqs.length + ' reqs, values+formats)');
  } else {
    // Fallback: no sheet ID cached (should never happen after first format)
    console.warn('[BreakBot] endBreak: sheet ID not cached, using fallback writes');
    await breakUpdateRange(SH, `CS BREAK!G${rowIndex}:J${rowIndex}`, [[
      timeToSerial(timeStr), timeToSerial(curHMS), remHMS, finalRemark
    ]]);
    await breakUpdateRange(SH, `CS BREAK!L${rowIndex}:M${rowIndex}`, [[
      timeToSerial(totalHMS), statusIcon
    ]]);
    await breakUpdateRange(SH, `CS BREAK!O${rowIndex}`, [[statusIcon]]);
    reapplyBreakNumberFormats(SH).catch(function(err) {
      console.error('[BreakBot] fallback format error:', err ? err.message : 'unknown');
    });
  }
}

// ============================================================
//  DAILY SUMMARY
// ============================================================

async function updateDailySummary(date, user, shift, period, totalUsed, remaining) {
  const data = await readSummaryData();
  let rowIndex = -1;
  if (data) {
    for (let i = 1; i < data.length; i++) {
      const rd = data[i][0] instanceof Date ? fmtDate(data[i][0], 'yyyy-MM-dd') : fmtCell(data[i][0]);
      if (rd === date && fmtCell(data[i][1]) === user && fmtCell(data[i][2]) === shift + " (" + period + ")") {
        rowIndex = i + 1;
        break;
      }
    }
  }

  if (rowIndex !== -1) {
    await breakUpdateRange(SH, `DAILY SUMMARY!C${rowIndex}:E${rowIndex}`, [[
      `${shift} (${period})`, timeToSerial(totalUsed), remaining
    ]]);
  } else {
    await breakAppendRow(SH, 'DAILY SUMMARY!A:E', [
      dateToSerial(date), user, `${shift} (${period})`, timeToSerial(totalUsed), remaining
    ]);
  }
}

// ============================================================
//  USER HISTORY
// ============================================================

async function sendUserHistory(chatId, userId, userName) {
  const data = await readBreakData();
  if (!data || data.length < 2) {
    return sendMsg(chatId, `*${userName}*\n\n_No breaks recorded._`);
  }

  var phComponents = getPHComponents(new Date());
  var today = formatYMD(phComponents.year, phComponents.month, phComponents.day);
  var phNowH = phComponents.hour;

  let shiftType = 'Not Set';
  let allowance = 0;
  const breaks = [];

  for (let i = 1; i < data.length; i++) {
    if (fmtCell(data[i][10]) !== String(userId)) continue;
    const shift = fmtCell(data[i][2]);
    if (shift === 'RESET') continue;
    if (fmtCell(data[i][4]) === 'SHIFT_SET') continue;
    if (!data[i][0]) continue;

    const period = fmtCell(data[i][3]);
    const rawDate = data[i][0] instanceof Date ? fmtDate(data[i][0], "yyyy-MM-dd") : (typeof data[i][0] === 'number' ? fmtDate(parseDateCell(data[i][0]), "yyyy-MM-dd") : String(data[i][0]).substring(0, 10));
    if (rawDate !== today) continue;

    // PH time sanity check: skip if break's start hour is > current PH hour + 1
    // (catches NightShift rows with wrong business dates from old timezone bug)
    var startH = parseInt(parseTimeCell(data[i][5]).split(':')[0], 10);
    if (startH > phNowH + 1) continue;

    // SHIFT PERIOD MATCH: if current PH time is Night (0-11AM) but break started during
    // Day (12-11:59PM), the break is from the previous shift — skip it.
    // This ensures history only shows breaks from the CURRENT shift period.
    // Day Shift = 12PM-11:59PM, Night Shift = 12AM-11:59AM
    var phPeriod = (phNowH >= 12) ? 'day' : 'night';
    var breakPeriod = (startH >= 12) ? 'day' : 'night';
    if (phPeriod !== breakPeriod) continue;

    if (shift && shiftType === 'Not Set' && (shift === '8h' || shift === '12h')) {
      shiftType = `${shift} (${period || 'Unknown'})`;
      allowance = shift === '8h' ? 5400 : 7200;
    }

    const start = parseTimeCell(data[i][5]);
    const end = data[i][6] ? parseTimeCell(data[i][6]) : '';
    // Recalculate duration from raw start/end times (timezone-independent math)
    let dur = '00:00:00';
    let durSecs = 0;
    if (end && start) {
      var sp = String(start).split(':').map(Number);
      var ep = String(end).split(':').map(Number);
      if (sp.length >= 2 && ep.length >= 2) {
        var startSecs = sp[0] * 3600 + (sp[1] || 0) * 60 + (sp[2] || 0);
        var endSecs = ep[0] * 3600 + (ep[1] || 0) * 60 + (ep[2] || 0);
        durSecs = endSecs - startSecs;
        if (durSecs < 0) durSecs += 86400; // midnight rollover
        if (durSecs > 86400) durSecs = 86400; // sanity cap
        dur = fmtHMS(durSecs);
      }
    }

    breaks.push({
      type: fmtCell(data[i][4]),
      start, end, duration: dur, durSecs,
      remark: fmtCell(data[i][9]),
      isActive: !end
    });
  }

  if (breaks.length === 0) {
    return sendMsg(chatId, `👤 *${userName}* | ⏰ ${shiftType} | 📅 ${today}\n\n_No breaks recorded._`);
  }

  let list = '';
  let totalSecs = 0;
  let activeInfo = null;

  for (const b of breaks) {
    if (b.isActive) { activeInfo = b; continue; }
    if (b.durSecs > 0) {
      list += `• *${b.type}*: ${b.duration} (${b.start}-${b.end})`;
      if (b.remark && !['AUTO-CLOSED'].includes(b.remark))
        list += ` ⚠️ *${b.remark}*`;
      list += '\n';
      totalSecs += b.durSecs;
    }
  }

  if (activeInfo) list = `🔴 *ACTIVE:* ${activeInfo.type} since ${activeInfo.start}\n\n${list}`;
  if (!list) list = '_No completed breaks._\n';

  const remain = allowance > 0 ? fmtRemaining(allowance - totalSecs) : 'N/A';
  return sendMsg(chatId,
    `👤 *${userName}* | ⏰ ${shiftType} | 📅 ${today}\n\n${list}\n⏱️ *Total:* ${fmtHMS(totalSecs)}\n⏳ *Remaining:* ${remain}`
  );
}

// ============================================================
//  OVERBREAK TRACKER
// ============================================================

async function trackOverbreak(userName, userId, shiftType, shiftPeriod, breakType, startTime, endTime, duration, businessDate) {
  try {
    await getOrCreateSheet(SH, 'OVERBREAK_TRACKER');
    const data = await readRange(SH, 'OVERBREAK_TRACKER!A:A');
    if (!data || data.length === 0 || !data[0][0]) {
      // Apply professional formatting to overbreak sheet
      try { await formatBreakSheets(SH); } catch (e) {}
    }
    const now = new Date();
    await appendRow(SH, 'OVERBREAK_TRACKER!A:H', [
      fmtDate(now, 'yyyy-MM-dd HH:mm:ss'), userName, userId, shiftType, shiftPeriod, breakType,
      `${startTime} → ${endTime}`, duration
    ]);
  } catch (err) {
    console.error('[BreakBot] Overbreak track error:', err.message);
  }
}

// ============================================================
//  DASHBOARD DATA API (matches existing /api/breaks/dashboard)
// ============================================================

async function getDashboardData() {
  try {
    const data = await readBreakData();
    if (!data || data.length < 2) {
      return { onBreak: [], dailySummary: [], breakHistory: [], violations: [], date: '' };
    }

    const phNow = toPH(new Date());
    const todayStr = fmtDate(phNow, 'yyyy-MM-dd');

    const onBreak = [];
    const dailyMap = {};
    const breakHistory = [];
    const violations = [];
    const userShiftMap = {};
    const seenViolationUsers = {}; // Track unique users for violation dedup

    // First pass: shift info
    for (let i = 1; i < data.length; i++) {
      const userId = fmtCell(data[i][10]);
      const shift = fmtCell(data[i][2]);
      const period = fmtCell(data[i][3]);
      const btype = fmtCell(data[i][4]);
      const rowDate = data[i][0];
      const userName = fmtCell(data[i][1]);

      if (!userId || !rowDate || shift === 'RESET' || btype === 'SHIFT_SET') continue;
      if (shift !== '8h' && shift !== '12h') continue;

      const bd = getBusinessDate(parseDateCell(rowDate), period);
      if (bd === todayStr) {
        if (!userShiftMap[userId]) userShiftMap[userId] = { userName, shift, period };
      }
    }

    // Second pass: breaks
    for (let i = 1; i < data.length; i++) {
      const userId = fmtCell(data[i][10]);
      const userName = fmtCell(data[i][1]);
      const shift = fmtCell(data[i][2]);
      const period = fmtCell(data[i][3]);
      const btype = fmtCell(data[i][4]);
      const startRaw = data[i][5];
      const endRaw = data[i][6];
      const durRaw = data[i][7];
      const remark = fmtCell(data[i][9]);
      const rowDate = data[i][0];

      if (!userId || !rowDate || shift === 'RESET' || btype === 'SHIFT_SET' || !btype) continue;

      const bd = getBusinessDate(parseDateCell(rowDate), period);
      if (bd !== todayStr) continue;
      // Skip breaks with future start times
      if (bd === todayStr) {
        var stH = parseInt(parseTimeCell(startRaw).split(':')[0], 10);
        var nH = new Date().getHours();
        if (stH > nH + 1) continue;
      }
      const startTime = parseTimeCell(startRaw);
      const endTime = endRaw ? parseTimeCell(endRaw) : '';
      const durSecs = parseDur(durRaw);
      const durStr = fmtHMS(durSecs);
      const uInfo = userShiftMap[userId] || {};
      const finalName = userName || uInfo.userName || 'Unknown';

      // Active
      if (!endTime && startTime) {
        onBreak.push({ userName: finalName, breakType: btype, startTime, startTimestamp: getStartTimestamp(startTime) });
      }

      // Completed
      if (endTime && durSecs > 0) {
        breakHistory.push({ userName: finalName, type: btype, start: startTime, end: endTime, duration: durStr, remark });
        if (remark === 'OVERBREAK' || remark === 'LONG BREAK') {
          // Deduplicate: only one violation per staff member (keep highest severity)
          var existingIdx = seenViolationUsers[finalName];
          if (existingIdx === undefined) {
            seenViolationUsers[finalName] = violations.length;
            violations.push({ userName: finalName, type: btype, start: startTime, end: endTime, duration: durStr, remark });
          } else if (remark === 'OVERBREAK' && violations[existingIdx].remark !== 'OVERBREAK') {
            // Upgrade from LONG BREAK to OVERBREAK if higher severity
            violations[existingIdx] = { userName: finalName, type: btype, start: startTime, end: endTime, duration: durStr, remark };
          }
        }
      }

      // Daily totals
      if (durSecs > 0) {
        var mapKey = userId + '_' + shift + '_' + period;
      if (!dailyMap[mapKey]) {
          dailyMap[mapKey] = {
            userName: finalName, userId,
            shift: `${shift}${period ? ' (' + period + ')' : ''}`,
            totalSeconds: 0, allowanceSeconds: shift === '12h' ? 7200 : 5400
          };
        }
        dailyMap[mapKey].totalSeconds += durSecs;
        dailyMap[mapKey].userName = finalName;
      }
    }

    const dailySummary = Object.values(dailyMap).map(d => {
      const remaining = d.allowanceSeconds - d.totalSeconds;
      const isOver = d.totalSeconds > d.allowanceSeconds;
      return {
        userName: d.userName, userId: d.userId, shift: d.shift,
        used: fmtHMS(d.totalSeconds),
        remaining: isOver ? '-' + fmtHMS(Math.abs(remaining)) : fmtHMS(remaining),
        status: isOver ? 'Overbreak' : 'Good',
        statusClass: isOver ? 'badge-critical' : 'badge-success',
        statusIcon: isOver ? '⚠️' : '✅',
        totalSeconds: d.totalSeconds, allowanceSeconds: d.allowanceSeconds
      };
    });
    dailySummary.sort((a, b) => a.userName.localeCompare(b.userName));

    return {
      onBreak,
      dailySummary,
      breakHistory: breakHistory.slice(-100).reverse(),
      violations: violations.slice(-50).reverse(),
      date: todayStr
    };
  } catch (err) {
    console.error('[BreakBot] Dashboard data error:', err.message);
    return { onBreak: [], dailySummary: [], breakHistory: [], violations: [], date: '' };
  }
}

module.exports = {
  handleBreakUpdate,
  getDashboardData,
  archiveOldData,
  startBreak,
  endBreak,
  writeEndBreakToSheet,
  updateDailySummary,
  activeBreakIndex
};

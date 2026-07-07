/**
 * Google Apps Script — CS Break Tracker Admin Tools + Dashboard API
 * ================================================================
 * FIXED July 7, 2026: Timezone bug — was adding +1h offset (BKK assumption)
 * when script already runs on UTC+8 (PH time). Now uses Asia/Manila explicitly.
 *
 * FEATURES:
 * 1. Custom Menu (onOpen) — Edit break type, Delete & Recalculate,
 *    Manual end break, Fix duration, and more
 * 2. Dashboard JSON API (doGet) — for Tab5 Break Tracker
 * 3. Helper functions
 *
 * SETUP: Deploy as Web App, execute as "Me", access "Anyone".
 *        Also run onOpen once to authorize or refresh the sheet.
 */

// ============================================================
//  CUSTOM MENU (appears when sheet is opened)
// ============================================================

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('☕ Break Tools')
    .addItem('✏️ Edit Break Type', 'showEditBreakType')
    .addItem('🗑️ Delete Row & Recalculate', 'showDeleteRecalculate')
    .addItem('⏹️ Manual End Break', 'showManualEndBreak')
    .addItem('🔄 Fix Duration Time', 'showFixDuration')
    .addItem('📊 Recalculate Daily Summary', 'recalcDailySummary')
    .addSeparator()
    .addItem('📋 Show Active Breaks', 'showActiveBreaks')
    .addItem('❓ Help', 'showHelp')
    .addToUi();
}

// ============================================================
//  GENERIC HELPERS
// ============================================================

/** Timezone constant — PH time (UTC+8) */
var TZ_PH = 'Asia/Manila';

function getBreakSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CS BREAK');
}

function getSummarySheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DAILY SUMMARY');
}

function getAllBreakData() {
  var sheet = getBreakSheet();
  if (!sheet) return [];
  return sheet.getDataRange().getValues();
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatSecsToHMS(s) {
  var totalSecs = Math.round(Math.abs(Number(s) || 0));
  var hours = Math.floor(totalSecs / 3600);
  var minutes = Math.floor((totalSecs % 3600) / 60);
  var seconds = totalSecs % 60;
  return pad(hours) + ':' + pad(minutes) + ':' + pad(seconds);
}

function parseHMS(str) {
  if (!str) return 0;
  var m = String(str).match(/(\d+):(\d+):(\d+)/);
  if (m) return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
  return 0;
}

/**
 * Format a cell value as HH:mm:ss time string.
 * Handles Date objects (from serial numbers) and plain strings.
 * FIXED: Uses Asia/Manila timezone explicitly.
 */
function formatTimeSafe(value) {
  if (!value) return '';
  if (value instanceof Date) {
    if (value.getFullYear() === 1899) {
      return pad(value.getHours()) + ':' + pad(value.getMinutes()) + ':' + pad(value.getSeconds());
    }
    return Utilities.formatDate(value, TZ_PH, 'HH:mm:ss');
  }
  return value.toString();
}

/**
 * Get current PH time as HH:mm:ss string.
 * FIXED: Uses Utilities.formatDate with Asia/Manila instead of manual +1h offset.
 */
function getNowPHTime() {
  return Utilities.formatDate(new Date(), TZ_PH, 'HH:mm:ss');
}

/**
 * Get today's date in PH timezone as YYYY-MM-DD.
 * FIXED: Uses TZ_PH directly, no manual offset.
 */
function getTodayPHStr() {
  return Utilities.formatDate(new Date(), TZ_PH, 'yyyy-MM-dd');
}

/**
 * Convert a date to PH timezone Date object.
 * FIXED: Uses Utilities.formatDate-based approach instead of manual +1h offset.
 */
function toPhilippineTime(date) {
  if (!(date instanceof Date)) date = new Date(date);
  var str = Utilities.formatDate(date, TZ_PH, 'yyyy-MM-dd HH:mm:ss');
  // Parse back to a Date that appears as PH time in getHours()/getDate()
  var parts = str.split(/[\/\s\-:]+/);
  return new Date(parts[0], parseInt(parts[1]) - 1, parts[2], parts[3], parts[4], parts[5]);
}

/**
 * Get business date for a given date and shift type.
 * FIXED: Uses TZ_PH consistently.
 */
function getBusinessDate(date, shiftType) {
  if (!(date instanceof Date)) date = new Date(date);
  var phDate = toPhilippineTime(date);
  var hour = phDate.getHours();
  if (shiftType === 'Graveyard' || shiftType === 'NightShift') {
    if (hour >= 0 && hour < 12) {
      return Utilities.formatDate(phDate, TZ_PH, 'yyyy-MM-dd');
    } else {
      var tomorrow = new Date(phDate);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return Utilities.formatDate(tomorrow, TZ_PH, 'yyyy-MM-dd');
    }
  } else {
    return Utilities.formatDate(phDate, TZ_PH, 'yyyy-MM-dd');
  }
}

// ============================================================
//  ROW PICKER — shows a numbered list to select from
// ============================================================

function pickBreakRow(promptText) {
  var data = getAllBreakData();
  if (data.length < 2) {
    SpreadsheetApp.getUi().alert('No break data found.');
    return null;
  }

  var startIdx = Math.max(1, data.length - 50);
  var labels = [];
  var rowMap = [];

  for (var i = data.length - 1; i >= startIdx; i--) {
    var r = data[i];
    var name = r[1] || 'Unknown';
    var type = r[4] || '';
    var start = formatTimeSafe(r[5]);
    var end = formatTimeSafe(r[6]);
    var date = r[0] instanceof Date ? Utilities.formatDate(r[0], TZ_PH, 'MM-dd') : r[0];
    var status = end ? '✅' : '🔴';
    labels.push(status + ' ' + name + ' | ' + type + ' | ' + date + ' ' + start + (end ? '-' + end : ' ONGOING'));
    rowMap.push(i + 1);
  }

  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt(
    promptText || 'Select a break row',
    'Enter the NUMBER from the list below:\n\n' + labels.map(function(l, idx) {
      return (idx + 1) + '. ' + l;
    }).join('\n') + '\n\nEnter row number (1-' + labels.length + '):',
    ui.ButtonSet.OK_CANCEL
  );

  if (result.getSelectedButton() !== ui.Button.OK) return null;

  var choice = parseInt(result.getResponseText(), 10);
  if (isNaN(choice) || choice < 1 || choice > rowMap.length) {
    ui.alert('Invalid selection.');
    return null;
  }

  var actualRow = rowMap[choice - 1];
  return { rowIndex: actualRow, rowData: data[actualRow - 1] };
}

// ============================================================
//  TOOL 1 — EDIT BREAK TYPE
// ============================================================

function showEditBreakType() {
  var picked = pickBreakRow('✏️ EDIT BREAK TYPE\nSelect which break to edit:');
  if (!picked) return;

  var ui = SpreadsheetApp.getUi();
  var currentType = picked.rowData[4] || 'N/A';

  var result = ui.prompt(
    '✏️ Edit Break Type',
    'Current type: ' + currentType + '\n\nNew break type (Meal, Bio, Smoke, Relax, Snack, Prayer, Emergency):',
    ui.ButtonSet.OK_CANCEL
  );

  if (result.getSelectedButton() !== ui.Button.OK) return;

  var newType = result.getResponseText().trim();
  var validTypes = ['Meal', 'Bio', 'Smoke', 'Relax', 'Snack', 'Prayer', 'Emergency'];
  if (validTypes.indexOf(newType) === -1) {
    ui.alert('Invalid break type. Must be one of: ' + validTypes.join(', '));
    return;
  }

  var sheet = getBreakSheet();
  sheet.getRange(picked.rowIndex, 5).setValue(newType);
  ui.alert('✅ Break type updated to "' + newType + '" for row ' + picked.rowIndex + '.');
}

// ============================================================
//  TOOL 2 — DELETE ROW & RECALCULATE
// ============================================================

function showDeleteRecalculate() {
  var picked = pickBreakRow('🗑️ DELETE ROW\nSelect which break to delete:');
  if (!picked) return;

  var ui = SpreadsheetApp.getUi();
  var name = picked.rowData[1] || 'Unknown';
  var type = picked.rowData[4] || 'Unknown';

  var confirm = ui.alert(
    '🗑️ Confirm Delete',
    'Delete break: ' + name + ' - ' + type + ' (Row ' + picked.rowIndex + ')?\n\nThis will remove the row AND recalculate daily totals.',
    ui.ButtonSet.YES_NO
  );

  if (confirm !== ui.Button.YES) return;

  var sheet = getBreakSheet();
  sheet.deleteRow(picked.rowIndex);

  recalcDailySummary();

  ui.alert('✅ Row ' + picked.rowIndex + ' deleted and daily summary recalculated.');
}

// ============================================================
//  TOOL 3 — MANUAL END BREAK
// ============================================================

function showManualEndBreak() {
  var data = getAllBreakData();
  var ui = SpreadsheetApp.getUi();

  var activeRows = [];
  for (var i = 1; i < data.length; i++) {
    var endRaw = data[i][6];
    var shift = data[i][2] ? data[i][2].toString() : '';
    var btype = data[i][4] ? data[i][4].toString() : '';
    if ((!endRaw || endRaw.toString().trim() === '') && shift !== 'RESET' && btype !== 'SHIFT_SET') {
      activeRows.push({ rowIndex: i + 1, rowData: data[i] });
    }
  }

  if (activeRows.length === 0) {
    ui.alert('✅ No active breaks found.');
    return;
  }

  var labels = activeRows.map(function(r, idx) {
    return (idx + 1) + '. ' + (r.rowData[1] || 'Unknown') + ' | ' + (r.rowData[4] || '') +
           ' | Started: ' + formatTimeSafe(r.rowData[5]);
  });

  var result = ui.prompt(
    '⏹️ MANUAL END BREAK\nSelect which active break to end:',
    labels.join('\n') + '\n\nEnter row number (1-' + activeRows.length + '):',
    ui.ButtonSet.OK_CANCEL
  );

  if (result.getSelectedButton() !== ui.Button.OK) return;

  var choice = parseInt(result.getResponseText(), 10);
  if (isNaN(choice) || choice < 1 || choice > activeRows.length) {
    ui.alert('Invalid selection.');
    return;
  }

  var active = activeRows[choice - 1];
  var rowIndex = active.rowIndex;
  var d = active.rowData;

  var startStr = formatTimeSafe(d[5]);
  var sp = startStr.split(':').map(Number);
  var nowStr = getNowPHTime();               // ✅ Fixed: now returns correct PH time
  var np = nowStr.split(':').map(Number);

  var startSecs = sp[0] * 3600 + (sp[1] || 0) * 60 + (sp[2] || 0);
  var endSecs = np[0] * 3600 + (np[1] || 0) * 60 + (np[2] || 0);
  var durSecs = endSecs - startSecs;
  if (durSecs < 0) durSecs += 86400;

  var durStr = formatSecsToHMS(durSecs);
  var userId = String(d[10] || '');
  var shiftType = d[2] ? d[2].toString() : '';
  var shiftPeriod = d[3] ? d[3].toString() : '';
  var allowance = (shiftType === '12h') ? 7200 : 5400;

  var prevSecs = 0;
  if (userId) {
    for (var j = 1; j < data.length; j++) {
      if (j === rowIndex - 1) continue;
      if (String(data[j][10] || '') !== userId) continue;
      var rShift = data[j][2] ? data[j][2].toString() : '';
      var rPeriod = data[j][3] ? data[j][3].toString() : '';
      var rd = getBusinessDate(new Date(data[j][0]), rPeriod);
      if (rd === getTodayPHStr() && rShift === shiftType && rPeriod === shiftPeriod && data[j][7]) {
        prevSecs += parseHMS(data[j][7]);
      }
    }
  }

  var finalTotal = prevSecs + durSecs;
  var rem = allowance - finalTotal;
  var remStr = rem >= 0 ? '✅ ' + formatSecsToHMS(rem) : '⚠️ Over: -' + formatSecsToHMS(Math.abs(rem));

  var remark = '';
  if (durSecs > 3600) remark = 'LONG BREAK';
  if (finalTotal > allowance) remark = 'OVERBREAK';
  var statusIcon = remark ? ('⚠️ ' + remark) : '🟢 RETURNED';

  var sheet = getBreakSheet();
  sheet.getRange(rowIndex, 7).setValue(nowStr);
  sheet.getRange(rowIndex, 8).setValue(durStr);
  sheet.getRange(rowIndex, 9).setValue(remStr);
  sheet.getRange(rowIndex, 10).setValue(remark);
  sheet.getRange(rowIndex, 12).setValue(formatSecsToHMS(finalTotal));
  sheet.getRange(rowIndex, 13).setValue(statusIcon);
  sheet.getRange(rowIndex, 15).setValue(statusIcon);

  recalcDailySummary();

  ui.alert(
    '✅ Break ended manually!\n\n' +
    d[1] + ' | ' + d[4] + '\n' +
    'Duration: ' + durStr + '\n' +
    'Total Used: ' + formatSecsToHMS(finalTotal) + '\n' +
    'Remark: ' + (remark || 'Normal')
  );
}

// ============================================================
//  TOOL 4 — FIX DURATION TIME
// ============================================================

function showFixDuration() {
  var picked = pickBreakRow('🔄 FIX DURATION\nSelect which break to fix:');
  if (!picked) return;

  var ui = SpreadsheetApp.getUi();
  var currentDur = formatTimeSafe(picked.rowData[7]) || '00:00:00';
  var name = picked.rowData[1] || 'Unknown';
  var type = picked.rowData[4] || 'Unknown';

  var result = ui.prompt(
    '🔄 Fix Duration',
    name + ' | ' + type + ' | Row ' + picked.rowIndex + '\n\nCurrent Duration: ' + currentDur + '\n\nEnter NEW duration (HH:MM:SS):',
    ui.ButtonSet.OK_CANCEL
  );

  if (result.getSelectedButton() !== ui.Button.OK) return;

  var newDur = result.getResponseText().trim();
  var m = newDur.match(/(\d+):(\d+):(\d+)/);
  if (!m) {
    ui.alert('Invalid format. Use HH:MM:SS (e.g. 00:15:30).');
    return;
  }

  var sheet = getBreakSheet();
  sheet.getRange(picked.rowIndex, 8).setValue(newDur);

  recalcDailySummary();

  ui.alert('✅ Duration updated to ' + newDur + ' for row ' + picked.rowIndex + '.\nDaily summary recalculated.');
}

// ============================================================
//  TOOL 5 — RECALCULATE DAILY SUMMARY
// ============================================================

function recalcDailySummary() {
  var data = getAllBreakData();
  var summarySheet = getSummarySheet();
  if (!summarySheet) return false;

  var today = getTodayPHStr();               // ✅ Fixed: uses corrected TZ_PH

  // Step 1: Calculate per-user totals from CS BREAK
  var userTotals = {};
  var userShiftInfo = {};

  for (var i = 1; i < data.length; i++) {
    var userId = data[i][10] ? data[i][10].toString() : '';
    var userName = data[i][1] ? data[i][1].toString() : 'Unknown';
    var shift = data[i][2] ? data[i][2].toString() : '';
    var period = data[i][3] ? data[i][3].toString() : '';
    var btype = data[i][4] ? data[i][4].toString() : '';
    var durRaw = data[i][7];
    var rowDate = data[i][0];

    if (!userId || !rowDate || shift === 'RESET' || btype === 'SHIFT_SET') continue;
    var bd = getBusinessDate(new Date(rowDate), period); // ✅ Fixed: uses TZ_PH internally
    if (bd !== today) continue;

    var durSecs = parseHMS(durRaw);
    if (durSecs <= 0) continue;

    var key = userId + '_' + shift + '_' + period;
    if (!userTotals[key]) {
      userTotals[key] = 0;
      userShiftInfo[key] = { userName: userName, shift: shift, period: period };
    }
    userTotals[key] += durSecs;
  }

  // Step 2: Clear and rewrite DAILY SUMMARY
  var summaryData = [['Date', 'User', 'Shift', 'Total Used', 'Remaining']];
  var keys = Object.keys(userTotals);
  keys.sort();

  for (var k = 0; k < keys.length; k++) {
    var u = userShiftInfo[keys[k]];
    var allowance = (u.shift === '12h') ? 7200 : 5400;
    var used = userTotals[keys[k]];
    var rem = allowance - used;
    var usedStr = formatSecsToHMS(used);
    var remStr = rem >= 0 ? formatSecsToHMS(rem) : '-' + formatSecsToHMS(Math.abs(rem));
    summaryData.push([today, u.userName, u.shift + ' (' + u.period + ')', usedStr, remStr]);
  }

  summarySheet.clear();
  for (var r = 0; r < summaryData.length; r++) {
    summarySheet.appendRow(summaryData[r]);
  }

  // Step 3: Update each row's Total (L) and Remaining (I) in CS BREAK for today
  var breakSheet = getBreakSheet();
  var runningTotals = {};

  for (var ii = 1; ii < data.length; ii++) {
    var uid = data[ii][10] ? data[ii][10].toString() : '';
    var sh = data[ii][2] ? data[ii][2].toString() : '';
    var per = data[ii][3] ? data[ii][3].toString() : '';
    var bt = data[ii][4] ? data[ii][4].toString() : '';
    var rd = data[ii][0];

    if (!uid || !rd || sh === 'RESET' || bt === 'SHIFT_SET') continue;
    var bd2 = getBusinessDate(new Date(rd), per); // ✅ Fixed: uses TZ_PH internally
    if (bd2 !== today) continue;

    var kk = uid + '_' + sh + '_' + per;
    var allowance2 = (sh === '12h') ? 7200 : 5400;

    // Accumulate running total up to this row
    if (!runningTotals[kk]) runningTotals[kk] = 0;
    var rowDur = data[ii][7];
    runningTotals[kk] += parseHMS(rowDur);

    var totalHere = runningTotals[kk];
    var remHere = allowance2 - totalHere;
    var remStrHere = remHere >= 0 ? '✅ ' + formatSecsToHMS(remHere) : '⚠️ Over: -' + formatSecsToHMS(Math.abs(remHere));
    var totalStrHere = formatSecsToHMS(totalHere);

    breakSheet.getRange(ii + 1, 12).setValue(totalStrHere);
    breakSheet.getRange(ii + 1, 9).setValue(remStrHere);
  }

  return true;
}

// ============================================================
//  TOOL 6 — SHOW ACTIVE BREAKS
// ============================================================

function showActiveBreaks() {
  var data = getAllBreakData();
  var ui = SpreadsheetApp.getUi();
  var activeLines = [];

  for (var i = 1; i < data.length; i++) {
    var endRaw = data[i][6];
    var shift = data[i][2] ? data[i][2].toString() : '';
    var btype = data[i][4] ? data[i][4].toString() : '';
    if ((!endRaw || endRaw.toString().trim() === '') && shift !== 'RESET' && btype !== 'SHIFT_SET') {
      var name = data[i][1] || 'Unknown';
      var type = data[i][4] || 'Unknown';
      var start = formatTimeSafe(data[i][5]);
      activeLines.push('🔴 ' + name + ' | ' + type + ' | Started: ' + start);
    }
  }

  if (activeLines.length === 0) {
    ui.alert('📋 Active Breaks', '✅ No active breaks.', ui.ButtonSet.OK);
  } else {
    ui.alert('📋 Active Breaks (' + activeLines.length + ')', activeLines.join('\n'), ui.ButtonSet.OK);
  }
}

// ============================================================
//  TOOL 7 — HELP
// ============================================================

function showHelp() {
  SpreadsheetApp.getUi().alert(
    '☕ CS Break Tracker Tools Help',
    '✏️ Edit Break Type — Change the break type (Meal/Bio/etc.) for a row.\n' +
    '🗑️ Delete Row & Recalculate — Remove a row and update all totals.\n' +
    '⏹️ Manual End Break — Force-end an active break with current time.\n' +
    '🔄 Fix Duration Time — Correct a break\'s duration, recalculates totals.\n' +
    '📊 Recalculate Daily Summary — Rebuild the DAILY SUMMARY sheet from scratch.\n' +
    '📋 Show Active Breaks — List all currently active (ongoing) breaks.',
    ui.ButtonSet.OK
  );
}

// ============================================================
//  DASHBOARD JSON API (for Tab5 Break Tracker)
// ============================================================

function doGet(e) {
  // Dashboard data endpoint: ?format=json&action=dashboard
  if (e && e.parameter && e.parameter.format === 'json' && e.parameter.action === 'dashboard') {
    try {
      var data = getDashboardData();
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        data: data,
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false,
        error: err.toString()
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // Legacy: List sheets
  if (!e) e = { parameter: {} };
  var action = e.parameter.action;
  if (!action) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheets = ss.getSheets().map(function(s) { return s.getName(); });
    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      spreadsheet: ss.getName(),
      sheets: sheets,
      message: 'CS Break Tracker Apps Script is alive.'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({
    ok: false, error: 'Unknown action: ' + action
  })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
//  DASHBOARD DATA — reads CS BREAK sheet, returns summary
// ============================================================

function getDashboardData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var breakSheet = ss.getSheetByName('CS BREAK');

  if (!breakSheet) {
    return { onBreak: [], dailySummary: [], timeAlerts: [], breakHistory: [], violationHistory: [] };
  }

  var now = new Date();
  var todayStr = Utilities.formatDate(now, TZ_PH, 'yyyy-MM-dd');  // ✅ Fixed: uses TZ_PH
  var data = breakSheet.getDataRange().getValues();

  var onBreak = [];
  var dailySummaryMap = {};
  var breakHistory = [];
  var timeAlerts = [];
  var violationHistory = [];
  var userShiftMap = {};
  var userAllowanceMap = {};
  var seenViolationUsers = {};

  // Pass 1: collect user shifts
  for (var i = 1; i < data.length; i++) {
    var userId = data[i][10] ? data[i][10].toString() : '';
    var shift = data[i][2] ? data[i][2].toString() : '';
    var period = data[i][3] ? data[i][3].toString() : '';
    var breakType = data[i][4] ? data[i][4].toString() : '';
    var rowDate = data[i][0];
    if (!userId || !rowDate) continue;
    if (shift === 'RESET' || breakType === 'SHIFT_SET') continue;

    var businessDate = getBusinessDate(new Date(rowDate), period); // ✅ Fixed: uses TZ_PH internally
    if (businessDate === todayStr && (shift === '8h' || shift === '12h')) {
      if (!userShiftMap[userId]) {
        userShiftMap[userId] = { userName: data[i][1] || 'Unknown', shift: shift, period: period };
        userAllowanceMap[userId] = (shift === '8h') ? 5400 : 7200;
      }
    }
  }

  // Pass 2: collect break data
  for (var i = 1; i < data.length; i++) {
    var userId = data[i][10] ? data[i][10].toString() : '';
    var userName = data[i][1] ? data[i][1].toString() : 'Unknown';
    var shift = data[i][2] ? data[i][2].toString() : '';
    var period = data[i][3] ? data[i][3].toString() : '';
    var breakType = data[i][4] ? data[i][4].toString() : '';
    var startRaw = data[i][5];
    var endRaw = data[i][6];
    var durationRaw = data[i][7];
    var remark = data[i][9] ? data[i][9].toString() : '';
    var rowDate = data[i][0];

    if (!userId || !rowDate) continue;
    if (shift === 'RESET' || breakType === 'SHIFT_SET') continue;

    var businessDate = getBusinessDate(new Date(rowDate), period); // ✅ Fixed: uses TZ_PH internally
    if (businessDate !== todayStr) continue;

    var userInfo = userShiftMap[userId] || {};
    if (!userName && userInfo.userName) userName = userInfo.userName;

    var startTime = formatTimeSafe(startRaw);  // ✅ Fixed: uses TZ_PH
    var endTime = endRaw ? formatTimeSafe(endRaw) : '';  // ✅ Fixed: uses TZ_PH
    var durationSecs = parseHMS(formatTimeSafe(durationRaw));  // ✅ Fixed: uses TZ_PH

    // ... rest stays the same
    var durationStr = formatSecsToHMS(durationSecs);

    // Currently on break
    if ((!endTime || endTime === '') && startTime && startTime !== '') {
      var startTimestamp = new Date();
      if (startRaw) {
        var timeParts = startTime.split(':');
        startTimestamp.setHours(parseInt(timeParts[0]), parseInt(timeParts[1]), parseInt(timeParts[2]), 0);
      }
      onBreak.push({
        userName: userName,
        breakType: breakType,
        startTime: startTime,
        startTimestamp: startTimestamp.getTime()
      });
    }

    // Completed breaks
    if (endTime && durationSecs > 0) {
      breakHistory.push({
        userName: userName,
        type: breakType,
        start: startTime,
        end: endTime,
        duration: durationStr,
        remark: remark
      });

      if (remark === 'OVERBREAK' || remark === 'LONG BREAK') {
        var existingIdx = seenViolationUsers[userName];
        if (existingIdx === undefined) {
          seenViolationUsers[userName] = violationHistory.length;
          violationHistory.push({
            userName: userName,
            type: breakType,
            start: startTime,
            end: endTime,
            duration: durationStr,
            remark: remark
          });
        } else if (remark === 'OVERBREAK' && violationHistory[existingIdx].remark !== 'OVERBREAK') {
          violationHistory[existingIdx] = {
            userName: userName,
            type: breakType,
            start: startTime,
            end: endTime,
            duration: durationStr,
            remark: remark
          };
        }
      }
    }

    if (durationSecs > 0) {
      if (!dailySummaryMap[userId]) {
        dailySummaryMap[userId] = { totalSeconds: 0, userName: userName, shiftType: shift, shiftPeriod: period };
      }
      dailySummaryMap[userId].totalSeconds += durationSecs;
      dailySummaryMap[userId].userName = userName;
      dailySummaryMap[userId].shiftType = shift;
      dailySummaryMap[userId].shiftPeriod = period;
    }
  }

  var dailySummary = [];
  for (var uid in dailySummaryMap) {
    var d = dailySummaryMap[uid];
    var allowance = userAllowanceMap[uid] || 5400;
    var totalUsed = d.totalSeconds;
    var remaining = allowance - totalUsed;
    var isOver = totalUsed > allowance;

    dailySummary.push({
      userName: d.userName || 'Unknown',
      userId: uid,
      shift: d.shiftType + (d.shiftPeriod ? ' (' + d.shiftPeriod + ')' : ''),
      used: formatSecsToHMS(totalUsed),
      remaining: isOver ? '-' + formatSecsToHMS(Math.abs(remaining)) : formatSecsToHMS(remaining),
      status: isOver ? 'Overbreak' : 'Good',
      isOver: isOver,
      totalSeconds: totalUsed,
      allowanceSeconds: allowance
    });
  }

  dailySummary.sort(function(a, b) { return a.userName.localeCompare(b.userName); });

  for (var b = 0; b < onBreak.length; b++) {
    var nowTime = new Date();
    var startTime2 = new Date(onBreak[b].startTimestamp);
    var diffMinutes = Math.floor((nowTime - startTime2) / 60000);
    if (diffMinutes > 30) {
      timeAlerts.push({
        userName: onBreak[b].userName,
        type: 'longbreak',
        message: 'On break for ' + diffMinutes + ' min'
      });
    }
  }

  breakHistory.reverse();
  violationHistory.reverse();

  return {
    onBreak: onBreak,
    dailySummary: dailySummary,
    timeAlerts: timeAlerts,
    breakHistory: breakHistory.slice(0, 200),
    violationHistory: violationHistory.slice(0, 100)
  };
}

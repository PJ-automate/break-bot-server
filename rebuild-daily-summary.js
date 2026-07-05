/**
 * rebuild-daily-summary.js — Rebuild DAILY SUMMARY sheet from SQLite break records.
 *
 * Reads all ended breaks from the database, groups by (date, user, shift),
 * calculates totals, and writes to the DAILY SUMMARY sheet.
 * Also populates the daily_summary_cache for future use.
 *
 * Usage: node rebuild-daily-summary.js [days]
 *   days: number of days back to rebuild (default: 7, 0 = all)
 */

'use strict';

const db = require('./src/break-db');
const { initBreakAuth, readRange, breakUpdateRange, breakAppendRow, breakBatchUpdate, getOrCreateSheet, formatBreakSheets } = require('./src/google');
const CONFIG = require('./src/config');

const SH = CONFIG.breakSheetId;
const daysBack = parseInt(process.argv[2], 10) || 7;

function pad(n) { return String(n).padStart(2, '0'); }

function fmtHMS(s) {
  s = Math.round(Math.abs(Number(s) || 0));
  return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
}

function timeToSerial(timeStr) {
  if (!timeStr) return 0;
  var parts = String(timeStr).split(':');
  var h = parseInt(parts[0], 10) || 0;
  var m = parseInt(parts[1], 10) || 0;
  var s = parseInt(parts[2], 10) || 0;
  return (h * 3600 + m * 60 + s) / 86400;
}

function dateToSerial(dateStr) {
  if (typeof dateStr === 'number') return dateStr;
  var d = new Date(dateStr + 'T00:00:00Z');
  return (d.getTime() / 86400000) + 25569;
}

const ALLOWANCE = 7200; // 2 hours for 12h shift

async function rebuild() {
  db.initDB();
  await initBreakAuth();

  console.log('=== Rebuilding DAILY SUMMARY from SQLite ===');
  console.log('Days back: ' + (daysBack > 0 ? daysBack : 'ALL'));

  // Compute date range
  var today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  var startDate = '';
  if (daysBack > 0) {
    var d = new Date();
    d.setDate(d.getDate() - daysBack);
    startDate = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  }

  console.log('Date range: ' + (startDate || '(beginning)') + ' to ' + today);

  // Query all ended breaks
  var query = `SELECT business_date, user_name, shift_type, shift_period, duration_secs, remark
    FROM breaks WHERE status = 'ENDED' AND duration_secs > 0`;
  var params = [];
  if (startDate) {
    query += ' AND business_date >= ?';
    params.push(startDate);
  }
  query += ' ORDER BY business_date ASC, user_name ASC';

  var stmt = db.getDB().prepare(query);
  var rows = params.length > 0 ? stmt.all.apply(stmt, params) : stmt.all();
  console.log('Total ended breaks found: ' + rows.length);

  if (rows.length === 0) {
    console.log('No breaks to rebuild. Exiting.');
    return;
  }

  // Group by (date, user, shift_key)
  var summary = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var key = r.business_date + '|' + r.user_name + '|' + r.shift_type + ' (' + r.shift_period + ')';
    if (!summary[key]) {
      summary[key] = {
        date: r.business_date,
        user: r.user_name,
        shiftKey: r.shift_type + ' (' + r.shift_period + ')',
        totalSecs: 0
      };
    }
    summary[key].totalSecs += r.duration_secs || 0;
  }

  var entries = Object.values(summary);
  console.log('Unique summary entries to write: ' + entries.length);

  // Clear existing DAILY SUMMARY sheet
  try {
    await getOrCreateSheet(SH, 'DAILY SUMMARY');
    console.log('DAILY SUMMARY sheet ready');
  } catch (e) {
    console.error('Error ensuring sheet:', e.message);
    return;
  }

  // Read existing DAILY SUMMARY to check header
  var existingData = await readRange(SH, 'DAILY SUMMARY!A1:E1');
  var header = existingData && existingData[0] && existingData[0][0]
    ? existingData[0] : ['Date', 'User', 'Shift', 'Total Used', 'Remaining'];

  // Build rows for batch write
  var sheetRows = [header];
  for (var j = 0; j < entries.length; j++) {
    var e = entries[j];
    var remainingSecs = ALLOWANCE - e.totalSecs;
    var remStr = (remainingSecs >= 0 ? '' : '-') +
      Math.floor(Math.abs(remainingSecs) / 3600) + 'h ' +
      Math.floor((Math.abs(remainingSecs) % 3600) / 60) + 'm';

    sheetRows.push([
      dateToSerial(e.date),
      e.user,
      e.shiftKey,
      timeToSerial(fmtHMS(e.totalSecs)),
      remStr
    ]);
  }

  // Write all rows to DAILY SUMMARY in chunks to avoid timeouts
  var endRow = sheetRows.length;
  const CHUNK_SIZE = 100;
  const CHUNK_TIMEOUT = 120000;

  try {
    console.log('Writing ' + endRow + ' rows to DAILY SUMMARY (A1:E' + endRow + ') in chunks of ' + CHUNK_SIZE + '...');

    // Write header first
    await breakUpdateRange(SH, "'DAILY SUMMARY'!A1:E1", [sheetRows[0]]);
    console.log('✓ Header written');

    // Write data rows in chunks
    var written = 0;
    for (var start = 1; start < endRow; start += CHUNK_SIZE) {
      var chunkEnd = Math.min(start + CHUNK_SIZE, endRow);
      var chunkRows = sheetRows.slice(start, chunkEnd);
      await breakUpdateRange(SH, "'DAILY SUMMARY'!A" + (start + 1) + ":E" + chunkEnd, chunkRows);
      written += chunkRows.length;
      console.log('  Chunk ' + Math.ceil(start / CHUNK_SIZE) + ': rows ' + (start + 1) + '-' + chunkEnd + ' ✓');
    }
    console.log('✓ Wrote ' + written + ' data rows to DAILY SUMMARY');

    // Populate cache from the rebuilt data
    var cached = db.importSummaryCacheFromSheet(sheetRows);
    console.log('✓ Populated daily_summary_cache: ' + cached + ' entries');

    // Apply formatting (non-fatal if times out)
    try {
      await formatBreakSheets(SH);
      console.log('✓ Formatting applied');
    } catch (fmtErr) {
      console.log('Formatting warning (non-fatal): ' + fmtErr.message);
    }

    console.log('=== REBUILD COMPLETE ===');
    console.log('DAILY SUMMARY now has ' + endRow + ' rows (' + (endRow - 1) + ' data rows)');
  } catch (err) {
    console.error('Rebuild error: ' + err.message);
  }
}

rebuild().catch(function(err) {
  console.error('Fatal error: ' + err.message);
  process.exit(1);
});

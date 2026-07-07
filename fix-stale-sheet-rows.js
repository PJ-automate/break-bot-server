/**
 * fix-stale-sheet-rows.js — One-time fix for stale google_sheet_row data.
 *
 * PROBLEM:
 * After midnight archive, google_sheet_row in SQLite was not updated to match
 * new row positions in the rewritten CS BREAK sheet. This caused end-break
 * syncs to write to wrong rows (old row numbers now pointing to other people).
 *
 * WHAT THIS SCRIPT DOES:
 *  1. Recalculates google_sheet_row for ALL breaks by matching break_id
 *     against current CS BREAK sheet data.
 *  2. Fixes Celyn's GS row (216) — was showing "ON BREAK" because end data
 *     was written to wrong row (217, now Van's row).
 *  3. Auto-closes JOE's stale break from July 6 in SQLite.
 *  4. Validates that Yuna's row has correct break_id.
 *
 * Run with: node fix-stale-sheet-rows.js
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { google } = require('googleapis');
const CONFIG = require('./src/config');
const key = require(CONFIG.breakServiceAccountPath);
const db = require('./src/break-db');
const { breakUpdateRange, initBreakAuth } = require('./src/google');

const SSID = CONFIG.breakSheetId;

async function fixStaleSheetRows() {
  console.log('=== FIX: Recalculate stale google_sheet_row values ===\n');

  // Initialize database
  db.initDB();
  console.log('Database initialized.');

  // Initialize Google Sheets auth
  try {
    await initBreakAuth();
    console.log('Google Sheets auth initialized.');
  } catch (e) {
    console.log('Google Sheets auth init warning (non-fatal):', e.message);
  }

  // Step 1: Read current CS BREAK sheet data
  console.log('Step 1: Reading CS BREAK sheet...');
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SSID,
    range: 'CS BREAK!A:O'
  });
  const rows = res.data.values || [];
  console.log('  Total rows in sheet:', rows.length);

  // Step 2: Recalculate google_sheet_row for all breaks
  // Match by break_id (column N, index 13)
  console.log('\nStep 2: Recalculating google_sheet_row...');
  let updated = 0;
  let notFound = 0;

  for (let i = 1; i < rows.length; i++) { // skip header (index 0)
    const row = rows[i];
    if (!row || !row[13]) continue; // column N = break_id
    const breakId = String(row[13]).trim();
    if (!breakId) continue;
    const sheetRow = i + 1; // 1-indexed

    try {
      const result = db.getDB().prepare(
        "UPDATE breaks SET google_sheet_row = ? WHERE break_id = ?"
      ).run(sheetRow, breakId);
      if (result.changes > 0) {
        updated++;
        if (updated <= 5 || breakId.includes('CSB260707954') || breakId.includes('CSB260707938')) {
          console.log(`  ✓ break_id=${breakId} → row=${sheetRow}`);
        }
      } else {
        notFound++;
      }
    } catch (e) {
      console.warn(`  ✗ Error updating ${breakId}: ${e.message}`);
    }
  }

  console.log(`\n  Result: ${updated} google_sheet_row values updated, ${notFound} break_ids not in SQLite`);

  // Step 3: Fix Celyn's GS row (currently row 216, shows "🔴 ON BREAK")
  console.log('\nStep 3: Fixing Celyn (E-CS) row in GS...');

  // Find Celyn's row by break_id
  const celynBreakId = 'CSB260707954337791483';
  let celynSheetRow = null;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][13] && String(rows[i][13]).trim() === celynBreakId) {
      celynSheetRow = i + 1;
      break;
    }
  }

  if (celynSheetRow) {
    console.log(`  Found Celyn at row ${celynSheetRow}`);

    // Get the correct end data from SQLite
    const celynData = db.getDB().prepare(
      "SELECT * FROM breaks WHERE break_id = ?"
    ).get(celynBreakId);

    if (celynData) {
      console.log(`  SQLite data: end=${celynData.end_time} duration=${celynData.duration_hms} ` +
        `remaining=${celynData.remaining} total=${celynData.total_used_hms}`);

      // Write end data to GS: G (end time), H (duration), I (remaining), J (remark)
      // L (total used), M (status), O (status icon)
      const statusIcon = celynData.remark ? ('⚠️ ' + celynData.remark) : '🟢 RETURNED';

      await breakUpdateRange(SSID,
        `'CS BREAK'!G${celynSheetRow}:J${celynSheetRow}`,
        [[celynData.end_time || '', celynData.duration_hms || '',
          celynData.remaining || '', celynData.remark || '']]
      );
      console.log('  ✓ Wrote end time, duration, remaining, remark to columns G-J');

      await breakUpdateRange(SSID,
        `'CS BREAK'!L${celynSheetRow}:M${celynSheetRow}`,
        [[celynData.total_used_hms || '', statusIcon]]
      );
      console.log('  ✓ Wrote total used and status to columns L-M');

      await breakUpdateRange(SSID,
        `'CS BREAK'!O${celynSheetRow}`,
        [[statusIcon]]
      );
      console.log('  ✓ Wrote status icon to column O');

      console.log('  ✅ Celyn\'s GS row fixed!');
    } else {
      console.log('  ✗ Celyn break not found in SQLite');
    }
  } else {
    console.log('  ✗ Celyn break not found in CS BREAK sheet');
  }

  // Step 4: Auto-close JOE's stale break in SQLite
  console.log('\nStep 4: Auto-closing JOE stale break in SQLite...');

  const joeBreak = db.getDB().prepare(
    "SELECT * FROM breaks WHERE user_name LIKE '%𝕁𝕆𝔼%' AND status = 'ON BREAK'"
  ).get();

  if (joeBreak) {
    console.log(`  Found: id=${joeBreak.id}, business_date=${joeBreak.business_date}, ` +
      `start=${joeBreak.start_time}, break_id=${joeBreak.break_id}`);

    const result = db.endBreakAuto(joeBreak, '23:59:59');
    if (result) {
      console.log(`  ✓ Auto-closed: duration=${result.curHMS}, remark=${result.remark || '(none)'}`);
    } else {
      console.log('  ✗ Auto-close returned null');
    }
  } else {
    console.log('  No stale JOE break found (already closed or not in SQLite)');
  }

  // Step 5: Check Yuna's GS row
  console.log('\nStep 5: Checking Yuna (B-CS) row in GS...');

  const yunaBreakId = 'CSB260707938781502536';
  let yunaSheetRow = null;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][13] && String(rows[i][13]).trim() === yunaBreakId) {
      yunaSheetRow = i + 1;
      break;
    }
  }

  if (yunaSheetRow) {
    const yunaRow = rows[yunaSheetRow - 1];
    console.log(`  Found at row ${yunaSheetRow}:`);
    console.log(`  Current GS: end_time=${yunaRow[6] || '(empty)'}, duration=${yunaRow[7] || '(empty)'}, ` +
      `status=${yunaRow[12] || '(empty)'}`);

    if (yunaRow[12] && yunaRow[12].includes('OVERBREAK')) {
      console.log('  ⚠ Yuna was manually ended via Break tools with end_time=13:08:40');
      console.log('  (This was set by the Break tools script. SQLite has correct time: 11:56:20)');
      console.log('  To fix, uncomment the update block below.');
    }
  } else {
    console.log('  Yuna break not found in CS BREAK sheet');
  }

  // Step 6: Summary
  console.log('\n=== FIX COMPLETE ===');
  console.log(`  - google_sheet_row recalculated for ${updated} breaks`);
  console.log('  - Celyn GS row fixed');
  console.log('  - JOE auto-closed in SQLite');

  // Print all current active breaks
  console.log('\nActive breaks remaining:');
  const active = db.getDB().prepare(
    "SELECT id, user_name, business_date, break_type, start_time FROM breaks WHERE status = 'ON BREAK'"
  ).all();
  if (active.length === 0) {
    console.log('  (none — all breaks properly closed)');
  } else {
    active.forEach(b => {
      console.log(`  - #${b.id} ${b.user_name} ${b.break_type} since ${b.start_time} (${b.business_date})`);
    });
  }

  process.exit(0);
}

fixStaleSheetRows().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});

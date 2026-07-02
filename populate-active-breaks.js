/**
 * populate-active-breaks.js — ONE-TIME script.
 * Scans the CS BREAK sheet for active breaks (rows with no end time)
 * and writes them to active-breaks.json so the bot can load them instantly.
 */
'use strict';

const path = require('path');

// Load the bot's config and google client
process.chdir(path.join(__dirname, '..'));
const CONFIG = require('./src/config');
const { initBreakAuth, readRange, getBreakSheetId } = require('./src/google');

async function main() {
  console.log('[Populate] Initializing auth...');
  await initBreakAuth();

  console.log('[Populate] Reading CS BREAK sheet...');
  const data = await readRange(CONFIG.breakSheetId, 'CS BREAK!A:O');
  if (!data || data.length < 2) {
    console.log('[Populate] No data found');
    return;
  }

  console.log('[Populate] Total rows:', data.length - 1);

  const activeBreaks = {};
  let count = 0;

  for (let i = data.length - 1; i >= 1; i--) {
    const row = data[i];
    const userId = row[10] ? String(row[10]).trim() : '';
    const endTime = row[6];
    const shift = row[2] ? String(row[2]).trim() : '';
    const btype = row[4] ? String(row[4]).trim() : '';

    // Skip if no user ID, or if break is ended (has end time), or if it's a RESET/SHIFT_SET row
    if (!userId) continue;
    if (endTime && String(endTime).trim() !== '') continue;
    if (shift === 'RESET' || btype === 'SHIFT_SET') continue;
    if (shift !== '8h' && shift !== '12h') continue;

    // Found an active break — use the LAST occurrence (most recent)
    if (!activeBreaks[userId]) {
      activeBreaks[userId] = {
        row: i + 1, // 1-indexed row
        data: row.map(function(c) { return c; }) // shallow copy
      };
      count++;
    }
  }

  console.log('[Populate] Found', count, 'active breaks');

  // Write to file
  const fs = require('fs');
  const outputPath = path.join(__dirname, 'data', 'active-breaks.json');
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Map to simple object for JSON
  const obj = {};
  Object.keys(activeBreaks).forEach(function(key) {
    obj[key] = activeBreaks[key];
  });

  const tmp = outputPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, outputPath);
  console.log('[Populate] Written to', outputPath);
  console.log('[Populate] Done!');
}

main().catch(function(err) {
  console.error('[Populate] Error:', err.message);
  process.exit(1);
});

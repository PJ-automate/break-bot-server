/**
 * google.js — Break Bot Google Sheets client (standalone)
 * Extracted from the shared google.js — ONLY break-related functions.
 * Independent service account = independent 60 req/min quota pool.
 */
'use strict';

const { google } = require('googleapis');
const CONFIG = require('./config');

let sheetsClient = null;

// Sheet ID cache — eliminates spreadsheets.get() calls in format functions.
var CS_BREAK_SHEET_ID = null;

/**
 * Initialize Google API auth for Break Sheet.
 * Uses its own service account with independent 60 req/min quota.
 */
async function initBreakAuth() {
  try {
    const keyFile = require(CONFIG.breakServiceAccountPath);
    const auth = new google.auth.GoogleAuth({
      credentials: keyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
    console.log('[Google-Break] Auth initialized (independent quota pool)');
    return true;
  } catch (err) {
    console.error('[Google-Break] Auth FAILED:', err.message);
    return false;
  }
}

function getSheets() {
  if (!sheetsClient) throw new Error('Google Sheets not initialized. Call initBreakAuth() first.');
  return sheetsClient;
}

// ============================================================
//  SHEET HELPERS
// ============================================================

/**
 * Get sheet ID by name from spreadsheet metadata.
 */
async function getSheetIdByName(spreadsheetId, sheetName) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = res.data.sheets.find(s => s.properties.title === sheetName);
  return sheet ? sheet.properties.sheetId : null;
}

/**
 * Get or create a sheet by name.
 */
async function getOrCreateSheet(spreadsheetId, sheetName) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.get({ spreadsheetId });
  let sheet = res.data.sheets.find(s => s.properties.title === sheetName);

  if (sheet) {
    return { sheetId: sheet.properties.sheetId, created: false };
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: sheetName } } }]
    }
  });

  const res2 = await sheets.spreadsheets.get({ spreadsheetId });
  sheet = res2.data.sheets.find(s => s.properties.title === sheetName);
  return { sheetId: sheet ? sheet.properties.sheetId : null, created: true };
}

// ============================================================
//  READ — concurrency limited to 3 (quota protection)
// ============================================================

var readQueues = {};

function acquireReadSlot(spreadsheetId) {
  return new Promise(function(resolve) {
    var q = readQueues[spreadsheetId];
    if (!q) {
      q = { sem: 0, queue: [] };
      readQueues[spreadsheetId] = q;
    }
    if (q.sem < 5) {
      q.sem++;
      resolve();
    } else {
      q.queue.push(resolve);
    }
  });
}

function releaseReadSlot(spreadsheetId) {
  var q = readQueues[spreadsheetId];
  if (q && q.queue.length > 0) {
    var next = q.queue.shift();
    next();
  } else if (q) {
    q.sem--;
  }
}

const GOOGLE_API_TIMEOUT = 40000; // 40s — OVH France has high latency to Google APIs

function timeoutPromise(ms) {
  return new Promise(function(_, reject) {
    setTimeout(function() { reject(new Error('Google API timeout (' + ms + 'ms)')); }, ms);
  });
}

async function readRange(spreadsheetId, range) {
  const sheets = getSheets();
  var maxRetries = 5;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    await acquireReadSlot(spreadsheetId);
    try {
      const res = await Promise.race([
        sheets.spreadsheets.values.get({
          spreadsheetId: spreadsheetId,
          range: range
        }),
        timeoutPromise(GOOGLE_API_TIMEOUT)
      ]);
      releaseReadSlot(spreadsheetId);
      return res.data.values || [];
    } catch (err) {
      releaseReadSlot(spreadsheetId);
      if (err.code === 400) {
        if (err.message && (err.message.indexOf('exceeds grid limits') >= 0 || err.message.indexOf('Unable to parse range') >= 0)) {
          return [];
        }
      }
      if (err.code === 429 || err.code === 403 || (err.message && err.message.indexOf('Quota') >= 0)) {
        if (attempt < maxRetries) {
          var backoff = Math.pow(2, attempt) * 1000;
          console.log('[Google] Quota hit on ' + range + ', retry ' + (attempt + 1) + '/' + maxRetries + ' in ' + backoff + 'ms');
          await new Promise(function(r) { setTimeout(r, backoff); });
          continue;
        }
      }
      throw err;
    }
  }
}

// ============================================================
//  WRITE HELPERS
// ============================================================

async function updateRange(spreadsheetId, range, values) {
  const sheets = getSheets();
  var maxRetries = 5;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId, range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values }
      });
      return;
    } catch (err) {
      if (err.code === 429 || err.code === 403 || (err.message && err.message.indexOf('Quota') >= 0)) {
        if (attempt < maxRetries) {
          var backoff = Math.pow(2, attempt) * 1000;
          console.log('[Google] Quota hit on ' + range + ' (update), retry ' + (attempt + 1) + '/' + maxRetries + ' in ' + backoff + 'ms');
          await new Promise(function(r) { setTimeout(r, backoff); });
          continue;
        }
      }
      throw err;
    }
  }
}

async function appendRow(spreadsheetId, range, values) {
  const sheets = getSheets();
  var maxRetries = 5;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId, range,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] }
      });
      return res.data;
    } catch (err) {
      if (err.code === 429 || err.code === 403 || (err.message && err.message.indexOf('Quota') >= 0)) {
        if (attempt < maxRetries) {
          var backoff = Math.pow(2, attempt) * 1000;
          console.log('[Google] Quota hit on ' + range + ' (append), retry ' + (attempt + 1) + '/' + maxRetries + ' in ' + backoff + 'ms');
          await new Promise(function(r) { setTimeout(r, backoff); });
          continue;
        }
      }
      throw err;
    }
  }
}

async function breakAppendRow(spreadsheetId, range, values) {
  const sheets = getSheets();
  var maxRetries = 5;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId, range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] }
      });
      return res.data;
    } catch (err) {
      if (err.code === 429 || err.code === 403 || (err.message && err.message.indexOf('Quota') >= 0)) {
        if (attempt < maxRetries) {
          var backoff = Math.pow(2, attempt) * 1000;
          console.log('[Google] Quota hit on ' + range + ' (break-append), retry ' + (attempt + 1) + '/' + maxRetries + ' in ' + backoff + 'ms');
          await new Promise(function(r) { setTimeout(r, backoff); });
          continue;
        }
      }
      throw err;
    }
  }
}

async function breakUpdateRange(spreadsheetId, range, values) {
  const sheets = getSheets();
  var maxRetries = 5;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId, range,
        valueInputOption: 'RAW',
        requestBody: { values }
      });
      return;
    } catch (err) {
      if (err.code === 429 || err.code === 403 || (err.message && err.message.indexOf('Quota') >= 0)) {
        if (attempt < maxRetries) {
          var backoff = Math.pow(2, attempt) * 1000;
          console.log('[Google] Quota hit on ' + range + ' (break-update), retry ' + (attempt + 1) + '/' + maxRetries + ' in ' + backoff + 'ms');
          await new Promise(function(r) { setTimeout(r, backoff); });
          continue;
        }
      }
      throw err;
    }
  }
}

/**
 * Get the CS BREAK sheet ID (cached after first call).
 */
async function getBreakSheetId(spreadsheetId) {
  if (CS_BREAK_SHEET_ID) return CS_BREAK_SHEET_ID;
  const sheets = getSheets();
  const res = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = res.data.sheets.find(function(s) { return s.properties.title === 'CS BREAK'; });
  if (sheet) CS_BREAK_SHEET_ID = sheet.properties.sheetId;
  return CS_BREAK_SHEET_ID;
}

/**
 * Execute multiple sheet operations in a single batchUpdate API call.
 */
async function breakBatchUpdate(spreadsheetId, requests) {
  const ss = getSheets();
  var maxRetries = 3;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await ss.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests }
      });
      return;
    } catch (err) {
      if (err.code === 429 || err.code === 403 || (err.message && err.message.indexOf('Quota') >= 0)) {
        if (attempt < maxRetries) {
          var backoff = Math.pow(2, attempt) * 1000;
          console.log('[Google] Quota hit on batchUpdate, retry ' + (attempt + 1) + '/' + maxRetries + ' in ' + backoff + 'ms');
          await new Promise(function(r) { setTimeout(r, backoff); });
          continue;
        }
      }
      throw err;
    }
  }
}

/**
 * Reapply number formats (DATE, TIME) to CS BREAK sheet columns.
 * Lightweight: only numberFormat field, no borders/styling.
 */
async function reapplyBreakNumberFormats(spreadsheetId) {
  if (!CS_BREAK_SHEET_ID) await getBreakSheetId(spreadsheetId);
  if (!CS_BREAK_SHEET_ID) return;
  const sid = CS_BREAK_SHEET_ID;
  const requests = [];
  requests.push({ repeatCell: { range: {sheetId:sid, startRowIndex:0, endRowIndex:5000, startColumnIndex:0, endColumnIndex:1},
    cell: { userEnteredFormat: { numberFormat: {type:'DATE', pattern:'yyyy-mm-dd'} } },
    fields: 'userEnteredFormat.numberFormat' }});
  for (var c of [5, 6, 7, 11]) {
    requests.push({ repeatCell: { range: {sheetId:sid, startRowIndex:0, endRowIndex:5000, startColumnIndex:c, endColumnIndex:c+1},
      cell: { userEnteredFormat: { numberFormat: {type:'TIME', pattern:'HH:mm:ss'} } },
      fields: 'userEnteredFormat.numberFormat' }});
  }
  const ss = getSheets();
  await ss.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

// ============================================================
//  SHEET FORMATTING
// ============================================================

async function formatBreakSheets(spreadsheetId) {
  const ss = getSheets();
  const ssInfo = await ss.spreadsheets.get({ spreadsheetId });
  const allSheets = ssInfo.data.sheets;

  for (const sheet of allSheets) {
    const name = sheet.properties.title;
    const sheetId = sheet.properties.sheetId;

    if (name === 'CS BREAK') {
      await formatCSBreakSheet(ss, spreadsheetId, sheetId);
    } else if (name === 'Archives') {
      await formatArchivesSheet(ss, spreadsheetId, sheetId);
    } else if (name === 'DAILY SUMMARY') {
      await formatDailySummarySheet(ss, spreadsheetId, sheetId);
    } else if (name === 'OVERBREAK_TRACKER') {
      await formatOverbreakSheet(ss, spreadsheetId, sheetId);
    }
  }
}

async function formatCSBreakSheet(ss, spreadsheetId, sheetId) {
  const requests = [];

  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount'
    }
  });

  const hdrBg = { red: 44/255, green: 62/255, blue: 80/255 };
  const hdrFmt = {
    backgroundColor: hdrBg,
    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
    horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
  };
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 15 },
      cell: { userEnteredFormat: hdrFmt },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
    }
  });

  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 36 }, fields: 'pixelSize'
    }
  });

  const colWidths = [
    { col: 0, w: 110 },  { col: 1, w: 180 },  { col: 2, w: 70 },
    { col: 3, w: 120 },  { col: 4, w: 110 },  { col: 5, w: 95 },
    { col: 6, w: 95 },   { col: 7, w: 90 },   { col: 8, w: 100 },
    { col: 9, w: 130 },  { col: 10, w: 120 }, { col: 11, w: 95 },
    { col: 12, w: 130 }, { col: 13, w: 165 }, { col: 14, w: 130 },
  ];
  for (const { col, w } of colWidths) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
        properties: { pixelSize: w }, fields: 'pixelSize'
      }
    });
  }

  const borderGray = { red: 0.8, green: 0.8, blue: 0.8 };
  requests.push({
    updateBorders: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 5000, startColumnIndex: 0, endColumnIndex: 15 },
      top: { style: 'SOLID', color: borderGray },
      bottom: { style: 'SOLID', color: borderGray },
      left: { style: 'SOLID', color: borderGray },
      right: { style: 'SOLID', color: borderGray },
      innerHorizontal: { style: 'SOLID', color: borderGray },
      innerVertical: { style: 'SOLID', color: borderGray }
    }
  });

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 5000, startColumnIndex: 0, endColumnIndex: 15 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 1, green: 1, blue: 1 },
          verticalAlignment: 'MIDDLE',
          textFormat: { foregroundColor: { red: 0, green: 0, blue: 0 }, bold: false, fontSize: 10 }
        }
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize'
    }
  });

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 5000, startColumnIndex: 0, endColumnIndex: 1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
      fields: 'userEnteredFormat.numberFormat'
    }
  });

  for (var timeCol of [5, 6, 7, 11]) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 5000, startColumnIndex: timeCol, endColumnIndex: timeCol + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'TIME', pattern: 'HH:mm:ss' } } },
        fields: 'userEnteredFormat.numberFormat'
      }
    });
  }

  const altGray = { red: 242/255, green: 242/255, blue: 242/255 };
  requests.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 5000, startColumnIndex: 0, endColumnIndex: 15 }],
        booleanRule: {
          condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=MOD(ROW(),2)=0' }] },
          format: { backgroundColor: altGray }
        }
      },
      index: 0
    }
  });

  await ss.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  console.log('[Format] CS BREAK formatted');
}

async function formatArchivesSheet(ss, spreadsheetId, sheetId) {
  const requests = [];

  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount'
    }
  });

  const hdrBg = { red: 82/255, green: 33/255, blue: 102/255 };
  const hdrFmt = {
    backgroundColor: hdrBg,
    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
    horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
  };
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 15 },
      cell: { userEnteredFormat: hdrFmt },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
    }
  });

  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 36 }, fields: 'pixelSize'
    }
  });

  const colWidths = [
    { col: 0, w: 110 },  { col: 1, w: 180 },  { col: 2, w: 70 },
    { col: 3, w: 120 },  { col: 4, w: 110 },  { col: 5, w: 95 },
    { col: 6, w: 95 },   { col: 7, w: 90 },   { col: 8, w: 100 },
    { col: 9, w: 130 },  { col: 10, w: 120 }, { col: 11, w: 95 },
    { col: 12, w: 130 }, { col: 13, w: 165 }, { col: 14, w: 130 },
  ];
  for (const { col, w } of colWidths) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
        properties: { pixelSize: w }, fields: 'pixelSize'
      }
    });
  }

  const borderGray = { red: 0.8, green: 0.8, blue: 0.8 };
  requests.push({
    updateBorders: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 5000, startColumnIndex: 0, endColumnIndex: 15 },
      top: { style: 'SOLID', color: borderGray },
      bottom: { style: 'SOLID', color: borderGray },
      left: { style: 'SOLID', color: borderGray },
      right: { style: 'SOLID', color: borderGray },
      innerHorizontal: { style: 'SOLID', color: borderGray },
      innerVertical: { style: 'SOLID', color: borderGray }
    }
  });

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 5000, startColumnIndex: 0, endColumnIndex: 15 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 1, green: 1, blue: 1 },
          verticalAlignment: 'MIDDLE',
          textFormat: { foregroundColor: { red: 0, green: 0, blue: 0 }, bold: false, fontSize: 10 }
        }
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize'
    }
  });

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 5000, startColumnIndex: 0, endColumnIndex: 1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
      fields: 'userEnteredFormat.numberFormat'
    }
  });

  for (var timeCol of [5, 6, 7]) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: timeCol, endColumnIndex: timeCol + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'TIME', pattern: 'HH:mm:ss' } } },
        fields: 'userEnteredFormat.numberFormat'
      }
    });
  }

  const altGray = { red: 242/255, green: 242/255, blue: 242/255 };
  requests.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 15 }],
        booleanRule: {
          condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=MOD(ROW(),2)=0' }] },
          format: { backgroundColor: altGray }
        }
      },
      index: 0
    }
  });

  await ss.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  console.log('[Format] Archives formatted');
}

async function formatDailySummarySheet(ss, spreadsheetId, sheetId) {
  const requests = [];

  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount'
    }
  });

  const hdrBg = { red: 26/255, green: 82/255, blue: 118/255 };
  const hdrFmt = {
    backgroundColor: hdrBg,
    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
    horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
  };
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 },
      cell: { userEnteredFormat: hdrFmt },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
    }
  });

  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 36 }, fields: 'pixelSize'
    }
  });

  const colWidths = [
    { col: 0, w: 110 },  { col: 1, w: 180 },
    { col: 2, w: 150 },  { col: 3, w: 110 },  { col: 4, w: 110 },
  ];
  for (const { col, w } of colWidths) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
        properties: { pixelSize: w }, fields: 'pixelSize'
      }
    });
  }

  const borderGray = { red: 0.8, green: 0.8, blue: 0.8 };
  requests.push({
    updateBorders: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 5 },
      top: { style: 'SOLID', color: borderGray },
      bottom: { style: 'SOLID', color: borderGray },
      left: { style: 'SOLID', color: borderGray },
      right: { style: 'SOLID', color: borderGray },
      innerHorizontal: { style: 'SOLID', color: borderGray },
      innerVertical: { style: 'SOLID', color: borderGray }
    }
  });

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 5 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 1, green: 1, blue: 1 },
          verticalAlignment: 'MIDDLE',
          textFormat: { foregroundColor: { red: 0, green: 0, blue: 0 }, bold: false, fontSize: 10 }
        }
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize'
    }
  });

  const altGray = { red: 242/255, green: 242/255, blue: 242/255 };
  requests.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 5 }],
        booleanRule: {
          condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=MOD(ROW(),2)=0' }] },
          format: { backgroundColor: altGray }
        }
      },
      index: 0
    }
  });

  await ss.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  console.log('[Format] DAILY SUMMARY formatted');
}

async function formatOverbreakSheet(ss, spreadsheetId, sheetId) {
  const requests = [];

  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount'
    }
  });

  const hdrBg = { red: 146/255, green: 43/255, blue: 33/255 };
  const hdrFmt = {
    backgroundColor: hdrBg,
    textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
    horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
  };
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
      cell: { userEnteredFormat: hdrFmt },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
    }
  });

  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 36 }, fields: 'pixelSize'
    }
  });

  const existing = await readRange(spreadsheetId, 'OVERBREAK_TRACKER!A1:H1');
  if (!existing || existing.length === 0 || !existing[0][0]) {
    await updateRange(spreadsheetId, 'OVERBREAK_TRACKER!A1:H1', [[
      'Date', 'User Name', 'User ID', 'Shift', 'Period', 'Break Type',
      'Time (Start → End)', 'Duration'
    ]]);
  }

  const colWidths = [
    { col: 0, w: 110 }, { col: 1, w: 180 },
    { col: 2, w: 120 }, { col: 3, w: 80 },
    { col: 4, w: 110 }, { col: 5, w: 110 },
    { col: 6, w: 170 }, { col: 7, w: 90 },
  ];
  for (const { col, w } of colWidths) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
        properties: { pixelSize: w }, fields: 'pixelSize'
      }
    });
  }

  const borderGray = { red: 0.8, green: 0.8, blue: 0.8 };
  requests.push({
    updateBorders: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 8 },
      top: { style: 'SOLID', color: borderGray },
      bottom: { style: 'SOLID', color: borderGray },
      left: { style: 'SOLID', color: borderGray },
      right: { style: 'SOLID', color: borderGray },
      innerHorizontal: { style: 'SOLID', color: borderGray },
      innerVertical: { style: 'SOLID', color: borderGray }
    }
  });

  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 8 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 1, green: 1, blue: 1 },
          verticalAlignment: 'MIDDLE',
          textFormat: { foregroundColor: { red: 0, green: 0, blue: 0 }, bold: false, fontSize: 10 }
        }
      },
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize'
    }
  });

  const altGray = { red: 242/255, green: 242/255, blue: 242/255 };
  requests.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 8 }],
        booleanRule: {
          condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=MOD(ROW(),2)=0' }] },
          format: { backgroundColor: altGray }
        }
      },
      index: 0
    }
  });

  await ss.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  console.log('[Format] OVERBREAK_TRACKER formatted');
}

// ============================================================
//  HELPERS
// ============================================================

function formatDate(date, pattern) {
  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const pad = (n) => String(n).padStart(2, '0');
  const replacements = [
    ['yyyy', date.getFullYear()],
    ['MMMM', MONTH_NAMES[date.getMonth()]],
    ['MM', pad(date.getMonth() + 1)],
    ['dd', pad(date.getDate())],
    ['HH', pad(date.getHours())],
    ['mm', pad(date.getMinutes())],
    ['ss', pad(date.getSeconds())]
  ];
  let result = pattern;
  for (const [key, val] of replacements) {
    result = result.split(key).join(val);
  }
  return result;
}

function colToLetters(col) {
  let result = '';
  let n = col;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

module.exports = {
  initBreakAuth,
  readRange,
  updateRange,
  appendRow,
  breakAppendRow,
  breakUpdateRange,
  getOrCreateSheet,
  formatBreakSheets,
  reapplyBreakNumberFormats,
  getBreakSheetId,
  breakBatchUpdate,
  formatDate,
  colToLetters
};

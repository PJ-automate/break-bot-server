/**
 * fix-all-sheet-rows.js — Recalculate ALL existing rows in Google Sheet from SQLite data.
 * The bot stores correct data in SQLite. This script pushes it to the sheet.
 */
var db = require("/home/ubuntu/break-bot-server/src/break-db");
db.initDB();
var CONFIG = require("/home/ubuntu/break-bot-server/src/config");
CONFIG.breakServiceAccountPath = "/home/ubuntu/break-bot-server/break-bot-key.json";

async function main() {
  var m = require("/home/ubuntu/break-bot-server/src/google");
  await m.initBreakAuth();
  var { google } = require("googleapis");
  var auth = new google.auth.GoogleAuth({ credentials: require(CONFIG.breakServiceAccountPath), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  var client = await auth.getClient();
  client.timeout = 60000;
  var sheets = google.sheets({ version: "v4", auth: client });

  // Get sheet metadata
  var sinfo = await sheets.spreadsheets.get({ spreadsheetId: CONFIG.breakSheetId });
  var sid = null;
  for (var s of sinfo.data.sheets) {
    if (s.properties.title === "CS BREAK") { sid = s.properties.sheetId; break; }
  }
  if (!sid) { console.log("Sheet not found"); return; }

  // Read ALL current sheet data
  var resp = await sheets.spreadsheets.values.get({ spreadsheetId: CONFIG.breakSheetId, range: "CS BREAK!A:O" });
  var sheetData = resp.data.values;
  if (!sheetData) { console.log("No sheet data"); return; }
  console.log("Sheet rows: " + (sheetData.length - 1));

  // Read ALL breaks from SQLite that have google_sheet_row > 0 and end_time set
  var d = db.getDB();
  var completed = d.prepare("SELECT * FROM breaks WHERE google_sheet_row > 0 AND end_time IS NOT NULL AND end_time != '' ORDER BY google_sheet_row ASC").all();
  var active = d.prepare("SELECT * FROM breaks WHERE google_sheet_row > 0 AND (end_time IS NULL OR end_time = '') ORDER BY google_sheet_row ASC").all();
  console.log("Completed breaks: " + completed.length);
  console.log("Active breaks: " + active.length);

  // Build batch update requests
  var reqs = [];
  var fixed = 0;

  // Fix completed breaks: write G (end), H (duration), I (remaining), J (remark), L (total), M (status), O (notes)
  for (var i = 0; i < completed.length; i++) {
    var b = completed[i];
    var ri = b.google_sheet_row - 1; // 0-indexed
    if (ri < 0) continue;

    var statusIcon = b.remark ? ("⚠️ " + b.remark) : "🟢 RETURNED";

    // Only update if sheet has wrong data (empty G, H, or L)
    var sheetRow = sheetData[b.google_sheet_row - 1];
    var currentG = sheetRow ? (sheetRow[6] || "") : "";
    var currentH = sheetRow ? (sheetRow[7] || "") : "";
    var currentL = sheetRow ? (sheetRow[11] || "") : "";

    // Check if G is missing or a serial number (not a valid time string)
    var needsFix = false;
    if (!currentG || currentG === "0" || (!isNaN(currentG) && currentG !== "")) needsFix = true;
    if (!currentH || currentH === "0" || (!isNaN(currentH) && currentH !== "")) needsFix = true;
    if (!currentL || currentL === "0" || (!isNaN(currentL) && currentL !== "")) needsFix = true;

    if (!needsFix) continue; // Already correct

    // Write G-J
    reqs.push({
      updateCells: {
        range: { sheetId: sid, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 6, endColumnIndex: 10 },
        rows: [{ values: [
          { userEnteredValue: { stringValue: b.end_time || "" } },
          { userEnteredValue: { stringValue: b.duration_hms || "" } },
          { userEnteredValue: { stringValue: b.remaining || "" } },
          { userEnteredValue: { stringValue: b.remark || "" } }
        ] }],
        fields: "userEnteredValue"
      }
    });
    // Write L-M
    reqs.push({
      updateCells: {
        range: { sheetId: sid, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 11, endColumnIndex: 13 },
        rows: [{ values: [
          { userEnteredValue: { stringValue: b.total_used_hms || "" } },
          { userEnteredValue: { stringValue: statusIcon } }
        ] }],
        fields: "userEnteredValue"
      }
    });
    // Write O
    reqs.push({
      updateCells: {
        range: { sheetId: sid, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 14, endColumnIndex: 15 },
        rows: [{ values: [{ userEnteredValue: { stringValue: statusIcon } }] }],
        fields: "userEnteredValue"
      }
    });
    fixed++;
    console.log("Fixed row " + b.google_sheet_row + ": " + b.user_name + " (" + b.break_type + ")");
  }

  // Fix active breaks: make sure status shows 🔴 ON BREAK
  for (var j = 0; j < active.length; j++) {
    var a = active[j];
    var ri2 = a.google_sheet_row - 1;
    if (ri2 < 0) continue;

    // Only fix if status is wrong
    var sheetRow2 = sheetData[a.google_sheet_row - 1];
    var curStatus = sheetRow2 ? (sheetRow2[12] || "") : "";
    if (curStatus !== "🔴 ON BREAK") {
      reqs.push({
        updateCells: {
          range: { sheetId: sid, startRowIndex: ri2, endRowIndex: ri2 + 1, startColumnIndex: 12, endColumnIndex: 13 },
          rows: [{ values: [{ userEnteredValue: { stringValue: "🔴 ON BREAK" } }] }],
          fields: "userEnteredValue"
        }
      });
      fixed++;
      console.log("Fixed active row " + a.google_sheet_row + ": " + a.user_name + " (" + a.break_type + ")");
    }
  }

  if (reqs.length > 0) {
    console.log("\nSending " + reqs.length + " batch updates for " + fixed + " rows...");
    // Send in chunks of 100 (Google API limit)
    for (var k = 0; k < reqs.length; k += 100) {
      var chunk = reqs.slice(k, k + 100);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: CONFIG.breakSheetId,
        requestBody: { requests: chunk }
      });
      console.log("  Sent " + chunk.length + " requests (batch " + (k / 100 + 1) + ")");
    }
    console.log("Done! Fixed " + fixed + " rows.");
  } else {
    console.log("No rows need fixing.");
  }
}

main().catch(function(e) { console.error("Error:", e.message); });

var CONFIG = require("/home/ubuntu/break-bot-server/src/config");
var KEY = "/home/ubuntu/break-bot-server/break-bot-key.json";
CONFIG.breakServiceAccountPath = KEY;
async function main() {
  var { initBreakAuth } = require("/home/ubuntu/break-bot-server/src/google");
  await initBreakAuth();
  var { google } = require("googleapis");
  var auth = new google.auth.GoogleAuth({ credentials: require(KEY), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  var client = await auth.getClient();
  client.timeout = 60000;
  var sheets = google.sheets({ version: "v4", auth: client });
  var resp = await sheets.spreadsheets.values.get({ spreadsheetId: CONFIG.breakSheetId, range: "CS BREAK!A:O" });
  var data = resp.data.values;
  var piUserId = "6113598688";
  var sheetId = null;
  var sinfo = await sheets.spreadsheets.get({ spreadsheetId: CONFIG.breakSheetId });
  for (var s of sinfo.data.sheets) { if (s.properties.title === "CS BREAK") { sheetId = s.properties.sheetId; break; } }
  console.log("Sheet ID:", sheetId);
  // Find Pi jie's rows without end time
  var activeRows = [];
  for (let i = data.length - 1; i >= 1; i--) {
    var uid = data[i][10] ? String(data[i][10]).trim() : "";
    var end = data[i][6];
    var shift = data[i][2] ? String(data[i][2]).trim() : "";
    if (uid === piUserId && (!end || String(end).trim() === "") && (shift === "8h" || shift === "12h")) {
      activeRows.push({ row: i+1, data: data[i] });
      console.log("Row " + (i+1) + ": " + data[i][1] + " | " + data[i][4] + " since " + data[i][5]);
    }
  }
  console.log("Found " + activeRows.length + " active rows for Pi jie");
  // End each one - write current time
  if (activeRows.length > 0) {
    var now = new Date();
    var phStr = now.toLocaleString("en-US", { timeZone: "Asia/Manila", hour12: false });
    var parts = phStr.split(/[,\s:\/]+/);
    var h = parseInt(parts[3],10), m = parseInt(parts[4],10), s = parseInt(parts[5],10);
    var serial = (h*3600 + m*60 + s) / 86400;
    var reqs = [];
    for (var a of activeRows) {
      var ri = a.row - 1;
      // G: End Time
      reqs.push({ updateCells: { range: { sheetId, startRowIndex: ri, endRowIndex: ri+1, startColumnIndex: 6, endColumnIndex: 7 }, rows: [{ values: [{ userEnteredValue: { numberValue: serial }, userEnteredFormat: { numberFormat: { type: "TIME", pattern: "HH:mm:ss" } } }] }], fields: "userEnteredValue,userEnteredFormat.numberFormat" } });
      // M: Status
      reqs.push({ updateCells: { range: { sheetId, startRowIndex: ri, endRowIndex: ri+1, startColumnIndex: 12, endColumnIndex: 13 }, rows: [{ values: [{ userEnteredValue: { stringValue: "🟢 RETURNED" } }] }], fields: "userEnteredValue" } });
    }
    if (reqs.length > 0) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: CONFIG.breakSheetId, requestBody: { requests: reqs } });
      console.log("Fixed " + activeRows.length + " rows");
    }
  }
}
main().catch(function(e) { console.error("Error:", e.message); });

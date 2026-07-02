var CONFIG = require("/home/ubuntu/break-bot-server/src/config");
var KEY = "/home/ubuntu/break-bot-server/break-bot-key.json";
CONFIG.breakServiceAccountPath = KEY;
async function main() {
  var m = require("/home/ubuntu/break-bot-server/src/google");
  await m.initBreakAuth();
  var { google } = require("googleapis");
  var auth = new google.auth.GoogleAuth({ credentials: require(KEY), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  var client = await auth.getClient();
  client.timeout = 30000;
  var sheets = google.sheets({ version: "v4", auth: client });
  var resp = await sheets.spreadsheets.values.get({ spreadsheetId: CONFIG.breakSheetId, range: "CS BREAK!A:O" });
  var data = resp.data.values;
  console.log("Total rows:", data.length - 1);
  var corrupted = [];
  for (let i = 1; i < data.length; i++) {
    var g = data[i][6]; // End Time
    var h = data[i][7]; // Duration
    var l = data[i][11]; // Total Used
    var needsFix = false;
    var fixG = "", fixH = "", fixL = "";
    if (g && !isNaN(g) && typeof g !== "string") {
      var secs = Math.round(parseFloat(g) * 86400);
      fixG = String(Math.floor(secs / 3600)).padStart(2, "0") + ":" + String(Math.floor((secs % 3600) / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
      needsFix = true;
    }
    if (h && !isNaN(h) && typeof h !== "string") {
      var secs2 = Math.round(parseFloat(h) * 86400);
      fixH = String(Math.floor(secs2 / 3600)).padStart(2, "0") + ":" + String(Math.floor((secs2 % 3600) / 60)).padStart(2, "0") + ":" + String(secs2 % 60).padStart(2, "0");
      needsFix = true;
    }
    if (l && !isNaN(l) && typeof l !== "string") {
      if (l < 1) { // serial time
        var secs3 = Math.round(parseFloat(l) * 86400);
        fixL = String(Math.floor(secs3 / 3600)).padStart(2, "0") + ":" + String(Math.floor((secs3 % 3600) / 60)).padStart(2, "0") + ":" + String(secs3 % 60).padStart(2, "0");
      } else {
        fixL = String(l);
      }
      needsFix = true;
    }
    if (needsFix) {
      corrupted.push({ row: i + 1, fixG: fixG || g, fixH: fixH || h, fixL: fixL || l, name: data[i][1] || "" });
    }
  }
  console.log("Corrupted rows:", corrupted.length);
  if (corrupted.length > 0) {
    var reqs = [];
    var sid = null;
    var sinfo = await sheets.spreadsheets.get({ spreadsheetId: CONFIG.breakSheetId });
    for (var s of sinfo.data.sheets) { if (s.properties.title === "CS BREAK") { sid = s.properties.sheetId; break; } }
    for (var c of corrupted) {
      var ri = c.row - 1;
      reqs.push({ updateCells: { range: { sheetId: sid, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 6, endColumnIndex: 10 }, rows: [{ values: [
        { userEnteredValue: { stringValue: c.fixG } },
        { userEnteredValue: { stringValue: c.fixH } },
        {}, {}
      ] }], fields: "userEnteredValue" } });
      reqs.push({ updateCells: { range: { sheetId: sid, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: 11, endColumnIndex: 12 }, rows: [{ values: [
        { userEnteredValue: { stringValue: c.fixL } }
      ] }], fields: "userEnteredValue" } });
    }
    console.log("Fixing " + corrupted.length + " rows, " + reqs.length + " requests...");
    corrupted.forEach(function(c) { console.log("  Row " + c.row + " (" + c.name + "): G=" + c.fixG + " H=" + c.fixH + " L=" + c.fixL); });
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: CONFIG.breakSheetId, requestBody: { requests: reqs } });
    console.log("Done!");
  } else {
    console.log("No corrupted rows found.");
  }
}
main().catch(function(e) { console.error(e.message); });

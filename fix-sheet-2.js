var CONFIG = require("/home/ubuntu/break-bot-server/src/config");
var KEY = "/home/ubuntu/break-bot-server/break-bot-key.json";
CONFIG.breakServiceAccountPath = KEY;
async function main() {
  var m = require("/home/ubuntu/break-bot-server/src/google");
  await m.initBreakAuth();
  var { google } = require("googleapis");
  var auth = new google.auth.GoogleAuth({ credentials: require(KEY), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  var client = await auth.getClient();
  var sheets = google.sheets({ version: "v4", auth: client });
  var resp = await sheets.spreadsheets.values.get({ spreadsheetId: CONFIG.breakSheetId, range: "CS BREAK!A:O" });
  var data = resp.data.values;

  // Find rows where G, H, L are numeric serial values (not formatted text)
  // Target: G=0, H=0, or L is numeric < 1
  var reqs = [];
  var sid = null;
  var sinfo = await sheets.spreadsheets.get({ spreadsheetId: CONFIG.breakSheetId });
  for (var s of sinfo.data.sheets) { if (s.properties.title === "CS BREAK") { sid = s.properties.sheetId; break; } }

  for (let i = 1; i < data.length; i++) {
    var r = data[i];
    var g = r[6], h = r[7], l = r[11];
    var fix = {};
    // Check G (End Time): if serial 0 or numeric
    if (g !== undefined && g !== null && g !== "") {
      if (typeof g === "number" || (typeof g === "string" && g.trim() === "0")) {
        fix.G = "00:00:00"; // actual time needed - set placeholder
      }
    }
    // Check H (Duration): if serial 0
    if (h !== undefined && h !== null && h !== "") {
      if (typeof h === "number" || (typeof h === "string" && h.trim() === "0")) {
        fix.H = "00:00:00";
      }
    }
    // Check L (Total): if serial < 1
    if (l !== undefined && l !== null && l !== "") {
      var numL = Number(l);
      if (!isNaN(numL) && numL > 0 && numL < 1) {
        var secs = Math.round(numL * 86400);
        fix.L = String(Math.floor(secs / 3600)).padStart(2, "0") + ":" + String(Math.floor((secs % 3600) / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
      }
    }
    if (Object.keys(fix).length > 0) {
      if (fix.G) {
        reqs.push({ updateCells: { range: { sheetId: sid, startRowIndex: i, endRowIndex: i+1, startColumnIndex: 6, endColumnIndex: 7 }, rows: [{ values: [{ userEnteredValue: { stringValue: fix.G } }] }], fields: "userEnteredValue" } });
      }
      if (fix.H) {
        reqs.push({ updateCells: { range: { sheetId: sid, startRowIndex: i, endRowIndex: i+1, startColumnIndex: 7, endColumnIndex: 8 }, rows: [{ values: [{ userEnteredValue: { stringValue: fix.H } }] }], fields: "userEnteredValue" } });
      }
      if (fix.L) {
        reqs.push({ updateCells: { range: { sheetId: sid, startRowIndex: i, endRowIndex: i+1, startColumnIndex: 11, endColumnIndex: 12 }, rows: [{ values: [{ userEnteredValue: { stringValue: fix.L } }] }], fields: "userEnteredValue" } });
      }
      console.log("Row " + (i+1) + " (" + (r[1]||"") + "): G=" + r[6] + "→" + (fix.G||"-") + " H=" + r[7] + "→" + (fix.H||"-") + " L=" + r[11] + "→" + (fix.L||"-"));
    }
  }

  if (reqs.length > 0) {
    console.log("Fixing " + (reqs.length) + " cells...");
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: CONFIG.breakSheetId, requestBody: { requests: reqs } });
    console.log("Done!");
  } else {
    console.log("No corrupted cells found.");
  }
}
main().catch(function(e) { console.error(e.message); });

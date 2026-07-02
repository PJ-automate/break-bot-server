/**
 * One-time script: import Google Sheet data into SQLite.
 */
var db = require("/home/ubuntu/break-bot-server/src/break-db");
db.initDB();
var CONFIG = require("/home/ubuntu/break-bot-server/src/config");
CONFIG.breakServiceAccountPath = "/home/ubuntu/break-bot-server/break-bot-key.json";
async function main() {
  var m = require("/home/ubuntu/break-bot-server/src/google");
  await m.initBreakAuth();
  console.log("Reading sheet...");
  var data = await m.readRange(CONFIG.breakSheetId, "CS BREAK!A:O");
  if (data && data.length > 1) {
    var count = db.importFromSheetData(data);
    console.log("Imported " + count + " records from sheet");
    // Also print active break count
    var active = db.getAllActiveBreaks();
    console.log("Active breaks in DB: " + active.length);
    active.forEach(function(b) { console.log("  - " + b.user_name + " (" + b.break_type + " since " + b.start_time + ") row=" + b.google_sheet_row); });
  } else {
    console.log("No data to import");
  }
}
main().catch(function(e) { console.error("Error:", e.message); });

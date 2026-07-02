var db = require("/home/ubuntu/break-bot-server/src/break-db");
db.initDB();
var pending = db.getPendingSyncs();
console.log("Pending syncs: " + pending.length);
pending.forEach(function(p) {
  console.log("  " + p.operation + " #" + p.break_id + " retries=" + p.retries + " sheet_row=" + (p.google_sheet_row || 0) + " rowIndex=" + (p.rowIndex || 0) + " last_error=" + (p.last_error || ""));
});

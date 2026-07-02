var db = require("/home/ubuntu/break-bot-server/src/break-db");
db.initDB();
var d = db.getDB();
d.prepare("DELETE FROM sync_queue").run();
d.prepare("UPDATE breaks SET sync_status = 'failed' WHERE google_sheet_row = 0 AND sync_status = 'pending'").run();
var r = d.prepare("SELECT COUNT(*) as c FROM breaks WHERE google_sheet_row = 0 AND sync_status = 'failed'").get();
console.log("Sync queue cleared. Marked " + r.c + " breaks as failed sync.");

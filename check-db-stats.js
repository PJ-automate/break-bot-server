var db = require("/home/ubuntu/break-bot-server/src/break-db");
db.initDB();
var d = db.getDB();
var total = d.prepare("SELECT COUNT(*) as c FROM breaks").get();
var active = d.prepare("SELECT COUNT(*) as c FROM breaks WHERE status = 'ON BREAK'").get();
// Get unique active users
var unique = d.prepare("SELECT COUNT(DISTINCT user_id) as c FROM breaks WHERE status = 'ON BREAK'").get();
console.log("Total breaks: " + total.c);
console.log("Active breaks: " + active.c);
console.log("Unique active users: " + unique.c);
// Show each active user
var users = d.prepare("SELECT DISTINCT user_id, user_name FROM breaks WHERE status = 'ON BREAK' ORDER BY user_name").all();
users.forEach(function(u) {
  var count = d.prepare("SELECT COUNT(*) as c FROM breaks WHERE user_id = ? AND status = 'ON BREAK'").get(u.user_id);
  if (count.c > 1) {
    console.log("  DUPLICATES: " + u.user_name + " has " + count.c + " active records");
  } else {
    console.log("  OK: " + u.user_name);
  }
});

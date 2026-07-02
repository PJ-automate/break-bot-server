var CONFIG = require("./src/config");
var KEY = __dirname + "/break-bot-key.json";
var path = require("path");
CONFIG.breakServiceAccountPath = KEY;
async function main() {
  var m = require("./src/google");
  await m.initBreakAuth();
  var data = await m.readRange(CONFIG.breakSheetId, "CS BREAK!A:O");
  if (!data || data.length < 2) { console.log("No data"); return; }
  var active = {};
  for (let i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    var uid = row[10] ? String(row[10]).trim() : "";
    var end = row[6]; var shift = row[2] ? String(row[2]).trim() : "";
    var btype = row[4] ? String(row[4]).trim() : "";
    if (!uid) continue;
    if (end && String(end).trim() !== "") continue;
    if (shift === "RESET" || btype === "SHIFT_SET") continue;
    if (shift !== "8h" && shift !== "12h") continue;
    if (!active[uid]) active[uid] = { row: i+1, data: row.map(function(c) { return c; }) };
  }
  var obj = {};
  Object.keys(active).forEach(function(k) { obj[k] = active[k]; });
  var p = path.join(__dirname, "data", "active-breaks.json");
  var dir = path.dirname(p);
  if (!require("fs").existsSync(dir)) require("fs").mkdirSync(dir, { recursive: true });
  require("fs").writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  console.log("Active breaks:", Object.keys(active).length);
  Object.keys(active).forEach(function(k) {
    console.log("  - " + active[k].data[1] + " (" + active[k].data[4] + " since " + active[k].data[5] + ")");
  });
}
main().catch(function(e) { console.error("Error:", e.message); });

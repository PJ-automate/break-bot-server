var CONFIG = require("/home/ubuntu/break-bot-server/src/config");
var KEY = "/home/ubuntu/break-bot-server/break-bot-key.json";
CONFIG.breakServiceAccountPath = KEY;
async function main() {
  var m = require("/home/ubuntu/break-bot-server/src/google");
  await m.initBreakAuth();
  var data = await m.readRange(CONFIG.breakSheetId, "CS BREAK!A:O");
  if (!data) { console.log("No data"); return; }
  console.log("Total rows: " + (data.length - 1));
  console.log("Report format: Row | Name | Type | G(End) | H(Duration) | I(Remaining) | L(Total) | M(Status) |");
  for (let i = Math.max(1, data.length - 20); i < data.length; i++) {
    var r = data[i];
    var name = r[1] ? String(r[1]).slice(0, 25) : "";
    var type = r[4] ? String(r[4]) : "";
    var g = r[6] !== undefined ? String(r[6]) : "";
    var h = r[7] !== undefined ? String(r[7]) : "";
    var ii = r[8] !== undefined ? String(r[8]) : "";
    var l = r[11] !== undefined ? String(r[11]) : "";
    var m = r[12] !== undefined ? String(r[12]) : "";
    var o = r[14] !== undefined ? String(r[14]) : "";
    // Check for numeric/serial values
    var note = "";
    if (g && !isNaN(g)) note += " [G=NUM]";
    if (h && !isNaN(h)) note += " [H=NUM]";
    if (l && !isNaN(l)) note += " [L=NUM]";
    console.log((i+1) + " | " + name + " | " + type + " | G=" + g + " | H=" + h + " | I=" + ii + " | L=" + l + " | M=" + m + " | O=" + o + note);
  }
}
main().catch(function(e) { console.error(e.message); });

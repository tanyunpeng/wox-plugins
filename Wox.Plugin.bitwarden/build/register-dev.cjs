// One-shot: register this plugin folder as a Wox dev-plugin directory (wpm's
// local_plugin_directories table setting). Paths come from the script's own
// location and the home directory, so it is the same on Windows, Linux and macOS.
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const os = require("node:os");
const KEY = "local_plugin_directories";
const WOXX_MANAGER = "e2c5f005-6c73-43c8-bc53-ab04def265b2";
const dir = path.resolve(__dirname, "..");
const db = new DatabaseSync(path.join(os.homedir(), ".wox", "wox-user", "wox.db"));
db.prepare("pragma busy_timeout=8000").run();
const row = db.prepare("select value from plugin_settings where plugin_id=? and `key`=?").get(WOXX_MANAGER, KEY);
// Other folders the user registered stay registered.
const dirs = new Set([...(row ? JSON.parse(row.value).map((e) => e.path) : []), dir]);
const value = JSON.stringify([...dirs].map((p) => ({ path: p })));
console.log("value =", value);
db.prepare("insert or replace into plugin_settings(plugin_id,`key`,value,is_local) values(?,?,?,1)").run(WOXX_MANAGER, KEY, value);
console.log("rows:", JSON.stringify(db.prepare("select * from plugin_settings where `key`=?").all(KEY)));
db.close();

// Loads the official Bitwarden wasm crypto engine shipped beside the plugin.
// The node build resolves its .wasm via __dirname, so both files must stay in
// the same directory (see build/package.mjs).
const fs = require("fs");
const path = require("path");

let cached = null;

const bundled = path.join(__dirname, "..", "sdk", "bitwarden_wasm_internal.js");
const installed = path.join(
  __dirname,
  "..",
  "node_modules",
  "@bitwarden",
  "sdk-internal",
  "node",
  "bitwarden_wasm_internal.js"
);

function loadSdk() {
  if (cached === null) {
    const mod = require(fs.existsSync(bundled) ? bundled : installed);
    cached = { PureCrypto: mod.PureCrypto, module: mod };
  }
  return cached;
}

module.exports = { loadSdk };

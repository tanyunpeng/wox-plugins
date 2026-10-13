// Entry point. The host resolves the plugin object as `module.plugin` or
// `module.default.plugin` (host singleFile.ts:13-19) and reaches it through both
// require() (single-file mode) and dynamic import() (packaged mode), so both
// shapes are exposed explicitly.
const { BitwardenPlugin } = require("./src/plugin");

const plugin = new BitwardenPlugin();

module.exports = { plugin, default: { plugin } };

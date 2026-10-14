// Entry point. The host resolves the plugin object as `module.plugin` or
// `module.default.plugin` and reaches it through both require() (single-file
// mode) and dynamic import() (packaged mode), so both shapes are exposed.
const { plugin } = require("./src/plugin")

module.exports = { plugin, default: { plugin } }

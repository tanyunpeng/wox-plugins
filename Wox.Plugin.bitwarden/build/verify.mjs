// Static verification: plugin.json parses, every translation key used in code
// exists in both locales, and the entry really exports a loadable plugin object.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

const manifest = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"));
// Required fields per the plugin.json schema.
for (const key of [
  "Id",
  "Name",
  "Description",
  "Author",
  "Website",
  "Version",
  "MinWoxVersion",
  "Runtime",
  "Entry",
  "Icon",
  "TriggerKeywords",
  "SupportedOS",
  "I18n",
  "SettingDefinitions",
]) {
  if (!(key in manifest)) problems.push(`plugin.json missing ${key}`);
}
// IsAllSupportedOS accepts Windows / Darwin / Linux only, case-insensitively;
// "Macos" is what the core default and the skill template say, and it never
// matches the comparison against runtime.GOOS ("darwin").
const SUPPORTED_OS = ["windows", "darwin", "linux"];
for (const os of manifest.SupportedOS ?? []) {
  if (!SUPPORTED_OS.includes(String(os).toLowerCase())) problems.push(`plugin.json SupportedOS "${os}" is not a valid token`);
}
if (manifest.Entry !== "index.js" || !existsSync(path.join(root, "index.js"))) problems.push("Entry index.js not found");
if (!manifest.TriggerKeywords.includes("pw")) problems.push("trigger keyword pw missing");

// The plugin version follows the official Bitwarden client it emulates, so the two
// numbers must never drift apart.
const clientVersion = readFileSync(path.join(root, "src", "client.js"), "utf8").match(/const CLIENT_VERSION = "([^"]+)"/)?.[1];
if (!clientVersion) problems.push("src/client.js lost its CLIENT_VERSION constant");
else if (manifest.Version !== clientVersion) problems.push(`plugin.json Version ${manifest.Version} != Bitwarden-Client-Version ${clientVersion}`);

const locales = Object.keys(manifest.I18n);
if (locales.length < 2) problems.push(`expected at least 2 locales, got ${locales.join(",")}`);

// Any string literal that names a declared key counts as a use: keys reach the
// UI both through this.t(ctx, "key") and as positional arguments to helpers
// like simpleRow(ctx, titleKey, subtitleKey, icon), so a t()-shaped regex would
// report live keys as dead.
const keyNames = new Set(locales.flatMap((locale) => Object.keys(manifest.I18n[locale])));
const sourceFiles = [path.join(root, "index.js"), ...readdirSync(path.join(root, "src")).map((f) => path.join(root, "src", f))];
const codeUses = new Set();
for (const file of sourceFiles) {
  if (!file.endsWith(".js")) continue;
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/"([a-z0-9_]+)"/g)) {
    if (keyNames.has(match[1])) codeUses.add(match[1]);
  }
  for (const match of text.matchAll(/"i18n:([a-z0-9_]+)"/g)) {
    if (keyNames.has(match[1])) codeUses.add(match[1]);
  }
}
const manifestUses = new Set();
for (const match of JSON.stringify({ ...manifest, I18n: {} }).matchAll(/"i18n:([a-z0-9_]+)"/g)) {
  if (keyNames.has(match[1])) manifestUses.add(match[1]);
}
const usedKeys = new Set([...codeUses, ...manifestUses]);
for (const key of usedKeys) {
  for (const locale of locales) {
    if (!(key in manifest.I18n[locale])) problems.push(`i18n key "${key}" missing in ${locale}`);
  }
}

// plugin.json must reference only keys that exist
for (const match of JSON.stringify(manifest.SettingDefinitions).matchAll(/"i18n:([a-z0-9_]+)"/g)) {
  for (const locale of locales) {
    if (!(match[1] in manifest.I18n[locale])) problems.push(`setting i18n key "${match[1]}" missing in ${locale}`);
  }
}

// A key nothing references is dead weight in two languages: report it too.
for (const locale of locales) {
  for (const key of Object.keys(manifest.I18n[locale])) {
    if (!usedKeys.has(key)) problems.push(`i18n key "${key}" (${locale}) is declared but never used`);
  }
}

// Every declared command must be dispatched by query(), and query() must not
// dispatch a command the manifest never declared (a command row the host cannot
// offer is dead code the tests would still happily pass).
const querySource = readFileSync(path.join(root, "src", "plugin.js"), "utf8");
const dispatched = new Set(
  [...querySource.matchAll(/command === "([a-z_]+)"/g)].map((m) => m[1]),
);
for (const declared of manifest.Commands.map((c) => c.Command.toLowerCase())) {
  if (!dispatched.has(declared)) problems.push(`command "${declared}" is declared but query() never handles it`);
}
for (const handled of dispatched) {
  if (!manifest.Commands.some((c) => c.Command.toLowerCase() === handled)) {
    problems.push(`query() handles command "${handled}" that plugin.json does not declare`);
  }
}

// Setting keys declared in SettingDefinitions must not collide with hidden keys
const declared = new Set(manifest.SettingDefinitions.map((d) => d.Value?.Key).filter(Boolean));
for (const hidden of ["accountEmail", "deviceId"]) {
  if (declared.has(hidden)) problems.push(`hidden setting "${hidden}" must not be declared in SettingDefinitions`);
}

// Every module the plugin requires must be in the package: a missing file passes
// every local test and only fails once Wox tries to load the installed plugin.
const packager = readFileSync(path.join(root, "build", "package.mjs"), "utf8");
// Comments explain why Compress-Archive is wrong, so only executable lines are scanned.
const packagerCode = packager.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
if (/Compress-Archive|powershell/i.test(packagerCode)) {
  problems.push("build/package.mjs shells out to PowerShell, which makes the build Windows-only");
}
const shipped = new Set(
  (packager.match(/const SRC_FILES = \[([\s\S]*?)\]/)?.[1] ?? "").match(/([a-z_]+\.js)/g) ?? [],
);
for (const file of readdirSync(path.join(root, "src"))) {
  if (!file.endsWith(".js")) continue;
  if (!shipped.has(file)) problems.push(`src/${file} is not listed in build/package.mjs SRC_FILES`);
  const text = readFileSync(path.join(root, "src", file), "utf8");
  for (const match of text.matchAll(/require\("\.\/([a-z_]+\.js)"\)/g)) {
    if (!shipped.has(match[1])) problems.push(`src/${file} requires ./${match[1]}, which is not shipped`);
  }
}

// SaveSetting is deprecated in the SDK and the core (api.go:471) and its fourth
// argument is the platform dimension, not "local" - a plugin that means to keep a
// value off the sync channel must use SetSetting with IsLocal. Fail on any use.
for (const file of sourceFiles) {
  if (!file.endsWith(".js")) continue;
  if (/\.SaveSetting\(/.test(readFileSync(file, "utf8"))) problems.push(`${path.basename(file)} calls the deprecated SaveSetting`);
}

const entry = require(path.join(root, "index.js"));
const plugin = entry.plugin ?? entry.default?.plugin;
if (!plugin) problems.push("entry does not export a plugin object");
for (const method of ["init", "query"]) {
  if (typeof plugin?.[method] !== "function") problems.push(`plugin.${method} is not a function`);
}
if (typeof plugin.init !== "function") problems.push("plugin.init lost its bound receiver");

if (problems.length > 0) {
  console.error("verify FAILED:");
  for (const p of problems) console.error(" -", p);
  process.exit(1);
}
console.log(`verify OK: ${usedKeys.size}/${keyNames.size} translation keys referenced, x${locales.length} locales, entry exports a bound plugin`);

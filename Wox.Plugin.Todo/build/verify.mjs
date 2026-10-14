// Static verification: plugin.json parses and declares what the code uses,
// every i18n key is defined in both locales and actually referenced, and the
// entry really exports a loadable plugin object.
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const problems = []
const KEY_TASKS = "tasks"

const manifest = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"))
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
  if (!(key in manifest)) problems.push(`plugin.json missing ${key}`)
}

const SUPPORTED_OS = ["windows", "darwin", "linux"]
for (const os of manifest.SupportedOS ?? []) {
  if (!SUPPORTED_OS.includes(String(os).toLowerCase())) {
    problems.push(`plugin.json SupportedOS "${os}" is not a valid token`)
  }
}

if (manifest.Entry !== "index.js" || !existsSync(path.join(root, "index.js"))) {
  problems.push("Entry index.js not found")
}
for (const keyword of ["td", "todo"]) {
  if (!manifest.TriggerKeywords.includes(keyword)) problems.push(`trigger keyword ${keyword} missing`)
}
// ShowInToolbar is a 2.4.6 capability the board layout depends on.
const [maj, min] = String(manifest.MinWoxVersion).split(".").map(Number)
if (maj < 2 || (maj === 2 && min < 4) || (maj === 2 && min === 4 && Number(String(manifest.MinWoxVersion).split(".")[2]) < 6)) {
  problems.push(`MinWoxVersion ${manifest.MinWoxVersion} is below the 2.4.6 floor this plugin needs`)
}
if (manifest.Runtime !== "NODEJS") problems.push("Runtime must be NODEJS")

const locales = Object.keys(manifest.I18n)
if (locales.length < 2) problems.push(`expected at least 2 locales, got ${locales.join(",")}`)
const keyNames = new Set(locales.flatMap((locale) => Object.keys(manifest.I18n[locale])))
for (const locale of locales) {
  for (const key of keyNames) {
    if (!(key in manifest.I18n[locale])) problems.push(`i18n key "${key}" missing in ${locale}`)
  }
}

const srcDir = path.join(root, "src")
const sourceFiles = ["index.js", ...readdirSync(srcDir).map((f) => path.join("src", f))]
if (!existsSync(path.join(srcDir, "plugin.js"))) problems.push("src/plugin.js missing")

// Bare key references (this.tr(ctx, "due_label"), notify(ctx, "toast_*")) are
// uses too: any quoted string that names a declared key counts.
const usedKeys = new Set()
for (const rel of sourceFiles) {
  if (!rel.endsWith(".js")) continue
  const text = readFileSync(path.join(root, rel), "utf8")
  for (const match of text.matchAll(/"i18n:([a-z0-9_]+)"/g)) {
    if (keyNames.has(match[1])) usedKeys.add(match[1])
  }
  for (const match of text.matchAll(/"([a-z0-9_]+)"/g)) {
    if (keyNames.has(match[1])) usedKeys.add(match[1])
  }
}
for (const match of JSON.stringify({ ...manifest, I18n: {} }).matchAll(/"i18n:([a-z0-9_]+)"/g)) {
  if (keyNames.has(match[1])) usedKeys.add(match[1])
}
for (const key of keyNames) {
  if (!usedKeys.has(key)) problems.push(`i18n key "${key}" is declared but never used`)
}

// The other direction: a key the code asks for that no locale declares renders
// as the raw token in the launcher, so it must fail here instead.
const referenced = new Set()
for (const rel of sourceFiles) {
  if (!rel.endsWith(".js")) continue
  const text = readFileSync(path.join(root, rel), "utf8")
  for (const match of text.matchAll(/"i18n:([a-z0-9_]+)"/g)) referenced.add(match[1])
  for (const match of text.matchAll(/(?:this\.)?(?:tr|notify)\(ctx,\s*([^)]*)\)/g)) {
    for (const literal of match[1].matchAll(/"([a-z0-9_]+)"/g)) referenced.add(literal[1])
  }
}
const pluginSource = readFileSync(path.join(srcDir, "plugin.js"), "utf8")
for (const match of pluginSource.matchAll(/const LABEL_KEYS = \[([^\]]*)\]/g)) {
  for (const literal of match[1].matchAll(/"([a-z0-9_]+)"/g)) referenced.add(literal[1])
}
for (const key of referenced) {
  if (!keyNames.has(key)) problems.push(`i18n key "${key}" is used but not declared`)
}

// Panel-only rule: the whole point of this plugin is that tasks and groups
// are managed from the launcher, so the settings page must stay empty and the
// two data keys must live as undeclared (still cloud-synced) settings.
if (Array.isArray(manifest.SettingDefinitions) && manifest.SettingDefinitions.length > 0) {
  problems.push("SettingDefinitions must stay empty: all editing happens on the panel")
}
const declared = new Set((manifest.SettingDefinitions ?? []).map((d) => d.Value?.Key).filter(Boolean))
for (const hidden of [KEY_TASKS]) {
  if (declared.has(hidden)) problems.push(`data key "${hidden}" must not be declared in SettingDefinitions`)
}

// The packaged tree must contain every source module, or the installed plugin
// dies at require() time only on the user's machine.
const packager = readFileSync(path.join(root, "build", "package.mjs"), "utf8")
if (!/readdirSync\(path\.join\(root, "src"\)\)/.test(packager)) {
  problems.push("package.mjs no longer copies every file under src/")
}
// The comment above the hand-rolled zip explains why PowerShell's
// Compress-Archive is wrong, so only executable lines are scanned.
const packagerCode = packager
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join("\n")
if (/Compress-Archive|powershell/i.test(packagerCode)) {
  problems.push("package.mjs must not shell out to PowerShell for the zip")
}
// The dist watcher dies silently if dist is deleted and recreated (dead inode).
if (!/keep `dist` itself alive/.test(packager)) {
  problems.push("package.mjs lost the dist-inode contract comment")
}

const entry = require(path.join(root, "index.js"))
const pluginObj = entry?.plugin ?? entry?.default?.plugin
if (!pluginObj || typeof pluginObj.init !== "function" || typeof pluginObj.query !== "function") {
  problems.push("index.js does not export a plugin object with init and query")
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"))
  process.exit(1)
}
console.log(`check ok: ${keyNames.size} i18n keys, ${sourceFiles.length} source files`)

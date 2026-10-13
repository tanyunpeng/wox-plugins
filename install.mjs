// Install both plugins from this repository into the running Wox.
// Cross-platform: Windows, Linux and macOS all resolve the same ~/.wox/wox-user tree.
// Repeatable: it only overwrites the deploy targets, never deletes user data.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const live = path.join(homedir(), ".wox", "wox-user", "plugins", "single-file");
const pluginDir = path.join(root, "Wox.Plugin.bitwarden");

function run(cmd, args, cwd) {
  // shell:true is what makes `npm` resolve on Windows (npm.cmd); the command line is
  // built from fixed literals, so joining is safe and dodges Node's DEP0190 warning.
  const result = spawnSync([cmd, ...args].join(" "), { cwd, stdio: "inherit", shell: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(`${cmd} ${args.join(" ")} failed with status ${result.status}`);
}

mkdirSync(live, { recursive: true });
const source = path.join(root, "Wox.Plugin.Script.Prompt", "Wox.Plugin.Script.Prompt.js");
copyFileSync(source, path.join(live, path.basename(source)));
console.log(`deployed ${path.basename(source)} -> ${live} (Wox hot-reloads in about 500 ms)`);

if (!existsSync(path.join(pluginDir, "node_modules", "@bitwarden", "sdk-internal"))) run("npm", ["install"], pluginDir);
run("npm", ["run", "check"], pluginDir);
run("npm", ["run", "package"], pluginDir);

let sqlite = true;
try {
  await import("node:sqlite");
} catch {
  sqlite = false;
}
if (sqlite) {
  run("node", ["build/register-dev.cjs"], pluginDir);
  console.log("done. Restart Wox once so it re-scans the dev-plugin directory.");
  console.log("If register-dev reported 'database is locked', close Wox and run this script again.");
} else {
  console.log(`Skipped dev-directory registration: this Node (${process.version}) has no node:sqlite, which was added in v22.5.0.`);
  console.log("Add the folder by hand instead: Wox 设置 -> 插件 -> 本地插件目录 -> " + pluginDir);
  console.log("Everything above is installed, so pw and pt already work.");
}

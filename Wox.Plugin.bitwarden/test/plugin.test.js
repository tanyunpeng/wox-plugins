const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BitwardenPlugin } = require("../src/plugin");
const { VaultwardenClient } = require("../src/client");
const { makeTransport, vault, EMAIL, MASTER_PASSWORD } = require("./fixtures");
const { formatStamp } = require("../src/time");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "plugin.json"), "utf8"));
const STRINGS = manifest.I18n.en_US;

function makeApi(initialSettings = {}) {
  const settings = { ...initialSettings };
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "wox-bw-test-"));
  const calls = { copy: [], notify: [], set: [], log: [], update: [], refresh: [], hide: 0 };
  const api = {
    GetSetting: async (_ctx, key) => settings[key] ?? "",
    // The fourth argument of SaveSetting is the platform dimension, not "local",
    // and the method is deprecated in the SDK and the core. Reaching for it here
    // is a bug, so make it loud instead of quietly recording it.
    SaveSetting: async () => {
      throw new Error("SaveSetting is deprecated: use SetSetting");
    },
    SetSetting: async (_ctx, option) => {
      calls.set.push(option);
      settings[option.Key] = option.Value;
      return { Success: true, ErrMsg: "" };
    },
    GetTranslation: async (_ctx, key) => {
      assert.ok(key in STRINGS, `translation key missing from plugin.json: ${key}`);
      return STRINGS[key];
    },
    Notify: async (_ctx, message) => void calls.notify.push(message),
    Log: async (_ctx, level, message) => void calls.log.push({ level, message }),
    Copy: async (_ctx, params) => void calls.copy.push(params.text),
    HideApp: async () => void calls.hide++,
    OpenUrl: undefined,
    UpdateResult: async (_ctx, result) => void calls.update.push(result),
    RefreshQuery: async (opts) => void calls.refresh.push(opts),
    GetCacheFolder: async () => cache,
    OnSettingChanged: async () => {},
    OnUnload: async () => {},
  };
  return { api, calls, settings, cache };
}

async function newPlugin(initialSettings = {}, options = {}) {
  const { api, calls, cache } = makeApi(initialSettings);
  const client = new VaultwardenClient(makeTransport());
  // No test reaches the network for a favicon: hosts default to "no icon".
  const plugin = new BitwardenPlugin(client, { fetch: options.fetch ?? (async () => ({ status: 404 })) });
  await plugin.init({}, { API: api });
  return { plugin, api, calls, client, cache };
}

async function unlock(plugin, client) {
  await client.login({ serverUrl: "https://vw.example", email: EMAIL, masterPassword: MASTER_PASSWORD, deviceIdentifier: "d" });
  await client.sync({ force: true });
}

test("the server URL is gated by metadata, not by a setup row from query()", async () => {
  // Core checks QueryRequirements.AnyQuery and returns its own setup result before
  // the plugin is called (manager.go:1631), so query() must not duplicate that.
  assert.deepStrictEqual(
    manifest.QueryRequirements.AnyQuery.map((r) => r.SettingKey),
    ["serverUrl"],
  );
  assert.ok(!("need_server_title" in STRINGS), "the ad hoc setup rows are gone with the branch that produced them");
});

test("lock answers locally, and an undeclared command is just a search", async () => {
  const { plugin } = await newPlugin();
  const lock = await plugin.query({}, { Command: "lock" });
  assert.strictEqual(lock.Results[0].Title, STRINGS.already_locked_title, "pw lock is the one row that needs no server");
  // Everything else falls through to the normal locked path; the removed login /
  // logout / sync commands must not be reachable by typing them.
  for (const Command of ["login", "logout", "sync", "unlock", "locks"]) {
    const res = await plugin.query({}, { Command, Search: "" });
    assert.strictEqual(res.Results[0].Title, STRINGS.unlock_title, `pw ${Command} is not a command any more`);
  }
});

test("an unknown command is ignored, not routed to a removed feature", async () => {
  const { plugin, client } = await newPlugin({ serverUrl: "https://vw.example" });
  await unlock(plugin, client);
  const res = await plugin.query({}, { Command: "sync", Search: "演示" });
  assert.strictEqual(res.Results[0].Title, "演示 GitHub", "pw sync is just a search on the cached vault now");
  assert.ok(res.Results.every((r) => r.Id.startsWith("pw-item-")), "no status row is injected any more");
});

test("locked state offers a login form with a masked password field", async () => {
  const { plugin } = await newPlugin({ serverUrl: "https://vw.example", accountEmail: "someone@example.com" });
  const res = await plugin.query({}, { Search: "" });
  const row = res.Results[0];
  assert.strictEqual(row.Title, STRINGS.unlock_title);
  const form = row.Actions[0];
  assert.strictEqual(form.Type, "form");
  assert.strictEqual(form.IsDefault, true);
  assert.deepStrictEqual(form.Form.map((f) => f.Type), ["textbox", "password"]);
  assert.strictEqual(form.Form[0].Value.DefaultValue, "someone@example.com", "the last used email must prefill");
  assert.strictEqual(form.Form[1].Value.DefaultValue, "", "the password field must never be prefilled");
});

test("login persists only email and a device id, never the master password", async () => {
  const { plugin, calls, client } = await newPlugin({ serverUrl: "https://vw.example" });
  const res = await plugin.query({}, { Search: "" });
  await res.Results[0].Actions[0].OnSubmit({}, { Values: { email: EMAIL, masterPassword: MASTER_PASSWORD } });
  assert.strictEqual(client.unlocked, true);
  const keys = calls.set.map((s) => s.Key).sort();
  assert.deepStrictEqual(keys, ["accountEmail", "deviceId"]);
  for (const saved of calls.set) {
    assert.notStrictEqual(saved.Value, MASTER_PASSWORD, `setting ${saved.Key} would store the master password`);
    assert.notStrictEqual(saved.Key, "masterPassword");
    assert.ok(!String(saved.Value).includes(MASTER_PASSWORD));
  }
  const device = calls.set.find((s) => s.Key === "deviceId");
  assert.strictEqual(device.IsLocal, true, "the device identifier stays on this machine");
  assert.strictEqual(device.PlatformSpecific, false, "a platform-scoped key is still cloud-synced, so another box would reuse it");
  assert.match(device.Value, /^[0-9a-f-]{36}$/);
  assert.strictEqual(calls.set.find((s) => s.Key === "accountEmail").IsLocal, undefined, "the account email stays an ordinary synced setting");
});

test("a failed login surfaces the message and does not half-unlock", async () => {
  const { plugin, calls, client } = await newPlugin({ serverUrl: "https://vw.example" });
  const res = await plugin.query({}, { Search: "" });
  // Point this client at a transport that rejects the hash.
  client.transport = makeTransport({ expectedAuthHash: "nope" });
  await res.Results[0].Actions[0].OnSubmit({}, { Values: { email: EMAIL, masterPassword: "wrong password" } });
  assert.strictEqual(client.unlocked, false);
  assert.strictEqual(calls.notify.at(-1), STRINGS.err_password_wrong);
  assert.ok(calls.log.some((l) => l.level === "Error"));
});

test("search rows: unique action ids, one default action, masked preview", async () => {
  const { plugin, client } = await newPlugin({ serverUrl: "https://vw.example" });
  await unlock(plugin, client);
  const res = await plugin.query({}, { Search: "" });
  assert.strictEqual(res.Results.length, client.items.length, "every login item is listed for an empty query");
  const ids = [];
  for (const row of res.Results) {
    ids.push(row.Id);
    // A durable result must carry an IdentityKey of its own or Wox cannot pin it,
    // score it, or restore it - the cipher id is exactly that.
    assert.strictEqual(row.IdentityKey, row.Id.replace("pw-item-", ""), "the row identity is the cipher id, not the name");
    for (const action of row.Actions) ids.push(action.Id);
  }
  assert.strictEqual(new Set(ids).size, ids.length, "the host keeps every action id in one map, so ids must be unique");
  assert.ok(ids.every((id) => !/\s/.test(id) && !id.includes("/")), "ids with spaces or slashes break the host action lookup");

  const personal = res.Results.find((r) => r.Title === "演示 GitHub");
  assert.strictEqual(personal.SubTitle, "demo@example.com", "the row subtitle is the account, like the vault list");
  assert.strictEqual(personal.Icon.ImageType, "svg", "an unprobed host keeps the shield: Wox has no fallback for a dead url icon");
  const defaults = personal.Actions.filter((a) => a.IsDefault);
  assert.strictEqual(defaults.length, 1, "exactly one default action per row");
  assert.strictEqual(defaults[0].Name, "i18n:copy_password", "Enter copies the password; the host hoists the default to panel row 1");
  assert.ok(personal.Actions.every((a) => !a.Hotkey), "no action declares a hotkey: everything except Enter is a button");
  assert.strictEqual(
    personal.Actions.find((a) => a.Name === "i18n:toggle_secret").ShowInToolbar,
    true,
    "the eye claims a toolbar button explicitly, because only the default action shows up there automatically",
  );
  assert.strictEqual(
    personal.Actions.find((a) => a.Name === "i18n:copy_username").ShowInToolbar,
    true,
    "copying the username is a toolbar button too (tbview.go:361 fits pinned actions by width, in source order)",
  );
  assert.deepStrictEqual(
    personal.Actions.map((a) => a.Name),
    ["i18n:copy_password", "i18n:copy_username", "i18n:copy_uri", "i18n:copy_totp", "i18n:toggle_secret"],
    "panel order is the locked one: copy, username, link, code, eye last",
  );

  assert.deepStrictEqual(personal.Tails.map((t) => t.Type), ["text", "image"], "the URI host is not a tail any more: it repeats the title");
  assert.strictEqual(personal.Tails[0].Text, "★", "favourites are marked");
  assert.strictEqual(personal.Tails[1].Tooltip, STRINGS.field_totp);
  assert.strictEqual(personal.Tails[1].ImageHeight, 22, "an image tail is as tall as the native text tails beside it");

  const preview = personal.Preview;
  assert.strictEqual(preview.PreviewType, "markdown", "markdown is the only preview surface whose links are clickable");
  assert.ok(!preview.PreviewData.includes(vault.personalPassword), "the default preview must not contain the plaintext password");
  assert.match(preview.PreviewData, /•/);
  const uriBlocks = preview.PreviewData.split("\n\n").filter((b) => b.startsWith(`**${STRINGS.field_uris}`));
  assert.strictEqual(uriBlocks.length, 2, "one preview block per address, so none of them folds away");
  assert.match(uriBlocks[0], new RegExp(`^\\*\\*${STRINGS.field_uris} 1/2 · ${STRINGS.primary_uri}\\*\\*`));
  assert.strictEqual(uriBlocks[0].split("\n")[1], "github.com", "a scheme-less address stays text, it cannot be opened");
  assert.strictEqual(uriBlocks[1].split("\n")[1], "[https://api.github.com](<https://api.github.com>)", "an http(s) address is a real link");
  const totpBlock = preview.PreviewData.split("\n\n").find((b) => b.startsWith(`**${STRINGS.field_totp}**`));
  const untilPattern = STRINGS.totp_expires.replace("{time}", "\\d{2}:\\d{2}:\\d{2}");
  assert.match(totpBlock, new RegExp(`\\n\\d{6} · ${untilPattern}$`), "the code row names the absolute end of its window, not a countdown");
  assert.ok(!/\d+s(\s|$)/.test(totpBlock), "a frozen '15s' would read as a live timer and lie within seconds");
  assert.deepStrictEqual(preview.PreviewTags, [{ Label: STRINGS.tag_hidden }], "one tag, and it says which field it is talking about");
  const blocks = preview.PreviewData.split("\n\n");
  const valueOf = (label) => {
    const block = blocks.find((b) => b.startsWith(`**${label}**  \n`));
    return block ? block.split("\n")[1] : undefined;
  };
  assert.ok(
    !blocks.some((b) => (b.match(/\*\*/g) ?? []).length > 2),
    "one label per block: the metadata keeps the same rhythm as the fields above it",
  );
  assert.strictEqual(valueOf(STRINGS.field_folder), "示例文件夹", "the folder is a field of its own");
  assert.strictEqual(valueOf(STRINGS.field_scope), STRINGS.scope_personal, "a personal item owns itself, worded the way the vault form words it");
  const revised = new Date(Date.parse("2026-10-01T10:00:00.000Z"));
  assert.strictEqual(valueOf(STRINGS.field_updated), formatStamp(revised.getTime()), "更新于 is the local minute, not the UTC calendar day the ISO string starts with");
  const orgRow = res.Results.find((r) => r.Title === "组织共享条目");
  assert.strictEqual(
    orgRow.Preview.PreviewData.split("\n\n").find((b) => b.startsWith(`**${STRINGS.field_scope}**  \n`)).split("\n")[1],
    "示例组织",
    "the owner slot shows the organisation's own name, not a generic label",
  );
  assert.ok(!preview.PreviewData.includes("<svg"), "the icon rows are gone with the list preview, no raw HTML either");

  const noteless = res.Results.find((r) => r.Title === "空白登录条目");
  assert.deepStrictEqual(noteless.Tails, [], "nothing is invented for an empty item");
  assert.strictEqual(noteless.Icon.ImageType, "svg", "no host means the vault icon");
});

test("an item with nothing to copy still has a default action", async () => {
  const { plugin, client, calls } = await newPlugin({ serverUrl: "https://vw.example" });
  await unlock(plugin, client);
  const res = await plugin.query({}, { Search: "空白登录条目" });
  const bare = res.Results[0];
  assert.strictEqual(bare.Title, "空白登录条目");
  assert.strictEqual(bare.SubTitle, STRINGS.no_username_or_uri);
  const fallback = bare.Actions.find((a) => a.IsDefault);
  assert.strictEqual(fallback.Name, "i18n:copy_name");
  await fallback.Action({}, {});
  assert.strictEqual(calls.copy.at(-1), "空白登录条目");
});

test("a row switches to its site icon once the probe answers", async () => {
  const { createIconCache } = require("../src/favicon");
  const cache = createIconCache();
  // A macrotask delay guarantees the first query finishes before the answer lands.
  const fetchStub = async () => {
    await new Promise((done) => setTimeout(done, 10));
    return { status: 200 };
  };
  const { plugin, client } = await newPlugin({ serverUrl: "https://vw.example" }, { icons: cache, fetch: fetchStub });
  await unlock(plugin, client);

  const before = (await plugin.query({}, { Search: "演示" })).Results.find((r) => r.Title === "演示 GitHub");
  assert.strictEqual(before.Icon.ImageType, "svg", "the first render cannot wait on the network");
  await cache.probe(["github.com"], fetchStub);
  const after = (await plugin.query({}, { Search: "演示" })).Results.find((r) => r.Title === "演示 GitHub");
  assert.deepStrictEqual(after.Icon, { ImageType: "url", ImageData: "https://github.com/favicon.ico" });
});

test("copy actions decrypt at click time and clear the way for autofill", async () => {
  const { plugin, client, calls } = await newPlugin({ serverUrl: "https://vw.example" });
  await unlock(plugin, client);
  const res = await plugin.query({}, { Search: "演示" });
  const row = res.Results.find((r) => r.Title === "演示 GitHub");
  const actionFor = (name) => row.Actions.find((a) => a.Name === name);

  await actionFor("i18n:copy_password").Action({}, {});
  assert.strictEqual(calls.copy.at(-1), vault.personalPassword);
  assert.strictEqual(calls.notify.at(-1), STRINGS.password_copied);

  await actionFor("i18n:copy_username").Action({}, {});
  assert.strictEqual(calls.copy.at(-1), "demo@example.com");

  await actionFor("i18n:copy_totp").Action({}, {});
  assert.match(calls.copy.at(-1), /^\d{6}$/);
  assert.match(calls.notify.at(-1), /^Copied \d{6}, valid \d+s$/);

  const usage = path.join(calls.cache ?? "", "usage.json");
  void usage;
});

test("usage is written to the cache folder, not to settings", async () => {
  const { plugin, client, calls, cache } = await newPlugin({ serverUrl: "https://vw.example" });
  await unlock(plugin, client);
  const res = await plugin.query({}, { Search: "演示" });
  const row = res.Results.find((r) => r.Title === "演示 GitHub");
  await row.Actions.find((a) => a.Name === "i18n:copy_password").Action({}, {});
  const written = JSON.parse(fs.readFileSync(path.join(cache, "usage.json"), "utf8"));
  assert.ok(Object.keys(written).length === 1);
  assert.strictEqual(Object.values(written)[0].count, 1);
  assert.ok(!calls.set.some((s) => s.Key === "usageStats"), "usage data must not become a synced setting");
});

test("reveal is explicit, per-row, and resets on the next query", async () => {
  const { plugin, client, calls } = await newPlugin({ serverUrl: "https://vw.example" });
  await unlock(plugin, client);
  const res = await plugin.query({}, { Search: "演示" });
  const row = res.Results.find((r) => r.Title === "演示 GitHub");
  const toggleId = `pw-toggle-${row.Id.replace("pw-item-", "")}`;
  const hiddenIcon = row.Actions.find((a) => a.Id === toggleId).Icon;
  await row.Actions.find((a) => a.Id === toggleId).Action({}, {});
  const updated = calls.update.at(-1);
  assert.ok(updated.Preview.PreviewData.split("\n\n").some((b) => b.endsWith(vault.personalPassword)));
  assert.notStrictEqual(
    updated.Actions.find((a) => a.Id === toggleId).Icon.ImageData,
    hiddenIcon.ImageData,
    "one label for both states, so the icon is what tells them apart",
  );
  const again = await plugin.query({}, { Search: "演示" });
  const refetched = again.Results.find((r) => r.Title === "演示 GitHub");
  assert.strictEqual(refetched.Actions.find((a) => a.Id === toggleId).Icon.ImageData, hiddenIcon.ImageData, "a new query must start hidden again");
  assert.ok(!refetched.Preview.PreviewData.includes(vault.personalPassword));
});

test("the primary address is copied, never launched: no plugin owns a browser process", async () => {
  const { plugin, client, calls } = await newPlugin({ serverUrl: "https://vw.example" });
  await unlock(plugin, client);
  const res = await plugin.query({}, { Search: "演示" });
  const row = res.Results.find((r) => r.Title === "演示 GitHub");
  const opens = row.Actions.filter((a) => a.Name === "i18n:copy_uri");
  assert.strictEqual(opens.length, 1, "two stored URIs but one link action: the others live in the preview as links");
  await opens[0].Action({}, {});
  assert.strictEqual(calls.copy.at(-1), "github.com", "the address is put on the clipboard as stored");
  assert.strictEqual(calls.notify.at(-1), STRINGS.uri_copied);
  assert.strictEqual(calls.hide, 0, "nothing hides the launcher any more: the plugin starts no processes");
});

test("lock drops the keys but keeps the session, and there is nothing else to end it", async () => {
  const { plugin, client, calls } = await newPlugin({ serverUrl: "https://vw.example" });
  await unlock(plugin, client);
  const lockRes = await plugin.query({}, { Command: "lock" });
  await lockRes.Results[0].Actions[0].Action({}, {});
  assert.strictEqual(client.unlocked, false);
  assert.ok(client.accessToken, "lock keeps the session");
  assert.strictEqual(calls.notify.at(-1), STRINGS.lock_done);

  const lockedAgain = await plugin.query({}, { Command: "lock" });
  assert.strictEqual(lockedAgain.Results[0].Title, STRINGS.already_locked_title);

  // The only way back in is a plain query, which offers the unlock form again.
  const unlockForm = await plugin.query({}, { Search: "github" });
  assert.strictEqual(unlockForm.Results[0].Title, STRINGS.unlock_title);
  assert.strictEqual(unlockForm.Results[0].Actions[0].Type, "form");
});

test("query errors are mapped to readable text, never a stack trace", async () => {
  const { plugin, client } = await newPlugin({ serverUrl: "https://vw.example" });
  await unlock(plugin, client);
  // A stale cache plus an expired token with nothing to refresh it with.
  client.expiresAt = Date.now() - 1000;
  client.refreshToken = null;
  client.syncedAt = 0;
  const res = await plugin.query({}, { Search: "演示" });
  assert.strictEqual(res.Results[0].Title, STRINGS.error_title);
  assert.strictEqual(res.Results[0].SubTitle, STRINGS.err_session_expired);
  assert.deepStrictEqual(res.Results[0].Actions, []);
});

test("network failure is reported as unreachable", async () => {
  const { plugin, client } = await newPlugin({ serverUrl: "https://vw.example" });
  await unlock(plugin, client);
  client.transport = async () => {
    throw new Error("fetch failed");
  };
  // The cache is fresh after unlock, so force the refetch the removed `pw sync`
  // command used to do by hand.
  client.syncedAt = 0;
  const res = await plugin.query({}, { Search: "" });
  assert.strictEqual(res.Results[0].SubTitle, STRINGS.err_unreachable);
});

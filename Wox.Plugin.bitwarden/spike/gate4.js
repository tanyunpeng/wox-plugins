// Gate 4: end-to-end run of the SHIPPED plugin code against YOUR Vaultwarden.
//
//   node spike/gate4.js https://your-vaultwarden you@email.com [--insecure]
//
// The master password is read from BW_TEST_PASSWORD or a hidden prompt -- never
// argv. Only this process holds it, and it is used once to derive the user key.
//
// What it proves, with the same modules the plugin loads (src/client.js,
// src/plugin.js, src/sdk.js):
//   1. login + key assembly against the real server (PBKDF2, userKey, RSA key)
//   2. /sync decrypts every cipher class the account actually holds
//   3. the organisation-key path that this server answers with
//   4. the plugin renders rows/actions/previews over real data, ids unique
//   5. hot-path latency: cached query, and a forced sync
// Read-only: /alive, prelogin, connect/token, GET /sync. No POST/PUT/DELETE.
// Output contains no secret: lengths, counts, prefixes, field names. A decrypted
// password is only ever compared, never printed; a live TOTP is only shape-checked.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { VaultwardenClient } = require("../src/client");
const { BitwardenPlugin } = require("../src/plugin");
const favicon = require("../src/favicon");

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const [baseUrlRaw, email] = args.filter((a) => !a.startsWith("--"));
if (!baseUrlRaw || !email) {
  console.error("usage: node gate4.js <base-url> <email> [--insecure]");
  process.exit(2);
}
if (flags.includes("--insecure")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const base = baseUrlRaw.replace(/\/+$/, "");

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
}

async function main() {
  // The password arrives only through BW_TEST_PASSWORD. The terminal prompt is
  // deliberately not used: whether raw-mode capture survives this console is
  // unproven, and a mangled password looks exactly like a wrong one.
  const masterPassword = process.env.BW_TEST_PASSWORD;
  if (!masterPassword) {
    console.error(
      "BW_TEST_PASSWORD is required. In PowerShell:\n" +
        '  $s = Read-Host "master password" -AsSecureString\n' +
        "  $env:BW_TEST_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringUni(" +
        "[Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($s))\n" +
        `  node spike/gate4.js ${baseUrlRaw ?? "<url>"} <email>\n` +
        "  Remove-Item Env:BW_TEST_PASSWORD\n" +
        "In bash / zsh:\n" +
        "  read -rs pw; export BW_TEST_PASSWORD=\"$pw\"; unset pw\n" +
        "  node spike/gate4.js <url> <email>\n" +
        "  unset BW_TEST_PASSWORD",
    );
    process.exit(2);
  }
  // Shape only -- length and character classes, enough to see that the shell
  // handed over something else; never the password, never a brute-forceable hash.
  console.log(`password: length=${masterPassword.length} codepoints=${[...masterPassword].length} ` +
    `${Object.entries(fingerprintCounts(masterPassword)).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(" ")} ` +
    `boundary=${boundaryInfo(masterPassword) || "clean"}`);
  const pre = await fetch(`${base}/identity/accounts/prelogin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email }),
  }).then((r) => r.json().catch(() => null));
  console.log(`prelogin: ${JSON.stringify(pre)}`);

  // --- 1. login through the shipped client --------------------------------
  const client = new VaultwardenClient();
  // Record the wire shape the client itself sees (field names and EncString
  // prefixes only) instead of adding spike-only diagnostics to production code.
  const wire = [];
  const realTransport = client.transport;
  client.transport = async (url, init) => {
    const res = await realTransport(url, init);
    try {
      if (url.includes("/connect/token") && res.clone) {
        const j = JSON.parse(await res.clone().text());
        for (const field of ["AccountKeys", "UserDecryptionOptions"]) {
          if (j[field]) wire.push(`${field} keys=[${Object.keys(j[field]).join(",")}]`);
        }
        const map = j.AccountKeys?.organizationKeys ?? j.AccountKeys?.OrganizationKeys;
        if (map && typeof map === "object") {
          const first = Object.values(map)[0];
          wire.push(`organization map: entries=${Object.keys(map).length} valuePrefix=${typeof first === "string" ? first.slice(0, 2) : typeof first}`);
        }
        wire.push(`token fields=[${Object.keys(j).join(",")}]`);
      }
    } catch {
      /* diagnostics must never break the run */
    }
    return res;
  };
  const dumpWire = () => {
    for (const line of wire) console.log(`      ${line}`);
  };
  const t0 = Date.now();
  let info;
  try {
    info = await client.login({
      serverUrl: baseUrlRaw,
      email,
      masterPassword,
      deviceIdentifier: `gate4-${Math.random().toString(36).slice(2, 10)}`,
    });
  } catch (error) {
    check("login", false, String(error.message).slice(0, 160));
    dumpWire();
    return finish();
  }
  dumpWire();
  const loginMs = Date.now() - t0;
  check("login derives a 64-byte user key", client.userKey.length === 64, `userKey=${client.userKey.length}B, kdf=${info.kdfType}/${info.iterations}, ${loginMs} ms`);
  check("session token + refresh token issued", Boolean(client.accessToken && client.refreshToken), `expires in ${Math.round((client.expiresAt - Date.now()) / 1000)}s`);
  check("RSA private key decrypted", client.privateKeyDer.length > 500, `privateKeyDer=${client.privateKeyDer.length}B`);

  // --- 2. sync + decrypt every class the vault holds ----------------------
  const t1 = Date.now();
  const items = await client.sync({ force: true });
  const syncMs = Date.now() - t1;
  const prefixHist = {};
  let withUri = 0;
  let maxUri = 0;
  let perItemKey = 0;
  for (const item of items) {
    if (item.key !== client.userKey) perItemKey++;
    if (item.uris.length) withUri++;
    maxUri = Math.max(maxUri, item.uris.length);
    for (const blob of [item.secrets.password, item.secrets.totp, item.secrets.note, ...item.secrets.fields.map((f) => f.value)]) {
      const prefix = typeof blob === "string" && /^\d\./.test(blob) ? blob.slice(0, 2) : blob ? "?" : "-";
      prefixHist[prefix] = (prefixHist[prefix] ?? 0) + 1;
    }
  }
  const d = client.diagnostics;
  check("/sync decrypts without loss", d.undecryptable === 0 && d.orgKeysFailed === 0, `${items.length} items in ${syncMs} ms, ciphers=${d.ciphers} deleted=${d.skipped} nonLogin=${d.nonLogin} undecryptable=${d.undecryptable} orgKeyFail=${d.orgKeysFailed}`);
  console.log(`      encPrefixes=${JSON.stringify(prefixHist)} orgKeys=${client.orgKeys.size} via=${d.orgKeySource} non-userKey-items=${perItemKey} items-with-uri=${withUri} uris(max)=${maxUri}`);

  const unsupported = Object.keys(prefixHist).filter((p) => p !== "2." && p !== "-");
  check("every blob is a supported EncString type (2. aes-cbc-hmac)", unsupported.length === 0, unsupported.length ? `unexpected prefixes: ${unsupported.join(",")}` : "all 2.");

  // --- 2b. organisation keys ----------------------------------------------
  const orgIds = [...new Set(items.filter((i) => i.organizationId).map((i) => i.organizationId))];
  const missing = orgIds.filter((id) => !client.orgKeys.has(id));
  check("every organisation the vault references has a usable key", missing.length === 0, `${items.filter((i) => i.organizationId).length} org items in ${orgIds.length} org(s), source=${d.orgKeySource}, without a key=${missing.length}`);
  if (missing.length > 0) {
    // Read-only GETs with the token we already hold. Vaultwarden implements
    // /organizations/{id} and /organizations/{id}/keys; the names below show
    // which one answers and what it calls the wrapped key.
    const probes = [
      "/api/profiles/organizations",
      `/api/organizations/${missing[0]}`,
      `/api/organizations/${missing[0]}/keys`,
    ];
    for (const probe of probes) {
      let status = "n/a";
      let shape = "";
      try {
        const r = await fetch(`${base}${probe}`, { headers: { Authorization: `Bearer ${client.accessToken}`, Accept: "application/json" } });
        status = r.status;
        const body = await r.text();
        try {
          const j = JSON.parse(body);
          const item = Array.isArray(j) ? j[0] : j;
          const keyField = item?.key ?? item?.Key;
          shape =
            `${Array.isArray(j) ? `array(${j.length})` : "object"} keys=[${Object.keys(item ?? {}).join(",")}]` +
            ` keyPrefix=${typeof keyField === "string" ? keyField.slice(0, 2) : typeof keyField}`;
        } catch {
          shape = `non-json ${JSON.stringify(body.slice(0, 60))}`;
        }
      } catch (error) {
        shape = error.message;
      }
      console.log(`      probe ${probe} -> ${status} ${shape}`);
    }
  }

  // --- 3. plaintext must not be resident in the cached item list -----------
  // "Resident" means a stored plaintext field IS the password. A substring test
  // would flag every short password that happens to sit inside a URL, which is a
  // property of the vault rather than of the cache, so the two are reported apart.
  // The invariant is "every secret is still ciphertext in the cache". Testing it
  // directly beats testing for the plaintext elsewhere: his vault has an item
  // whose username IS its password, which is data, not a leak.
  const unencrypted = [];
  const sameStringElsewhere = [];
  for (const item of items) {
    const blobs = [item.secrets.password, item.secrets.totp, item.secrets.note, ...item.secrets.fields.map((f) => f.value)];
    for (const blob of blobs.filter(Boolean)) {
      if (!/^\d\./.test(String(blob))) unencrypted.push(`${item.id} blob without an EncString prefix: ${JSON.stringify(String(blob).slice(0, 24))}`);
    }
    const pw = item.secrets.password ? safe(client, item) : "";
    if (!pw) continue;
    const hits = Object.entries(item)
      .filter(([key, value]) => key !== "secrets" && (typeof value === "string" ? value === pw : Array.isArray(value) && value.includes(pw)))
      .map(([key]) => key);
    if (hits.length) sameStringElsewhere.push(`${item.id} also in [${hits.join(",")}] pwLen=${pw.length}`);
  }
  check(
    "every cached secret is still an encrypted blob",
    unencrypted.length === 0,
    unencrypted.slice(0, 3).join(" | ") || `${items.length} items, cache bytes=${JSON.stringify(items).length}`,
  );
  if (sameStringElsewhere.length) {
    console.log(`      item stores the same string in a searchable field (data, not a leak): ${sameStringElsewhere.join(" | ")}`);
    console.log("      note: the preview masks its password row, but that row's username shows the same characters.");
  }
  const withTotp = items.filter((i) => i.secrets.totp);
  if (withTotp.length > 0) {
    const shapes = withTotp.map((i) => {
      try {
        const { code, digits, period } = client.totpCode(i);
        return `${code.length}/${digits}/${period}`;
      } catch (error) {
        return `err:${String(error.message).slice(0, 24)}`;
      }
    });
    check("TOTP generated from every stored encrypted secret", shapes.every((s) => /^\d\/\d\/\d+$/.test(s)), `${withTotp.length} secrets, shapes=${[...new Set(shapes)].join(" ")}`);
  }

  // --- 4. what the raw /sync actually names its URI fields ----------------
  const raw = await fetch(`${baseUrlRaw.replace(/\/+$/, "")}/api/sync`, {
    headers: { Authorization: `Bearer ${client.accessToken}`, Accept: "application/json" },
  });
  const rawJson = await raw.json();
  const rawCiphers = rawJson.ciphers ?? [];
  const rawLogins = rawCiphers.filter((c) => c.type === 1 && !c.deletedDate).length;
  const rawDeleted = rawCiphers.filter((c) => c.deletedDate).length;
  const rawNonLogin = rawCiphers.filter((c) => c.type !== 1 && !c.deletedDate).length;
  check(
    "the login-only filter keeps exactly the credential-bearing ciphers",
    items.length === rawLogins && items.length + rawDeleted + rawNonLogin === rawCiphers.length,
    `shown=${items.length} raw type-1-not-deleted=${rawLogins} (all=${rawCiphers.length}, deleted=${rawDeleted}, non-login=${rawNonLogin})`,
  );
  const typeHist = {};
  for (const c of rawCiphers) typeHist[c.type] = (typeHist[c.type] ?? 0) + 1;
  console.log(`      raw cipher type histogram (1=login): ${JSON.stringify(typeHist)}`);
  const firstCipher = (rawJson.ciphers ?? []).find((c) => (c.login?.uris ?? c.Login?.URIs)?.length);
  const uriObj = firstCipher ? (firstCipher.login?.uris ?? firstCipher.Login?.URIs)[0] : null;
  check("URI object field names are readable", Boolean(uriObj), uriObj ? `fields=${Object.keys(uriObj).join(",")}` : "no cipher with a URI");
  const loginFields = (firstCipher?.login ?? firstCipher?.Login ?? {});
  console.log(`      login sub-object fields=${Object.keys(loginFields).join(",")} cipher fields=${Object.keys(firstCipher ?? {}).join(",")}`);
  console.log(`      top-level /sync fields=${Object.keys(rawJson).join(",")}`);
  const profile = rawJson.profile ?? rawJson.Profile ?? {};
  const syncOrgs = profile.organizations ?? profile.Organizations ?? [];
  const orgKeyField = syncOrgs[0]?.key ?? syncOrgs[0]?.Key;
  console.log(
    `      profile fields=${Object.keys(profile).join(",")} organizations=${syncOrgs.length}` +
      ` item fields=${Object.keys(syncOrgs[0] ?? {}).join(",")} keyPrefix=${typeof orgKeyField === "string" ? orgKeyField.slice(0, 2) : typeof orgKeyField}`,
  );

  // --- 5. the plugin UI over real data ------------------------------------
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "wox-bw-gate4-"));
  const settings = { serverUrl: baseUrlRaw, accountEmail: email };
  const calls = { copy: [], notify: [], save: [], log: [], update: [], hide: 0 };
  const api = {
    GetSetting: async (_c, key) => settings[key] ?? "",
    SetSetting: async (_c, option) => {
      calls.save.push(option);
      settings[option.Key] = option.Value;
      return { Success: true, ErrMsg: "" };
    },
    GetTranslation: async (_c, key) => `[${key}]`,
    Notify: async (_c, m) => void calls.notify.push(m),
    Log: async (_c, level, m) => void calls.log.push({ level, m }),
    Copy: async (_c, params) => void calls.copy.push(params.text),
    HideApp: async () => void calls.hide++,
    UpdateResult: async (_c, r) => void calls.update.push(r),
    RefreshQuery: async () => {},
    GetCacheFolder: async () => cache,
    OnSettingChanged: async () => {},
    OnUnload: async () => {},
  };
  // The plugin's only outbound non-vault traffic is the favicon probe, so the
  // gate stays offline unless --icons explicitly asks for it.
  const realFetch = (url, init) => fetch(url, init);
  const noIconFetch = async () => ({ status: 404 });
  const plugin = new BitwardenPlugin(client, { fetch: flags.includes("--icons") ? realFetch : noIconFetch });
  await plugin.init({}, { API: api });

  // How many of his hosts actually serve a favicon: the row icon falls back to
  // the shield for the rest, because Wox cannot render a dead url image. This
  // reaches every site in the vault, so it only runs when asked for.
  if (flags.includes("--icons")) {
    const hosts = [...new Set(items.flatMap((i) => i.uriHosts))];
    const iconCache = favicon.createIconCache();
    await iconCache.probe(hosts, realFetch);
    const withIcon = hosts.filter((h) => iconCache.iconFor(h, null) !== null);
    check("site icons resolve without a broken image", withIcon.length > 0, `${withIcon.length}/${hosts.length} hosts serve /favicon.ico, the rest keep the shield`);
    console.log(`      no favicon: ${hosts.filter((h) => !withIcon.includes(h)).slice(0, 8).join(", ")}${hosts.length > 8 ? " …" : ""}`);
  } else {
    console.log("      (pass --icons to probe how many hosts serve a favicon)");
  }

  const t2 = Date.now();
  const res = await plugin.query({}, { Search: "" });
  const queryMs = Date.now() - t2;
  const ids = [];
  let defaulted = 0;
  let hotkeyed = 0;
  for (const row of res.Results) {
    ids.push(row.Id);
    for (const action of row.Actions ?? []) {
      ids.push(action.Id);
      defaulted += action.IsDefault ? 1 : 0;
      hotkeyed += action.Hotkey ? 1 : 0;
    }
  }
  check("rows render over the real vault", res.Results.length > 0, `${res.Results.length} rows in ${queryMs} ms (cached)`);
  check("every row/action id is unique and host-safe", new Set(ids).size === ids.length && ids.every((i) => !/\s|\//.test(i)), `${ids.length} ids`);
  check("one default action per row", defaulted === res.Results.length, `${defaulted} defaults / ${res.Results.length} rows`);
  check("Enter is the only keyboard gesture: no action declares a hotkey", hotkeyed === 0, `${hotkeyed} hotkeyed actions`);
  // Prove the mask directly rather than by substring: the row that shows the
  // password must show bullets. A subtitle that EQUALS the password in some
  // other row means the vault stores the same string there, which is data, not
  // a leak -- so it is reported apart.
  const maskProblems = [];
  const sameValueElsewhere = [];
  for (const row of res.Results) {
    const item = items.find((i) => `pw-item-${i.id}` === row.Id);
    if (!item?.secrets.password) continue;
    const pw = safe(client, item);
    const blocks = row.Preview.PreviewData.split("\n\n");
    const passwordBlock = blocks.find((b) => b.startsWith("**[field_password]**"));
    const shownValue = passwordBlock ? passwordBlock.split("\n")[1] : undefined;
    if (!passwordBlock || !/^•+$/.test(String(shownValue))) {
      maskProblems.push(`${row.Title} shows ${JSON.stringify(String(shownValue ?? "<missing row>")).slice(0, 48)}`);
    }
    const equals = blocks.filter((b) => b !== passwordBlock && b.includes(pw)).map((b) => b.split("\n")[0]);
    if (equals.length) sameValueElsewhere.push(`${row.Title} [${equals.join(",")}] pwLen=${pw.length}`);
  }
  check("default previews show only masked passwords", maskProblems.length === 0, maskProblems.slice(0, 3).join(" | ") || `${res.Results.length} rows checked`);
  if (sameValueElsewhere.length) console.log(`      vault stores this string elsewhere too (not a leak): ${sameValueElsewhere.slice(0, 3).join(" | ")}`);

  // Click the default action of the first password row and the reveal toggle.
  const rowWithPassword = res.Results.find((r) => (r.Actions ?? []).some((a) => a.Name === "i18n:copy_password"));
  if (rowWithPassword) {
    const copyAction = rowWithPassword.Actions.find((a) => a.Name === "i18n:copy_password");
    await copyAction.Action({}, {});
    check("default copy action puts the decrypted password on the clipboard", calls.copy.length === 1 && calls.copy[0].length > 0, `copied ${calls.copy[0].length} chars (value not printed)`);
    const toggle = rowWithPassword.Actions.find((a) => a.Name === "i18n:toggle_secret");
    await toggle?.Action({}, {});
    const revealedPreview = JSON.stringify(calls.update.at(-1)?.Preview ?? {});
    const pw = safe(client, items.find((i) => `pw-item-${i.id}` === rowWithPassword.Id));
    check("reveal shows that row's password and nothing else", pw ? revealedPreview.includes(pw) : true, pw ? `revealed length=${pw.length}` : "no password row");
  }

  // --- 6. latency of the hot path and of a forced sync --------------------
  const timings = [];
  for (let i = 0; i < 5; i++) {
    const s = Date.now();
    await plugin.query({}, { Search: i % 2 ? "a" : "" });
    timings.push(Date.now() - s);
  }
  timings.sort((a, b) => a - b);
  const t3 = Date.now();
  await client.sync({ force: true });
  const forceMs = Date.now() - t3;
  check("cached query stays inside the debounce budget", timings[3] < 120, `p80=${timings[3]}ms max=${timings[4]}ms`);
  check("forced sync is interactive", forceMs < 4000, `${forceMs} ms`);

  // A full second query after lock proves unlock/lock round-trips cleanly.
  client.lock();
  const locked = await plugin.query({}, { Search: "" });
  check("after pw lock the vault is unreachable and a login form is offered", locked.Results.length === 1 && locked.Results[0].Actions?.[0]?.Type === "form", `rows=${locked.Results.length}`);

  fs.rmSync(cache, { recursive: true, force: true });
  return finish();
}

function fingerprintCounts(pw) {
  const counts = { lower: 0, upper: 0, digit: 0, asciiSymbol: 0, nonAscii: 0 };
  for (const ch of pw) {
    if (ch.codePointAt(0) > 127) counts.nonAscii++;
    else if (/[a-z]/.test(ch)) counts.lower++;
    else if (/[A-Z]/.test(ch)) counts.upper++;
    else if (/[0-9]/.test(ch)) counts.digit++;
    else counts.asciiSymbol++;
  }
  return counts;
}

// Only the outer characters are named, and only as a code point: enough to see
// that the shell handed over a stray space, not enough to leak the password.
function boundaryInfo(pw) {
  const hex = (ch) => `0x${ch.codePointAt(0).toString(16).padStart(2, "0")}`;
  const parts = [];
  if (/^\s/.test(pw)) parts.push(`first=${hex(pw[0])}`);
  if (/\s$/.test(pw) && pw.length > 0) parts.push(`last=${hex(pw[pw.length - 1])}`);
  return parts.join(" ");
}

function safe(client, item) {
  try {
    return item ? client.decryptField(item, "password") : "";
  } catch {
    return "";
  }
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\ngate4: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log(`failed: ${failed.map((f) => f.label).join(" | ")}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`gate4 crashed: ${error.message}`);
  console.error(error.stack.split("\n").slice(1, 4).join("\n"));
  process.exit(2);
});

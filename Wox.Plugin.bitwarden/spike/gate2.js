// Gate 2: read-only diagnosis against YOUR Vaultwarden server.
//
//   node spike/gate2.js https://your-vaultwarden you@email.com
//
// It prompts for the master password with hidden input (or takes it from
// BW_TEST_PASSWORD). Nothing is printed that reveals a secret: only field names,
// EncString type prefixes, byte lengths and counts. No write endpoint is called;
// this script only does /alive, /config, prelogin, connect/token and GET /sync.
const crypto = require("crypto");
const readHidden = require("./hidden-prompt");
const P = require("../node_modules/@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js").PureCrypto;

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const [baseUrlRaw, email] = args.filter((a) => !a.startsWith("--"));
if (!baseUrlRaw || !email) {
  console.error("usage: node gate2.js <base-url> <email>   (it will prompt, hidden)");
  process.exit(2);
}
// Never taken from argv (other Windows processes can read it), never written to
// a file, never echoed. If the env var is absent we prompt with hidden input.
let masterPassword = process.env.BW_TEST_PASSWORD || null;
const insecure = flags.includes("--insecure");
if (insecure) {
  // Diagnostic-only shortcut. The plugin will scope TLS bypass to the configured host.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}
const baseUrl = baseUrlRaw.replace(/\/+$/, "");
const identity = `${baseUrl}/identity`;
const api = `${baseUrl}/api`;
const deviceIdentifier = crypto.randomUUID();
const report = [];
const say = (k, v) => {
  report.push([k, v]);
  console.log(`${k}: ${v}`);
};
const typeOf = (s) => (typeof s === "string" && /^\d\./.test(s) ? s.slice(0, 2) : null);

async function req(url, { method = "GET", headers = {}, body } = {}) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method,
    headers: { "Bitwarden-Client-Version": "2026.10.0", "Bitwarden-Client-Type": "browser", "device-type": "7", ...headers },
    body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* non-JSON error page */ }
  return { status: res.status, ms: Date.now() - t0, json, text: text.slice(0, 300) };
}

const salt = email.trim().toLowerCase();

(async () => {
  say("server", baseUrl);

  // --- 1. reachability + server version ---------------------------------
  try {
    const alive = await req(`${api}/alive`);
    say("GET /api/alive", `${alive.status} in ${alive.ms} ms`);
    const cfg = await req(`${api}/config`);
    say("GET /api/config", `${cfg.status} version=${cfg.json?.version} gitHash=${cfg.json?.gitHash} `
      + `featureStates=${cfg.json?.featureStates ? Object.keys(cfg.json.featureStates).length : "none"}`);
    say("server urls", JSON.stringify(cfg.json?.environment ?? null));
  } catch (e) {
    say("GET /api/alive", `FAILED ${e.message}`);
    process.exit(1);
  }

  // --- 2. prelogin: which KDF does this account use? -------------------
  const pre = await req(`${identity}/accounts/prelogin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (pre.status !== 200) {
    say("prelogin", `${pre.status} ${pre.text}`);
    process.exit(1);
  }
  const kdfType = pre.json.Kdf ?? pre.json.kdf;
  const iters = pre.json.KdfIterations ?? pre.json.kdfIterations;
  const memory = pre.json.KdfMemory ?? pre.json.kdfMemory;
  const parallelism = pre.json.KdfParallelism ?? pre.json.kdfParallelism;
  say("prelogin Kdf type", `${kdfType} (0=PBKDF2-SHA256, 1=Argon2id)`);
  say("prelogin params", `iterations=${iters} memory=${memory} parallelism=${parallelism}`);
  say("prelogin salt field", pre.json.salt === null ? "null (server does not send a salt)" : typeof pre.json.salt);
  const kdf = kdfType === 1 ? { argon2id: { iterations: iters, memory, parallelism } } : { pBKDF2: { iterations: iters } };

  // --- 3. master key + auth hash ---------------------------------------
  masterPassword = await readHidden(masterPassword);
  const t0 = Date.now();
  const masterKey = P.derive_kdf_material(
    new TextEncoder().encode(masterPassword),
    new TextEncoder().encode(salt),
    kdf,
  );
  say("master key derivation", `${Date.now() - t0} ms, ${masterKey.length} bytes`);
  const authHash = Buffer.from(
    crypto.pbkdf2Sync(Buffer.from(masterKey), Buffer.from(new TextEncoder().encode(masterPassword)), 1, 32, "sha256"),
  ).toString("base64");

  // --- 4. token grant --------------------------------------------------
  const tokenForm = new URLSearchParams({
    grant_type: "password",
    username: email,
    password: authHash,
    scope: "api offline_access",
    client_id: "web",
    deviceType: "7",
    deviceIdentifier,
    deviceName: "wox-bitwarden-spike",
  }).toString();
  const tok = await req(`${identity}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: tokenForm,
  });
  say("POST /connect/token", `${tok.status} in ${tok.ms} ms`);
  if (tok.status !== 200) {
    if (tok.json?.TwoFactorProviders2) {
      say("2FA required", JSON.stringify(Object.keys(tok.json.TwoFactorProviders2)));
    } else {
      say("token error", `${JSON.stringify(tok.json).slice(0, 400)}`);
    }
    say("VERDICT", "BLOCKED: cannot proceed without completing the step above");
    process.exit(1);
  }
  const t = tok.json;
  say("token fields", Object.keys(t).join(","));
  say("has refresh_token", Boolean(t.refresh_token));
  say("expires_in", t.expires_in);
  // The three fields that decide the key-assembly branch:
  say("response Key present", Boolean(t.Key));
  say("response PrivateKey present", Boolean(t.PrivateKey));
  say("response AccountKeys", JSON.stringify(t.AccountKeys ?? null));
  say("UserDecryptionOptions", JSON.stringify(t.UserDecryptionOptions ?? null));
  say("Kdf echoed in token", `${t.Kdf}/${t.KdfIterations}`);

  // --- 5. assemble keys ------------------------------------------------
  let userKey = null;
  if (t.Key) {
    try {
      userKey = P.decrypt_user_key_with_master_password(t.Key, masterPassword, salt, kdf);
      say("user key from Key", `ok, ${userKey.length} bytes, Key prefix ${typeOf(t.Key)}`);
    } catch (e) {
      say("user key from Key", `FAILED ${e.message}`);
    }
  }
  const privCandidates = [];
  if (userKey) privCandidates.push(["userKey", userKey]);
  const stretched = new Uint8Array(64);
  const expand = (info) => {
    let prev = Buffer.alloc(0);
    const out = [];
    for (let i = 1; i <= Math.ceil(32 / 32); i++) {
      prev = crypto.createHmac("sha256", masterKey).update(Buffer.concat([prev, Buffer.from(info), Buffer.from([i])])).digest();
      out.push(prev);
    }
    return Buffer.concat(out).subarray(0, 32);
  };
  stretched.set(expand("enc"), 0);
  stretched.set(expand("mac"), 32);
  privCandidates.push(["stretched masterKey", stretched], ["raw masterKey", masterKey]);

  let privKeyBytes = null;
  for (const [name, k] of privCandidates) {
    if (!t.PrivateKey) break;
    try {
      const der = P.symmetric_decrypt_bytes(t.PrivateKey, k);
      say("PrivateKey decrypted with", `${name} (${der.length} bytes, prefix ${typeOf(t.PrivateKey)})`);
      privKeyBytes = der;
      break;
    } catch (e) {
      say(`PrivateKey attempt: ${name}`, `no (${e.variant || e.message})`);
    }
  }
  if (privKeyBytes) {
    try {
      const pub = P.rsa_extract_public_key(privKeyBytes);
      say("RSA key pair consistent", `public key ${pub.length} bytes`);
    } catch (e) {
      say("RSA key pair consistent", `FAILED ${e.message}`);
    }
  }

  // --- 6. sync: what format are the ciphers in? ------------------------
  const auth = { Authorization: `Bearer ${t.access_token}`, "Bitwarden-Client-Version": "2026.10.0", "Bitwarden-Client-Type": "browser" };
  const sync = await req(`${api}/sync`, { headers: auth });
  say("GET /sync", `${sync.status} in ${sync.ms} ms`);
  if (sync.status !== 200) {
    say("sync error", sync.text);
    process.exit(1);
  }
  const ciphers = sync.json.ciphers ?? sync.json.Ciphers ?? [];
  say("sync fields", Object.keys(sync.json).join(","));
  say("counts", `ciphers=${ciphers.length} folders=${(sync.json.folders ?? []).length} collections=${(sync.json.collections ?? []).length} organizations=${(sync.json.organizations ?? sync.json.profile?.organizations ?? []).length}`);
  if (ciphers.length) {
    say("cipher[0] fields", Object.keys(ciphers[0]).join(","));
    const histogram = (f) => {
      const m = {};
      for (const c of ciphers) {
        const v = f(c);
        m[v] = (m[v] || 0) + 1;
      }
      return JSON.stringify(m);
    };
    say("name prefix histogram", histogram((c) => typeOf(c.name) ?? "(none/other)"));
    say("key present", histogram((c) => (c.key ? typeOf(c.key) ?? "non-typed" : "none")));
    say("cipher type", histogram((c) => c.type));
    say("deleted", histogram((c) => c.deletedDate ? "deleted" : "active"));
    say("org ciphers", histogram((c) => (c.organizationId ? "org" : "personal")));
    say("reprompt", histogram((c) => c.reprompt ?? 0));
    const first = ciphers[0];
    say("data typeof", typeof first.data);
    say("data shape sample", JSON.stringify(first.data).slice(0, 220));
  }

  // --- 7. prove we can actually read one item --------------------------
  const dec = (blob) => {
    for (const [, k] of privCandidates) {
      try {
        return P.symmetric_decrypt_string(blob, k);
      } catch { /* try next key */ }
    }
    return null;
  };
  let ok = 0, fail = 0, itemKeyed = 0, blobbed = 0;
  for (const c of ciphers) {
    let keyForItem = privCandidates[0][1];
    if (c.key) {
      let unwrapped = null;
      for (const [, k] of privCandidates) {
        try {
          unwrapped = P.unwrap_symmetric_key(c.key, k);
          break;
        } catch { /* next */ }
      }
      if (!unwrapped) {
        fail++;
        continue;
      }
      itemKeyed++;
      keyForItem = unwrapped;
    }
    let name = null;
    try {
      name = P.symmetric_decrypt_string(c.name, keyForItem);
    } catch {
      name = dec(c.name);
    }
    if (name === null) {
      fail++;
      continue;
    }
    ok++;
    const d = typeof c.data === "string" ? (() => { try { return JSON.parse(c.data); } catch { return null; } })() : c.data;
    if (d === null || d === undefined) blobbed++;
  }
  say("cipher name decryption", `ok=${ok} fail=${fail} per-item-key=${itemKeyed} unparsable-data=${blobbed}`);

  // --- 8. TOTP feasibility with our own implementation ----------------
  function nodeTotp(keyBytes, { step = 30, digits = 6, algo = "sha1" } = {}, timeMs = Date.now()) {
    const counter = Math.floor(timeMs / 1000 / step);
    const msg = Buffer.alloc(8);
    msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
    msg.writeUInt32BE(counter >>> 0, 4);
    const h = crypto.createHmac(algo, keyBytes).update(msg).digest();
    const off = h[h.length - 1] & 0x0f;
    const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
    return String(bin % 10 ** digits).padStart(digits, "0");
  }
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const b32ok = (() => {
    try {
      const s = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
      let bits = 0, val = 0;
      const out = [];
      for (const ch of s) {
        val = (val << 5) | ALPHA.indexOf(ch);
        bits += 5;
        if (bits >= 8) out.push((val >>> (bits - 8)) & 0xff), (bits -= 8);
      }
      return nodeTotp(Buffer.from(out), {}, 59 * 1000) === "94287082";
    } catch {
      return false;
    }
  })();
  say("our TOTP matches RFC 6238 vector", b32ok);

  say("VERDICT", "see the fields above; nothing here wrote to your vault");
})().catch((e) => {
  console.error("spike failed:", e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e);
  process.exit(1);
});

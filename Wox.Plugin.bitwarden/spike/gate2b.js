// Gate 2b: read-only diagnosis against YOUR Vaultwarden server.
//
//   node spike/gate2b.js https://your-vaultwarden you@email.com
//
// Prompts for the master password with hidden input (or takes BW_TEST_PASSWORD).
// Output contains NO plaintext: only field names, EncString type prefixes, byte
// lengths, counts. No write endpoint is called (/alive, /config, prelogin,
// connect/token, GET /sync only).
const crypto = require("crypto");
const readHidden = require("./hidden-prompt");
const P = require("../node_modules/@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js").PureCrypto;

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const [baseUrlRaw, email] = args.filter((a) => !a.startsWith("--"));
if (require.main === module && (!baseUrlRaw || !email)) {
  console.error("usage: node gate2b.js <base-url> <email>   (it will prompt, hidden)");
  process.exit(2);
}
let masterPassword = process.env.BW_TEST_PASSWORD || null;
const insecure = flags.includes("--insecure");
if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const baseUrl = (baseUrlRaw || "").replace(/\/+$/, "");
const identity = `${baseUrl}/identity`;
const api = `${baseUrl}/api`;
const say = (k, v) => console.log(`${k}: ${v}`);
const typeOf = (s) => (typeof s === "string" && /^\d\./.test(s) ? s.slice(0, 2) : null);

async function req(url, { method = "GET", headers = {}, body } = {}) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method,
    headers: {
      "Bitwarden-Client-Version": "2026.10.0",
      "Bitwarden-Client-Type": "browser",
      "device-type": "7",
      ...headers,
    },
    body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* error page */ }
  return { status: res.status, ms: Date.now() - t0, json, text: text.slice(0, 300) };
}

// Collect the EncString prefix of every string leaf in an object.
function leafPrefixes(node, prefix = "", out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === "string") {
    const t = typeOf(node);
    if (t) out.push({ path: prefix, type: t, length: node.length });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => leafPrefixes(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) leafPrefixes(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

// base32 (RFC 4648) -> Buffer, for classifying and using TOTP secrets.
const B32ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32LooksValid(s) {
  return /^[A-Z2-7]{16,}=*$/i.test(s);
}
function base32ToBuf(s) {
  let bits = 0, val = 0;
  const out = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const idx = B32ALPHA.indexOf(ch);
    if (idx < 0) throw new Error("bad base32");
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) out.push((val >>> (bits - 8)) & 0xff), (bits -= 8);
  }
  return Buffer.from(out);
}
function rawOf(cipher, path) {
  let cur = cipher;
  for (const seg of path.replace(/\[(\d+)]/g, ".$1").split(".")) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[seg];
  }
  return cur;
}
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

async function main() {
  say("server", baseUrl);
  const cfg = await req(`${api}/config`);
  say("GET /api/config", `${cfg.status} version=${cfg.json?.version} featureStates=${Object.keys(cfg.json?.featureStates ?? {}).length}`);

  const pre = await req(`${identity}/accounts/prelogin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (pre.status !== 200) {
    say("prelogin", `${pre.status} ${pre.text}`);
    process.exit(1);
  }
  const kdfType = pre.json.kdf ?? pre.json.Kdf;
  const iters = pre.json.kdfIterations ?? pre.json.KdfIterations;
  say("account KDF", `${kdfType} (0=PBKDF2-SHA256,1=Argon2id) iterations=${iters}`);
  const kdf = kdfType === 1
    ? { argon2id: { iterations: iters, memory: pre.json.kdfMemory ?? pre.json.KdfMemory, parallelism: pre.json.kdfParallelism ?? pre.json.KdfParallelism } }
    : { pBKDF2: { iterations: iters } };

  masterPassword = await readHidden(masterPassword);
  const t0 = Date.now();
  const masterKey = P.derive_kdf_material(new TextEncoder().encode(masterPassword), new TextEncoder().encode(email.trim().toLowerCase()), kdf);
  say("master key", `${masterKey.length} B in ${Date.now() - t0} ms`);
  const authHash = Buffer.from(crypto.pbkdf2Sync(Buffer.from(masterKey), Buffer.from(masterPassword, "utf8"), 1, 32, "sha256")).toString("base64");

  const tok = await req(`${identity}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "password",
      username: email,
      password: authHash,
      scope: "api offline_access",
      client_id: "web",
      deviceType: "7",
      deviceIdentifier: crypto.randomUUID(),
      deviceName: "wox-bitwarden-spike",
    }).toString(),
  });
  say("POST /connect/token", `${tok.status} in ${tok.ms} ms`);
  if (tok.status !== 200) {
    say("token failure", tok.json?.TwoFactorProviders2 ? `2FA required: ${JSON.stringify(Object.keys(tok.json.TwoFactorProviders2))}` : JSON.stringify(tok.json).slice(0, 300));
    process.exit(1);
  }
  const t = tok.json;

  // --- key assembly -----------------------------------------------------
  const saltFromServer = t.UserDecryptionOptions?.MasterPasswordUnlock?.Salt ?? email;
  say("salt source", saltFromServer === email.trim().toLowerCase() ? "email (lowercased)" : "server sent a different salt");
  const userKey = P.decrypt_user_key_with_master_password(t.Key, masterPassword, saltFromServer, kdf);
  say("userKey", `${userKey.length} B (Key prefix ${typeOf(t.Key)})`);
  const privateKeyDer = P.symmetric_decrypt_bytes(t.PrivateKey, userKey);
  say("privateKey", `${privateKeyDer.length} B DER (prefix ${typeOf(t.PrivateKey)})`);
  const publicKeyDer = P.rsa_extract_public_key(privateKeyDer);
  say("RSA pair", `public ${publicKeyDer.length} B, matches AccountKeys.publicKey: ${
    Buffer.from(t.AccountKeys?.publicKeyEncryptionKeyPair?.publicKey ?? "", "base64").toString("hex") === Buffer.from(publicKeyDer).toString("hex")}`);

  const orgs = t.AccountKeys?.organizationKeys ?? null;
  say("token AccountKeys.organizationKeys", orgs ? JSON.stringify(Object.keys(orgs)) : "absent");

  // --- sync -------------------------------------------------------------
  const sync = await req(`${api}/sync`, { headers: { Authorization: `Bearer ${t.access_token}` } });
  say("GET /sync", `${sync.status} in ${sync.ms} ms`);
  if (sync.status !== 200) {
    say("sync failure", sync.text);
    process.exit(1);
  }
  const ciphers = sync.json.ciphers ?? [];
  const profileOrgs = sync.json.profile?.organizations ?? [];
  say("counts", `ciphers=${ciphers.length} folders=${(sync.json.folders ?? []).length} collections=${(sync.json.collections ?? []).length} orgs=${profileOrgs.length}`);

  // --- organization keys (your vault has org ciphers) -------------------
  const orgKeys = new Map();
  for (const o of profileOrgs) {
    const id = o.id ?? o.Id;
    const blob = o.key ?? o.Key;
    if (!blob) continue;
    try {
      const k = P.decapsulate_key_unsigned(blob, privateKeyDer);
      orgKeys.set(id, k);
      say(`orgKey ${id.slice(0, 8)}`, `decrypted ${k.length} B via prefix ${typeOf(blob)}`);
    } catch (e) {
      say(`orgKey ${id.slice(0, 8)}`, `FAILED via ${typeOf(blob)}: ${e.message ?? e.variant}`);
    }
  }

  // --- per-cipher decryption, the thing the plugin lives on --------------
  const stats = { ok: 0, fail: 0, itemKeyed: 0, blobData: 0, types: {}, leafTypes: {}, scopes: {}, states: {}, totpShapes: {}, fieldCount: [] };
  const failures = [];
  for (const c of ciphers) {
    const scope = c.organizationId ? "org" : "personal";
    let baseKey = scope === "org" ? orgKeys.get(c.organizationId) : userKey;
    stats.scopes[scope] = (stats.scopes[scope] || 0) + 1;
    stats.states[c.deletedDate ? "deleted" : "active"] = (stats.states[c.deletedDate ? "deleted" : "active"] || 0) + 1;
    stats.types[c.type] = (stats.types[c.type] || 0) + 1;
    if (typeof c.data === "string") stats.blobData++;
    if (!baseKey) {
      fail(c, `no key for scope ${scope}`);
      continue;
    }
    let key = baseKey;
    if (c.key) {
      try {
        key = P.unwrap_symmetric_key(c.key, baseKey);
        stats.itemKeyed++;
      } catch (e) {
        fail(c, `cipher.key unwrap failed (${typeOf(c.key)}): ${e.message ?? e.variant}`);
        continue;
      }
    }
    const leaves = leafPrefixes({ name: c.name, notes: c.notes, login: c.login, card: c.card, identity: c.identity, secureNote: c.secureNote, fields: c.fields, passwordHistory: c.passwordHistory });
    stats.fieldCount.push(leaves.length);
    let decryptFail = null;
    for (const l of leaves) {
      stats.leafTypes[l.type] = (stats.leafTypes[l.type] || 0) + 1;
      if (decryptFail) continue;
      try {
        P.symmetric_decrypt_string(rawOf(c, l.path), key);
      } catch (e) {
        decryptFail = `${l.path}: ${e.message ?? e.variant}`;
      }
    }
    if (decryptFail) fail(c, decryptFail);
    else stats.ok++;
    const totpRaw = c.login?.totp;
    if (totpRaw) {
      try {
        const secret = P.symmetric_decrypt_string(totpRaw, key);
        const shape = secret.startsWith("otpauth://") ? "otpauth-uri" : secret.startsWith("steam://") ? "steam" : base32LooksValid(secret) ? "base32" : "other";
        stats.totpShapes[shape] = (stats.totpShapes[shape] || 0) + 1;
        if (shape === "base32") {
          const code = nodeTotp(base32ToBuf(secret));
          stats.totpShapes["_generated"] = `${code.length} digits, no error`;
        }
      } catch (e) {
        stats.totpShapes["decrypt-failed"] = (stats.totpShapes["decrypt-failed"] || 0) + 1;
      }
    }
  }
  function fail(c, why) {
    stats.fail++;
    if (failures.length < 6) failures.push(`${c.type} ${c.deletedDate ? "(deleted)" : ""} ${c.organizationId ? "(org)" : ""} -> ${why}`);
  }

  say("cipher decryption", `ok=${stats.ok} fail=${stats.fail} per-item-key=${stats.itemKeyed} data-blob=${stats.blobData}`);
  say("cipher types", JSON.stringify(stats.types) + "  (1=login 2=note 3=card 4=identity)");
  say("scope/state", JSON.stringify(stats.scopes) + " " + JSON.stringify(stats.states));
  say("encrypted leaf prefix histogram", JSON.stringify(stats.leafTypes));
  say("leaves per cipher", `min=${Math.min(...stats.fieldCount)} max=${Math.max(...stats.fieldCount)} (0 means nothing was encrypted, >0 means field-level)`);
  say("totp", JSON.stringify(stats.totpShapes));
  if (failures.length) say("failure samples", failures.join(" ;; "));

  // --- refresh token reuse (what the plugin will rely on) ---------------
  const refreshed = await req(`${identity}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: "web",
      scope: "api offline_access",
      deviceType: "7",
      deviceIdentifier: "wox-spike-fixed-device",
      deviceName: "wox-bitwarden-spike",
    }).toString(),
  });
  say("grant_type=refresh_token", `${refreshed.status} in ${refreshed.ms} ms, new access_token=${Boolean(refreshed.json?.access_token)}, returns Key=${Boolean(refreshed.json?.Key)}, PrivateKey=${Boolean(refreshed.json?.PrivateKey)}`);

  say("VERDICT", "no plaintext above; nothing was written to your vault");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("spike failed:", e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e);
    process.exit(1);
  });
}

module.exports = { leafPrefixes, rawOf, base32ToBuf, base32LooksValid, nodeTotp };

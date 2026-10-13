// Gate 1 spike: verify the official wasm SDK works in plain Node 24 CJS, and
// byte-for-byte agrees with a hand-written Node-crypto implementation of the
// Bitwarden key hierarchy. Nothing here touches a server.
const crypto = require("crypto");
const { performance } = require("perf_hooks");

const t0 = performance.now();
const sdk = require("@bitwarden/sdk-internal");
const t1 = performance.now();
const { PureCrypto: P } = sdk;

const b64 = (b) => Buffer.from(b).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const hex = (b) => Buffer.from(b).toString("hex");
const eq = (a, b) => hex(a) === hex(b);
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  :: " + detail : ""}`);
}

// --- 1. Load cost -----------------------------------------------------------
check("require()+wasm instantiate", t1 - t0 < 2000, `took ${(t1 - t0).toFixed(1)} ms`);

// --- 2. PBKDF2 master key: SDK vs Node built-in ----------------------------
const email = "Gate1.Test@Example.com";
const salt = email.trim().toLowerCase();
const pw = process.env.VAULT_MASTER_PASSWORD;
if (!pw) throw new Error("VAULT_MASTER_PASSWORD is required; the spike never stores a password on disk");
const pwBytes = new TextEncoder().encode(pw);
const saltBytes = new TextEncoder().encode(salt);
const ITERS = 600000;

const kdfStart = performance.now();
const sdkMaster = P.derive_kdf_material(pwBytes, saltBytes, { pBKDF2: { iterations: ITERS } });
const sdkMs = performance.now() - kdfStart;

const nodeStart = performance.now();
const nodeMaster = new Uint8Array(
  crypto.pbkdf2Sync(Buffer.from(pwBytes), Buffer.from(saltBytes), ITERS, 32, "sha256"),
);
const nodeMs = performance.now() - nodeStart;

check("masterKey len", sdkMaster.length === 32 && nodeMaster.length === 32, `${sdkMaster.length} B`);
check("PBKDF2 600k: SDK == Node", eq(sdkMaster, nodeMaster),
  `sdk ${sdkMs.toFixed(0)} ms / node ${nodeMs.toFixed(0)} ms`);

// --- 3. Auth hash the server receives: pbkdf2(masterKey, password, 1) ------
const authHash = b64(crypto.pbkdf2Sync(Buffer.from(sdkMaster), Buffer.from(pwBytes), 1, 32, "sha256"));
check("auth hash is 32 B b64", unb64(authHash).length === 32, authHash.slice(0, 12) + "...");

// --- 4. Argon2id: SDK vs @noble/hashes ------------------------------------
// Bitwarden's client KDF config stores `memory`; whether it means KiB or MiB on
// the wire vs. what rust argon2 wants is exactly what this probe answers.
// Defaults for a Bitwarden account are t=2, m=64, p=1.
const nobleArgon = require("@noble/hashes/argon2.js");
const ARG_T = 2, ARG_M = 64, ARG_P = 1;
const argonCfg = { argon2id: { iterations: ARG_T, memory: ARG_M, parallelism: ARG_P } };
try {
  const s = P.derive_kdf_material(pwBytes, saltBytes, argonCfg);
  const sAlt = P.derive_kdf_material(pwBytes, saltBytes, {
    argon2id: { iterations: ARG_T, memory: ARG_M + 64, parallelism: ARG_P },
  });
  console.log(`INFO  SDK argon2 honors memory param: ${!eq(s, sAlt)}`);
  const pwVariants = {
    "raw utf8 password": pwBytes,
    "sha256(password)": new Uint8Array(crypto.createHash("sha256").update(Buffer.from(pwBytes)).digest()),
  };
  let argonHit = null;
  outer: for (const [pwName, pwIn] of Object.entries(pwVariants)) {
    for (const mKiB of [ARG_M, ARG_M * 1024]) {
      const n = nobleArgon.argon2id(pwIn, saltBytes, { t: ARG_T, p: ARG_P, m: mKiB, dkLen: 32 });
      const match = eq(s, n);
      console.log(`INFO  argon2 probe pw=${pwName} m=${mKiB} KiB -> ${match ? "MATCH" : "no match"}`);
      if (match) {
        argonHit = `${pwName}, m=${mKiB} KiB`;
        break outer;
      }
    }
  }
  check("Argon2id reproducible with noble (route A feasibility)", argonHit !== null,
    argonHit || "no parameter mapping matched; SDK digest " + hex(s).slice(0, 24) + "...");
} catch (e) {
  check("Argon2id reproducible with noble (route A feasibility)", false, e.message);
}

// --- 5. stretchKey (HKDF-Expand with info "enc"/"mac"), ported by hand ----
// Mirror of libs/legacy-crypto node-crypto-function.service.ts hkdfExpand:
// the master key is used directly as the PRK, no extract step.
function hkdfExpand(prk, info, len) {
  const hashLen = 32;
  const infoBuf = new TextEncoder().encode(info);
  const n = Math.ceil(len / hashLen);
  const out = new Uint8Array(n * hashLen);
  let prev = new Uint8Array(0);
  let off = 0;
  for (let i = 0; i < n; i++) {
    const t = new Uint8Array(prev.length + infoBuf.length + 1);
    t.set(prev);
    t.set(infoBuf, prev.length);
    t.set([i + 1], t.length - 1);
    prev = new Uint8Array(crypto.createHmac("sha256", prk).update(t).digest());
    out.set(prev, off);
    off += prev.length;
  }
  return out.slice(0, len);
}
const stretched = new Uint8Array(64);
stretched.set(hkdfExpand(sdkMaster, "enc", 32), 0);
stretched.set(hkdfExpand(sdkMaster, "mac", 32), 32);

// --- 6. User key wrap/unwrap round trip through the official path ---------
const userKey = P.make_user_key_aes256_cbc_hmac();
check("user key len", userKey.length === 64, `${userKey.length} B`);
const wrapped = P.encrypt_user_key_with_master_password(userKey, pw, salt, argonCfg);
const unwrapped = P.decrypt_user_key_with_master_password(wrapped, pw, salt, argonCfg);
check("wrap/unwrap user key round trip", eq(userKey, unwrapped), `blob prefix "${String(wrapped).slice(0, 2)}"`);

// The wrapped blob is an AES-CBC-HMAC EncString. Which 64-byte key the Rust side
// derives from the master key is what route A would have to reproduce, so probe
// the plausible candidates instead of asserting one. symmetric_decrypt verifies
// the HMAC internally and throws on a wrong key, so a hit is a real hit.
const candidates = {
  "hkdfExpand('enc'/'mac') [TS stretchKey port]": stretched,
  "pbkdf2(password, master, 2, 64)": new Uint8Array(
    crypto.pbkdf2Sync(Buffer.from(pwBytes), Buffer.from(sdkMaster), 2, 64, "sha256"),
  ),
  "pbkdf2(master, password, 2, 64)": new Uint8Array(
    crypto.pbkdf2Sync(Buffer.from(sdkMaster), Buffer.from(pwBytes), 2, 64, "sha256"),
  ),
  "hkdfSync ikm=master salt='' info='enc'+'mac'": (() => {
    const enc = new Uint8Array(crypto.hkdfSync("sha256", Buffer.from(sdkMaster), Buffer.alloc(0), Buffer.from("enc"), 32));
    const mac = new Uint8Array(crypto.hkdfSync("sha256", Buffer.from(sdkMaster), Buffer.alloc(0), Buffer.from("mac"), 32));
    return new Uint8Array(Buffer.concat([Buffer.from(enc), Buffer.from(mac)]));
  })(),
  "hkdfSync ikm=master salt='enc'/'mac' info=''": (() => {
    const enc = new Uint8Array(crypto.hkdfSync("sha256", Buffer.from(sdkMaster), Buffer.from("enc"), Buffer.alloc(0), 32));
    const mac = new Uint8Array(crypto.hkdfSync("sha256", Buffer.from(sdkMaster), Buffer.from("mac"), Buffer.alloc(0), 32));
    return new Uint8Array(Buffer.concat([Buffer.from(enc), Buffer.from(mac)]));
  })(),
};
let hit = null;
for (const [name, k] of Object.entries(candidates)) {
  try {
    if (eq(P.symmetric_decrypt_bytes(wrapped, k), userKey)) {
      hit = name;
      break;
    }
  } catch {
    /* wrong key: HMAC check fails inside the SDK */
  }
  console.log(`INFO  key candidate ruled out: ${name}`);
}
if (hit) console.log(`INFO  key candidate that works: ${hit}`);
check("hand-derived key can unwrap user key (route A feasibility)", hit !== null, hit || "no candidate matched");

// --- 7. EncString format: SDK encrypt vs hand decrypt -------------------
const plain = "https://example.com/login?q=1 · 中文名称";
for (const [label, key] of [["64 B (type 2)", userKey], ["32 B (type 0)", sdkMaster]]) {
  let enc;
  try {
    enc = P.symmetric_encrypt_string(plain, key);
  } catch (e) {
    check(`EncString type for ${label}`, false, `SDK refused: ${e.variant || e.message}`);
    continue;
  }
  const parts = String(enc).split(".");
  const pieces = parts[1].split("|");
  let hand = null;
  try {
    if (pieces.length === 3) {
      const iv = unb64(pieces[0]);
      const ct = unb64(pieces[1]);
      const mac = unb64(pieces[2]);
      const expectMac = new Uint8Array(
        crypto.createHmac("sha256", key.slice(32)).update(Buffer.concat([Buffer.from(iv), Buffer.from(ct)])).digest(),
      );
      const d = crypto.createDecipheriv("aes-256-cbc", key.slice(0, 32), iv);
      hand = Buffer.concat([d.update(Buffer.from(ct)), d.final()]).toString("utf8");
      if (!eq(mac, expectMac)) hand = "MAC-MISMATCH";
    } else if (pieces.length === 2) {
      const iv = unb64(pieces[0]);
      const ct = unb64(pieces[1]);
      const d = crypto.createDecipheriv("aes-256-cbc", key.slice(0, 32), iv);
      hand = Buffer.concat([d.update(Buffer.from(ct)), d.final()]).toString("utf8");
    }
  } catch (e) {
    hand = "ERR " + e.message;
  }
  check(`EncString type for ${label}`, String(enc).startsWith(pieces.length === 3 ? "2." : "0."),
    `pieces=${pieces.length}`);
  check(`hand decrypt ${label}`, hand === plain, hand === plain ? "identical" : String(hand).slice(0, 40));
}

// Reverse direction: a ciphertext produced by the hand-written encryptor must be
// readable by the SDK. That proves the format layer is understood in both
// directions, which is the precondition for ever writing back to the vault.
function handEncrypt(text, key) {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv("aes-256-cbc", key.slice(0, 32), iv);
  const ct = Buffer.concat([c.update(Buffer.from(text, "utf8")), c.final()]);
  const mac = crypto.createHmac("sha256", key.slice(32)).update(Buffer.concat([iv, ct])).digest();
  return `2.${Buffer.from(iv).toString("base64")}|${ct.toString("base64")}|${mac.toString("base64")}`;
}
const handCipher = handEncrypt(plain, userKey);
try {
  check("SDK decrypts hand-encrypted payload", P.symmetric_decrypt_string(handCipher, userKey) === plain);
} catch (e) {
  check("SDK decrypts hand-encrypted payload", false, e.message);
}

// --- 8. Wrong password must not silently succeed ------------------------
let rejected = false;
try {
  P.decrypt_user_key_with_master_password(wrapped, pw + "x", salt, argonCfg);
} catch {
  rejected = true;
}
check("wrong master password rejected", rejected);

// --- 9. RSA-OAEP-SHA1 (org keys / private key unwrap) ------------------
let rsaOk = false;
try {
  const priv = P.rsa_generate_keypair();
  const pub = P.rsa_extract_public_key(priv);
  const secretBytes = P.make_user_key_aes256_cbc_hmac(); // raw 64 B Uint8Array
  const enc = P.encapsulate_key_unsigned(secretBytes, pub);
  const dec = P.decapsulate_key_unsigned(enc, priv);
  rsaOk = eq(secretBytes, dec);
  check("RSA-OAEP-SHA1 encapsulate/decapsulate", rsaOk, `blob prefix "${String(enc).slice(0, 2)}"`);
} catch (e) {
  check("RSA-OAEP-SHA1 encapsulate/decapsulate", false, `${e.name}: ${e.message}`);
}

// --- 10. Node built-in RSA-OAEP-SHA1 interop (can A drop the SDK here?) --
let nodeRsaOk = false;
try {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const data = crypto.randomBytes(32);
  const ct = crypto.publicEncrypt(
    { key: publicKey, format: "der", type: "spki",
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    data,
  );
  const pt = crypto.privateDecrypt(
    { key: privateKey, format: "der", type: "pkcs8",
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    ct,
  );
  nodeRsaOk = eq(pt, data);
  check("Node built-in RSA-OAEP-SHA1 works standalone", nodeRsaOk);
} catch (e) {
  check("Node built-in RSA-OAEP-SHA1 works standalone", false, `${e.name}: ${e.message}`);
}

// --- 10b. Can the SDK's RSA be fed a Node-generated key, and vice versa? --
try {
  const sdkPriv = P.rsa_generate_keypair();
  const sdkPub = P.rsa_extract_public_key(sdkPriv);
  const data = crypto.randomBytes(32);
  const ctFromNode = crypto.publicEncrypt(
    { key: Buffer.from(sdkPub), format: "der", type: "spki",
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    data,
  );
  const ptFromSdk = P.rsa_decrypt_data(new Uint8Array(ctFromNode), sdkPriv);
  check("cross-engine RSA (Node encrypt -> SDK decrypt)", eq(ptFromSdk, data));
} catch (e) {
  check("cross-engine RSA (Node encrypt -> SDK decrypt)", false, `${e.name}: ${e.message}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
  process.exitCode = 1;
}

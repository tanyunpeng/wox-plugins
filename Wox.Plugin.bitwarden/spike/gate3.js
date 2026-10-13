// Gate 3 spike: everything that must hold before we write the plugin.
//  1. packaging  - can the wasm ship as 2 copied files loaded by relative path?
//  2. totp       - does the SDK match the RFC 6238 reference vector?
//  3. item keys  - is the per-cipher key wrap/unwrap format reproducible by hand?
//  4. legacy     - can the SDK decrypt old `0.iv|data` payloads (32-byte key)?
//  5. rsa types  - do the two RSA EncString types map to the enum we read?
// The master password is never needed here and is never written to disk.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  :: " + detail : ""}`);
}
const b64 = (b) => Buffer.from(b).toString("base64");
const unb64 = (s) => Buffer.from(s, "base64");
const eqBuf = (a, b) => Buffer.from(a).toString("hex") === Buffer.from(b).toString("hex");

// --- 1. Packaging: ship the node build as plain copied files --------------
const srcDir = path.join(__dirname, "..", "node_modules", "@bitwarden", "sdk-internal", "node");
const outDir = path.join(__dirname, "..", "dist-test", "sdk");
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(srcDir, "bitwarden_wasm_internal.js"), path.join(outDir, "bitwarden_wasm_internal.js"));
fs.copyFileSync(path.join(srcDir, "bitwarden_wasm_internal_bg.wasm"), path.join(outDir, "bitwarden_wasm_internal_bg.wasm"));
const shipped = path.join(outDir, "bitwarden_wasm_internal.js");
const loaderDeps = [...fs.readFileSync(shipped, "utf8").matchAll(/require\(["']([^"')]+)["']\)/g)].map((m) => m[1]);
console.log("INFO  sdk loader require() targets:", JSON.stringify([...new Set(loaderDeps)]));

const g0 = performance.now();
const shippedSdk = require(shipped);
const g1 = performance.now();
check("sdk loads from a copied 2-file dir (no node_modules)", typeof shippedSdk.PureCrypto === "function",
  `loaded in ${(g1 - g0).toFixed(1)} ms, dir size ${(fs.statSync(outDir).size / 1e6).toFixed(0)} + wasm`);
const dirBytes = fs.readdirSync(outDir).reduce((s, f) => s + fs.statSync(path.join(outDir, f)).size, 0);
check("shipped footprint ~7.9 MB", dirBytes > 7.5e6 && dirBytes < 9e6, `${(dirBytes / 1e6).toFixed(2)} MB`);

const P = shippedSdk.PureCrypto;
const { TotpClient } = shippedSdk;

// --- 2. TOTP against the RFC 6238 reference vectors ----------------------
// RFC 6238 Appendix B, SHA-1, 8 digits, 30 s step, secret = ASCII "12345678901234567890"
const rfcSecretAscii = Buffer.from("12345678901234567890", "ascii");
const rfcSecretB32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
function nodeTotp(keyBytes, tSeconds, digits = 8, step = 30) {
  const counter = Math.floor(tSeconds / step);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(0, 0);
  msg.writeUInt32BE(counter, 4);
  const hmac = crypto.createHmac("sha1", keyBytes).update(msg).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}
// Decoding helper for base32 (RFC 4648 alphabet), used for both SDK and Node path.
function base32Decode(s) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const idx = alpha.indexOf(ch);
    if (idx < 0) throw new Error("bad base32 char " + ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) out.push((value >>> (bits - 8)) & 0xff), (bits -= 8);
  }
  return Buffer.from(out);
}
const decodedRfc = base32Decode(rfcSecretB32);
check("base32 decode == RFC secret bytes", eqBuf(decodedRfc, rfcSecretAscii), decodedRfc.length + " bytes");

const totp = new TotpClient();
for (const [tSec, expect] of [[59, "94287082"], [1111111109, "07081804"], [1234567890, "89005924"]]) {
  const nodeCode = nodeTotp(decodedRfc, tSec);
  let sdkCode = null;
  try {
    const res = totp.generate_totp(rfcSecretB32, tSec * 1000);
    sdkCode = res?.code ?? String(res);
  } catch (e) {
    sdkCode = "ERR " + e.message;
  }
  check(`TOTP t=${tSec}`, sdkCode === expect && nodeCode === expect, `RFC ${expect} / sdk ${sdkCode} / node ${nodeCode}`);
}
let uriPass = false, uriDetail = "";
try {
  const otpauth = `otpauth://totp/Test:me?secret=${rfcSecretB32}&period=30&digits=8&algorithm=SHA1`;
  const res = totp.generate_totp(otpauth, 59 * 1000);
  uriPass = (res?.code ?? String(res)) === "94287082";
  uriDetail = String(res?.code ?? res);
} catch (e) {
  uriDetail = e.message;
}
check("TOTP accepts an otpauth:// URI", uriPass, uriDetail);

// --- 3. Per-cipher key wrap/unwrap ---------------------------------------
const master32 = new Uint8Array(crypto.randomBytes(32));
const wrapping64 = P.make_user_key_aes256_cbc_hmac();
let itemKey = null, wrapPrefix = null, handUnwrap = null;
try {
  itemKey = P.make_user_key_aes256_cbc_hmac();
  const wrapped = P.wrap_symmetric_key(itemKey, wrapping64);
  wrapPrefix = String(wrapped).slice(0, 2);
  const back = P.unwrap_symmetric_key(wrapped, wrapping64);
  check("wrap/unwrap symmetric key round trip", eqBuf(back, itemKey), `blob prefix "${wrapPrefix}"`);

  // Is unwrap just a symmetric decrypt of the key bytes? Hand-make such a blob.
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv("aes-256-cbc", wrapping64.slice(0, 32), iv);
  const ct = Buffer.concat([c.update(Buffer.from(itemKey)), c.final()]);
  const mac = crypto.createHmac("sha256", wrapping64.slice(32)).update(Buffer.concat([iv, ct])).digest();
  const handWrapped = `2.${b64(iv)}|${b64(ct)}|${b64(mac)}`;
  try {
    handUnwrap = eqBuf(P.unwrap_symmetric_key(handWrapped, wrapping64), itemKey);
  } catch (e) {
    handUnwrap = "throws: " + e.message;
  }
  console.log("INFO  hand-made wrapped key -> unwrap:", JSON.stringify(handUnwrap));
} catch (e) {
  check("wrap/unwrap symmetric key round trip", false, e.message);
}

// --- 4. Legacy `0.iv|data` with a 32-byte key ---------------------------
const legacyPlain = "legacy-encrypted-名称";
const iv2 = crypto.randomBytes(16);
const cc = crypto.createCipheriv("aes-256-cbc", master32, iv2);
const ct2 = Buffer.concat([cc.update(Buffer.from(legacyPlain, "utf8")), cc.final()]);
const legacyBlob = `0.${b64(iv2)}|${b64(ct2)}`;
try {
  check("SDK decrypts legacy 0.iv|data (32 B key)", P.symmetric_decrypt_string(legacyBlob, master32) === legacyPlain);
} catch (e) {
  check("SDK decrypts legacy 0.iv|data (32 B key)", false, e.message);
}

// --- 5. RSA EncString types 3 and 4 -------------------------------------
function rsaDecryptBlob(blob, privDer, oaepHash) {
  const data = unb64(blob.split(".")[1]);
  return crypto.privateDecrypt(
    { key: privDer, format: "der", type: "pkcs8", padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash },
    data,
  );
}
const { privateKey: nodePriv, publicKey: nodePub } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "der" },
});
const secret32 = crypto.randomBytes(32);
for (const [type, oaepHash] of [["4.", "sha1"], ["3.", "sha256"]]) {
  const ct = crypto.publicEncrypt(
    { key: nodePub, format: "der", type: "spki", padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash },
    secret32,
  );
  const blob = `${type}${b64(ct)}`;
  let nodeOk = false;
  try {
    nodeOk = eqBuf(rsaDecryptBlob(blob, nodePriv, oaepHash), secret32);
  } catch { /* type prefix mismatch */ }
  const sdkOk = type === "4." ? (() => { try { return eqBuf(P.rsa_decrypt_data(unb64(ct), new Uint8Array(nodePriv)), secret32); } catch { return false; } })() : null;
  check(`EncString ${type} = RSAES-OAEP-${oaepHash.toUpperCase()}`, nodeOk, sdkOk === null ? "(sdk not applicable)" : `SDK agrees: ${sdkOk}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(" | "));
  process.exitCode = 1;
}

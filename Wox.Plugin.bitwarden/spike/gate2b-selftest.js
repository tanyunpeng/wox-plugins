// Offline self-test for gate2b's helpers, using a synthetic vaultwarden-shaped
// /sync response. No server, no credentials: keys are random, and a "password"
// here is a random byte string, never a real secret.
const assert = require("assert");
const crypto = require("crypto");
const P = require("../node_modules/@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js").PureCrypto;
const { leafPrefixes, rawOf, base32ToBuf, base32LooksValid, nodeTotp } = require("./gate2b");

let pass = 0, total = 0;
const ok = (name, fn) => {
  total++;
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}  :: ${e.message}`);
    process.exitCode = 1;
  }
};

const userKey = P.make_user_key_aes256_cbc_hmac();
const itemKey = P.make_user_key_aes256_cbc_hmac();
const orgKey = P.make_user_key_aes256_cbc_hmac();
const privDer = P.rsa_generate_keypair();
const pubDer = P.rsa_extract_public_key(privDer);
const enc = (s, k) => P.symmetric_encrypt_string(s, k);

// Vaultwarden 2026.6 /sync cipher shape: typed sub-objects, each leaf encrypted,
// `passwordHistory` is a TOP-LEVEL field, and there is NO `data` field at all.
const cipher = {
  object: "cipher",
  id: crypto.randomUUID(),
  type: 1,
  organizationId: null,
  key: P.wrap_symmetric_key(itemKey, userKey),
  name: enc("GitHub 测试条目", itemKey),
  notes: enc("备注内容", itemKey),
  folderId: null,
  favorite: true,
  reprompt: 0,
  edit: true,
  viewPassword: true,
  login: {
    username: enc("demo@example.com", itemKey),
    password: enc(crypto.randomBytes(18).toString("base64"), itemKey),
    totp: enc("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", itemKey),
    uris: [{ uri: enc("github.com/login", itemKey), matchType: null }],
  },
  passwordHistory: [{ password: enc("old-secret", itemKey), lastUsedDate: "2026-01-01T00:00:00.000Z" }],
  fields: [{ name: enc("PIN", itemKey), value: enc("1234", itemKey), type: 0 }],
};

ok("cipher has no `data` field (blob detector would report 0)", () => {
  assert.strictEqual(cipher.data, undefined);
});

ok("leafPrefixes finds every encrypted leaf as type 2.", () => {
  const leaves = leafPrefixes({
    name: cipher.name,
    notes: cipher.notes,
    login: cipher.login,
    fields: cipher.fields,
    passwordHistory: cipher.passwordHistory,
  });
  const paths = leaves.map((l) => l.path).sort();
  assert.deepStrictEqual(paths, [
    "fields[0].name",
    "fields[0].value",
    "name",
    "notes",
    "login.password",
    "login.totp",
    "login.uris[0].uri",
    "login.username",
    "passwordHistory[0].password",
  ].sort());
  assert.ok(leaves.every((l) => l.type === "2."));
});

ok("rawOf walks array indices and plain keys", () => {
  assert.strictEqual(rawOf(cipher, "login.uris[0].uri"), cipher.login.uris[0].uri);
  assert.strictEqual(rawOf(cipher, "fields[0].value"), cipher.fields[0].value);
  assert.strictEqual(rawOf(cipher, "login.absent.x"), undefined);
});

ok("unwrap + decrypt every leaf with the per-item key", () => {
  const unwrapped = P.unwrap_symmetric_key(cipher.key, userKey);
  assert.strictEqual(unwrapped.length, 64);
  for (const l of leafPrefixes({ name: cipher.name, login: cipher.login })) {
    const plain = P.symmetric_decrypt_string(rawOf(cipher, l.path), unwrapped);
    assert.ok(typeof plain === "string" && plain.length > 0, l.path);
  }
  assert.strictEqual(P.symmetric_decrypt_string(cipher.name, unwrapped), "GitHub 测试条目");
});

ok("wrong key is rejected rather than returning garbage", () => {
  assert.throws(() => P.symmetric_decrypt_string(cipher.name, orgKey));
});

ok("org key decapsulates from the RSA-wrapped blob", () => {
  const blob = P.encapsulate_key_unsigned(orgKey, pubDer);
  assert.strictEqual(blob.slice(0, 2), "4.");
  const back = P.decapsulate_key_unsigned(blob, privDer);
  assert.strictEqual(Buffer.from(back).toString("hex"), Buffer.from(orgKey).toString("hex"));
});

ok("base32 classifier + TOTP on the RFC 6238 vector", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.ok(base32LooksValid(secret));
  assert.ok(!base32LooksValid("otpauth://totp/x?secret=ABC"));
  assert.strictEqual(nodeTotp(base32ToBuf(secret), { digits: 8 }, 59 * 1000), "94287082");
  assert.strictEqual(nodeTotp(base32ToBuf(secret), {}, 59 * 1000).length, 6);
});

console.log(`\n${pass}/${total} self-tests passed`);

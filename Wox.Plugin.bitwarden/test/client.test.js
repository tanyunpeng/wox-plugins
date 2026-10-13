const test = require("node:test");
const assert = require("node:assert");
const { VaultwardenClient } = require("../src/client");
const { makeTransport, vault, EMAIL, MASTER_PASSWORD, ORG_ID, P, userKey } = require("./fixtures");

async function loginClient(state = {}) {
  const client = new VaultwardenClient(makeTransport(state));
  const info = await client.login({ serverUrl: "https://vw.example", email: EMAIL, masterPassword: MASTER_PASSWORD, deviceIdentifier: "dev-1" });
  return { client, info };
}

test("login assembles userKey and private key; organisation keys arrive with the sync", async () => {
  const { client, info } = await loginClient();
  assert.strictEqual(client.unlocked, true);
  assert.strictEqual(userKey.length, 64);
  assert.deepStrictEqual({ kdfType: info.kdfType, iterations: info.iterations }, { kdfType: 0, iterations: 100000 });
  assert.strictEqual(info.hasRefreshToken, true);
  assert.strictEqual(client.orgKeys.size, 0, "the login response carries no organisation keys");
  const items = await client.sync({ force: true });
  assert.strictEqual(client.orgKeys.size, 1, "profile.organizations[].key must be RSA-decapsulated");
  assert.strictEqual(client.diagnostics.orgKeySource, "sync");
  const org = items.find((i) => i.organizationId === ORG_ID);
  assert.strictEqual(client.decryptField(org, "password"), vault.orgPassword);
});

test("an account whose organisation key is unavailable keeps the personal vault", async () => {
  const { client } = await loginClient({ noOrgKeys: true });
  assert.strictEqual(client.unlocked, true, "organisation keys are optional; login must not fail");
  const items = await client.sync({ force: true });
  assert.strictEqual(client.orgKeys.size, 0);
  assert.strictEqual(client.diagnostics.orgKeySource, "none");
  assert.ok(items.some((i) => !i.organizationId), "personal items still load");
  assert.ok(!items.some((i) => i.organizationId === ORG_ID), "the org item is skipped, not guessed");
  assert.ok(client.diagnostics.skipped >= 1);
});

test("wrong master password is reported as such", async () => {
  const client = new VaultwardenClient(makeTransport({ expectedAuthHash: "definitely-not-the-hash" }));
  await assert.rejects(
    () => client.login({ serverUrl: "https://vw.example", email: EMAIL, masterPassword: MASTER_PASSWORD, deviceIdentifier: "d" }),
    /MASTER_PASSWORD_WRONG/,
  );
});

test("rate limited login is distinguishable from a wrong password", async () => {
  const client = new VaultwardenClient(makeTransport({ tokenStatus: 429 }));
  await assert.rejects(
    () => client.login({ serverUrl: "https://vw.example", email: EMAIL, masterPassword: MASTER_PASSWORD, deviceIdentifier: "d" }),
    /RATE_LIMITED/,
  );
});

test("two-step login is surfaced, not silently failing", async () => {
  const client = new VaultwardenClient(makeTransport({ require2fa: true }));
  await assert.rejects(
    () => client.login({ serverUrl: "https://vw.example", email: EMAIL, masterPassword: MASTER_PASSWORD, deviceIdentifier: "d" }),
    /2FA_REQUIRED/,
  );
});

test("an Argon2id account is refused instead of mis-derived", async () => {
  const client = new VaultwardenClient(makeTransport({ argonAccount: true }));
  await assert.rejects(
    () => client.login({ serverUrl: "https://vw.example", email: EMAIL, masterPassword: MASTER_PASSWORD, deviceIdentifier: "d" }),
    /ARGON2_UNSUPPORTED/,
  );
});

test("a legacy account without UserKey is rejected with a clear error", async () => {
  const client = new VaultwardenClient(makeTransport({ dropKey: true }));
  await assert.rejects(
    () => client.login({ serverUrl: "https://vw.example", email: EMAIL, masterPassword: MASTER_PASSWORD, deviceIdentifier: "d" }),
    /LEGACY_KEY_FORMAT/,
  );
});

test("sync keeps login items only: no recycle bin, no secure notes, no cards", async () => {
  const { client } = await loginClient();
  const items = await client.sync({ force: true });
  assert.strictEqual(items.length, 5, "9 ciphers minus 2 deleted minus 2 non-login types");
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.deepStrictEqual(
    Object.keys(byName).sort(),
    ["演示 GitHub", "同号条目", "空白登录条目", "组织共享条目", "逐条目密钥条目"].sort(),
  );
  assert.strictEqual(byName["演示 GitHub"].username, "demo@example.com");
  assert.strictEqual(byName["演示 GitHub"].favorite, true);
  assert.strictEqual(byName["演示 GitHub"].folderName, "示例文件夹");
  assert.strictEqual(byName["演示 GitHub"].uriHosts.join(","), "github.com,api.github.com");
  assert.strictEqual(byName["逐条目密钥条目"].username, "item-user");
  assert.strictEqual(byName["组织共享条目"].username, "org-user");
  const d = client.diagnostics;
  assert.strictEqual(d.ciphers, 9);
  assert.strictEqual(d.skipped, 2, "both recycle-bin items count as deleted, whichever type they are");
  assert.strictEqual(d.nonLogin, 2, "secure notes and cards are counted, not decrypted");
  assert.strictEqual(items.length + d.skipped + d.nonLogin, d.ciphers, "the buckets must be mutually exclusive");
});

test("an item whose username equals its password is still ciphertext in the cache", async () => {
  const { client } = await loginClient();
  const items = await client.sync({ force: true });
  const reused = items.find((i) => i.name === "同号条目");
  assert.strictEqual(reused.username, vault.reused, "the username is searchable in plaintext by design");
  assert.strictEqual(client.decryptField(reused, "password"), reused.username);
  assert.match(reused.secrets.password, /^\d\./, "the password stays encrypted even when it equals the username");
});

test("plaintext secrets are not resident in the cached item list", async () => {
  const { client } = await loginClient();
  const items = await client.sync({ force: true });
  const personal = items.find((i) => i.username === "demo@example.com");
  assert.match(personal.secrets.password, /^2\./, "the stored password field must still be ciphertext");
  // The invariant stated positively: nothing in `secrets` is ever plaintext.
  for (const item of items) {
    for (const blob of [item.secrets.password, item.secrets.totp, item.secrets.note, ...item.secrets.fields.map((f) => f.value)]) {
      if (blob) assert.match(String(blob), /^\d\./, `${item.id} caches a secret without an EncString prefix`);
    }
  }
  const dumped = JSON.stringify(items);
  assert.ok(!dumped.includes(vault.personalPassword), "no plaintext password may sit in the cache");
  assert.ok(!dumped.includes(vault.noteText), "no plaintext note may sit in the cache");
  assert.ok(!dumped.includes(MASTER_PASSWORD));
});

test("decryptField yields the expected plaintext per field", async () => {
  const { client } = await loginClient();
  const items = await client.sync({ force: true });
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.strictEqual(client.decryptField(byName["演示 GitHub"], "password"), vault.personalPassword);
  assert.strictEqual(client.decryptField(byName["逐条目密钥条目"], "password"), vault.itemPassword);
  assert.strictEqual(client.decryptField(byName["组织共享条目"], "password"), vault.orgPassword);
  assert.strictEqual(client.decryptField(byName["演示 GitHub"], "note"), vault.noteText, "a login item's own note");
  assert.strictEqual(client.hasField(byName["空白登录条目"], "password"), false);
  assert.strictEqual(client.hasField(byName["空白登录条目"], "note"), false);
});

test("TOTP is generated from the stored encrypted secret", async () => {
  const { client } = await loginClient();
  const items = await client.sync({ force: true });
  const withTotp = items.find((i) => client.hasField(i, "totp"));
  const res = client.totpCode(withTotp, 59 * 1000);
  assert.strictEqual(res.code, "94287082".slice(-6));
  assert.strictEqual(res.digits, 6);
});

test("custom fields decrypt only on demand", async () => {
  const { client } = await loginClient();
  const items = await client.sync({ force: true });
  const org = items.find((i) => i.organizationId === ORG_ID);
  assert.match(org.secrets.fields[0].value, /^2\./);
  assert.strictEqual(org.secrets.fields[0].name, "PIN");
  assert.strictEqual(P.symmetric_decrypt_string(org.secrets.fields[0].value, org.key), vault.orgFieldPin);
});

test("lock drops keys but keeps the session token; sync then refuses", async () => {
  const { client } = await loginClient();
  await client.sync({ force: true });
  client.lock();
  assert.strictEqual(client.unlocked, false);
  assert.strictEqual(client.items, null);
  assert.ok(client.accessToken, "lock is not logout");
  await assert.rejects(() => client.sync({ force: true }), /LOCKED/);
});

test("an expired access token is refreshed from the stored refresh token", async () => {
  const { client } = await loginClient({ allowRefresh: true });
  client.expiresAt = Date.now() - 1000;
  const items = await client.sync({ force: true });
  assert.ok(items.length > 0);
  assert.strictEqual(client.accessToken, "access-refreshed");
});

test("session loss is reported when refresh fails", async () => {
  const { client } = await loginClient();
  client.expiresAt = Date.now() - 1000;
  await assert.rejects(() => client.sync({ force: true }), /SESSION_EXPIRED/);
});

test("server URL normalisation keeps the api and identity prefixes working", async () => {
  const { normalizeServer } = require("../src/client");
  const { client } = await loginClient();
  assert.strictEqual(client.serverUrl, "https://vw.example");
  assert.strictEqual(normalizeServer("https://vw.example/api/"), "https://vw.example/api");
  assert.throws(() => normalizeServer("ftp://vw.example"), /unsupported protocol/);
});

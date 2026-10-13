// Shared synthetic vault for the tests. Every key and secret is generated at run
// time, so no credential (real or placeholder) is ever written into these files.
const crypto = require("node:crypto");
const { PureCrypto: P } = require("../src/sdk").loadSdk();

const EMAIL = "spike@example.com";
const SALT = EMAIL.toLowerCase();
const ITERS = 100000;
const KDF = { pBKDF2: { iterations: ITERS } };
const ORG_ID = crypto.randomUUID();
const MASTER_PASSWORD = crypto.randomBytes(18).toString("base64url");
const TOTP_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // RFC 6238 public test secret

const userKey = P.make_user_key_aes256_cbc_hmac();
const orgKey = P.make_user_key_aes256_cbc_hmac();
const itemKey = P.make_user_key_aes256_cbc_hmac();
const privateKeyDer = P.rsa_generate_keypair();
const publicKeyDer = P.rsa_extract_public_key(privateKeyDer);

const enc = (text, key) => P.symmetric_encrypt_string(text, key);
const randomSecret = () => crypto.randomBytes(12).toString("base64url");

const vault = {
  personalPassword: randomSecret(),
  itemPassword: randomSecret(),
  orgPassword: randomSecret(),
  noteText: randomSecret(),
  // Some real vaults put the same string in the username and the password; the
  // secret-invariants must not treat that data as a leak.
  reused: "abc12",
  orgFieldPin: "1234",
  ciphers: [],
};

vault.ciphers = [
  {
    id: crypto.randomUUID(),
    type: 1,
    name: enc("演示 GitHub", userKey),
    key: null,
    organizationId: null,
    folderId: "f1",
    favorite: true,
    reprompt: 0,
    edit: true,
    revisionDate: "2026-10-01T10:00:00.000Z",
    login: {
      username: enc("demo@example.com", userKey),
      password: enc(vault.personalPassword, userKey),
      totp: enc(TOTP_B32, userKey),
      uris: [{ uri: enc("github.com", userKey) }, { uri: enc("https://api.github.com", userKey) }],
    },
    // A login item's own note: still ciphertext until revealed.
    notes: enc(vault.noteText, userKey),
    fields: [],
  },
  {
    id: crypto.randomUUID(),
    type: 1,
    name: enc("逐条目密钥条目", itemKey),
    key: P.wrap_symmetric_key(itemKey, userKey),
    organizationId: null,
    login: { username: enc("item-user", itemKey), password: enc(vault.itemPassword, itemKey), uris: [] },
    fields: [],
  },
  {
    id: crypto.randomUUID(),
    type: 1,
    name: enc("组织共享条目", orgKey),
    key: null,
    organizationId: ORG_ID,
    login: { username: enc("org-user", orgKey), password: enc(vault.orgPassword, orgKey), uris: [{ uri: enc("intranet.internal", orgKey) }] },
    fields: [{ name: enc("PIN", orgKey), value: enc(vault.orgFieldPin, orgKey) }],
  },
  {
    // Mirrors an item measured in the real vault: username and password are the
    // same short string. The cache still holds both as ciphertext.
    id: crypto.randomUUID(),
    type: 1,
    name: enc("同号条目", userKey),
    key: null,
    login: { username: enc(vault.reused, userKey), password: enc(vault.reused, userKey), uris: [] },
    fields: [],
  },
  {
    // Not a login: must never reach the result list.
    id: crypto.randomUUID(),
    type: 2,
    name: enc("安全备注", userKey),
    key: null,
    secureNote: { note: enc(vault.noteText, userKey) },
    login: null,
    fields: [],
  },
  {
    id: crypto.randomUUID(),
    type: 3,
    name: enc("银行卡", userKey),
    key: null,
    card: { cardholderName: enc("demo", userKey) },
    login: null,
    fields: [],
  },
  {
    // A login with no username, password, URI or note: the row still has to offer
    // a default action.
    id: crypto.randomUUID(),
    type: 1,
    name: enc("空白登录条目", userKey),
    key: null,
    login: { username: null, uris: [] },
    fields: [],
  },
  {
    id: crypto.randomUUID(),
    type: 1,
    name: enc("回收站条目", userKey),
    deletedDate: "2026-09-01T00:00:00.000Z",
    login: { username: null, uris: [] },
    fields: [],
  },
  {
    // Deleted *and* not a login: counted once, in the recycle-bin bucket.
    id: crypto.randomUUID(),
    type: 2,
    name: enc("已删备注", userKey),
    deletedDate: "2026-09-02T00:00:00.000Z",
    secureNote: { note: enc("x", userKey) },
    fields: [],
  },
];

// state flags steer behaviour and failure paths: expectedAuthHash, tokenStatus,
// require2fa, allowRefresh, dropKey, argonAccount, noOrgKeys
function makeTransport(state = {}) {
  return async (url, init = {}) => {
    const json = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) });
    if (url.endsWith("/identity/accounts/prelogin")) {
      return json(state.argonAccount ? { kdf: 1, kdfIterations: 2, kdfMemory: 64, kdfParallelism: 1 } : { kdf: 0, kdfIterations: ITERS });
    }
    if (url.endsWith("/identity/connect/token")) {
      const form = new URLSearchParams(init.body);
      if (state.tokenStatus) return json({ error: "server_error" }, state.tokenStatus);
      if (form.get("grant_type") === "refresh_token") {
        return state.allowRefresh ? json({ access_token: "access-refreshed", expires_in: 3600, refresh_token: "refresh-2" }) : json({ error: "invalid_grant" }, 400);
      }
      if (state.require2fa) return json({ TwoFactorProviders2: { 0: {}, 1: {} } }, 400);
      if (state.expectedAuthHash && form.get("password") !== state.expectedAuthHash) return json({ error: "invalid_grant" }, 400);
      const body = {
        access_token: "access-1",
        expires_in: 3600,
        refresh_token: "refresh-1",
        PrivateKey: P.symmetric_encrypt_bytes(privateKeyDer, userKey),
        AccountKeys: {},
        UserDecryptionOptions: {
          HasMasterPassword: true,
          MasterPasswordUnlock: { Kdf: { KdfType: 0, Iterations: ITERS }, Salt: SALT },
        },
      };
      if (!state.dropKey) body.Key = P.encrypt_user_key_with_master_password(userKey, MASTER_PASSWORD, SALT, KDF);
      return json(body);
    }
    if (url.endsWith("/api/sync")) {
      return json({
        profile: {
          organizations: state.noOrgKeys
            ? []
            : [{ id: ORG_ID, name: "示例组织", key: P.encapsulate_key_unsigned(orgKey, publicKeyDer) }],
        },
        folders: [{ id: "f1", name: enc("示例文件夹", userKey) }],
        collections: [],
        ciphers: vault.ciphers,
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
}

module.exports = { vault, makeTransport, EMAIL, SALT, ITERS, KDF, MASTER_PASSWORD, ORG_ID, TOTP_B32, P, userKey, orgKey, itemKey, publicKeyDer, privateKeyDer };

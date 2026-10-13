// Vaultwarden client: identity login, key assembly, /sync and per-item decryption.
// All vault decryption happens here, in memory, using the official wasm engine.
// The master password is never stored: it is used to derive the user key and then
// dropped. Re-authenticating after a restart is expected behaviour.
const crypto = require("crypto");
const { loadSdk } = require("./sdk");
const { hostOf } = require("./search");

// Cipher type 1 is a login: the only kind this plugin surfaces. Secure notes,
// cards and identities carry no credential to fill, so they are not searched,
// not decrypted and not kept in memory.
const LOGIN_TYPE = 1;
// The plugin emulates the official web client, so the version it announces and the
// version in plugin.json are one number: verify.mjs fails if they drift.
const CLIENT_VERSION = "2026.10.0";
const utf8 = (value) => new TextEncoder().encode(String(value ?? ""));

function normalizeServer(value) {
  const url = new URL(String(value).trim());
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("unsupported protocol");
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

// A 400 with an empty body usually means something in front of Vaultwarden
// answered rather than the app, so the response metadata is the diagnosis.
// The token response never carries a secret, only error text.
function responseSummary(res) {
  const body = String(res.text ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
  return [
    `status=${res.status}`,
    `server=${res.headers?.server ?? "?"}`,
    `content-type=${res.headers?.["content-type"] ?? "?"}`,
    `body=${body || "<empty>"}`,
  ].join(" ");
}

// An EncString looks like "2.iv|data|mac" (or "0.iv|data", "4.data").
const encType = (value) => (typeof value === "string" && /^\d\./.test(value) ? value.slice(0, 2) : null);

class VaultwardenClient {
  constructor(transport = null) {
    this.sdk = loadSdk();
    this.P = this.sdk.PureCrypto;
    this.transport = transport || ((url, init) => fetch(url, init));
    this.reset();
  }

  reset() {
    this.serverUrl = "";
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this.deviceIdentifier = null;
    this.userKey = null;
    this.privateKeyDer = null;
    this.orgKeys = new Map();
    this.orgNames = new Map();
    this.items = null;
    this.syncedAt = 0;
    this.diagnostics = { ciphers: 0, skipped: 0, nonLogin: 0, undecryptable: 0, orgKeysFailed: 0, orgKeySource: "none" };
  }

  get unlocked() {
    return this.userKey !== null;
  }

  get hasSession() {
    return this.accessToken !== null && Date.now() < this.expiresAt;
  }

  lock() {
    // Keep the refresh token: "locked" only drops what can read the vault.
    this.userKey = null;
    this.privateKeyDer = null;
    this.orgKeys = new Map();
    this.orgNames = new Map();
    this.items = null;
    this.syncedAt = 0;
  }

  clearSession() {
    this.reset();
  }

  async #request(url, { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.transport(url, { method, headers, body, signal: controller.signal });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* error pages are not JSON */
      }
      let resHeaders = {};
      try {
        resHeaders = Object.fromEntries(res.headers.entries());
      } catch {
        /* test doubles may not expose headers */
      }
      return { status: res.status, json, text, headers: resHeaders };
    } finally {
      clearTimeout(timer);
    }
  }

  async #api(pathname, { method = "GET", body, authenticated = true } = {}) {
    const headers = {
      Accept: "application/json",
      "Bitwarden-Client-Version": CLIENT_VERSION,
      "Bitwarden-Client-Type": "browser",
      "device-type": "7",
    };
    if (authenticated) {
      if (!this.accessToken) throw new Error("not logged in");
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.#request(`${this.serverUrl}/api${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    if (res.status >= 400) throw new Error(`HTTP ${res.status} ${pathname}`);
    return res.json;
  }

  async #identity(form, timeoutMs = 20000) {
    const res = await this.#request(`${this.serverUrl}/identity/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      timeoutMs,
    });
    return res;
  }

  async prelogin(email) {
    const res = await this.#request(`${this.serverUrl}/identity/accounts/prelogin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (res.status !== 200 || !res.json) throw new Error(`PRELOGIN_${res.status}`);
    const kdfType = res.json.kdf ?? res.json.Kdf ?? 0;
    const iterations = res.json.kdfIterations ?? res.json.KdfIterations ?? 100000;
    return {
      kdfType,
      kdf: kdfType === 1
        ? { argon2id: {
            iterations,
            memory: res.json.kdfMemory ?? res.json.KdfMemory,
            parallelism: res.json.kdfParallelism ?? res.json.KdfParallelism,
          } }
        : { pBKDF2: { iterations } },
      iterations,
    };
  }

  deriveMasterKey(masterPassword, email, kdf) {
    return this.P.derive_kdf_material(utf8(masterPassword), utf8(email.trim().toLowerCase()), kdf);
  }

  authHash(masterKey, masterPassword) {
    return Buffer.from(crypto.pbkdf2Sync(Buffer.from(masterKey), utf8(masterPassword), 1, 32, "sha256")).toString("base64");
  }

  /**
   * Full login: password grant, then assemble userKey / RSA private key / org keys.
   * The masterPassword argument is used once and never retained.
   */
  async login({ serverUrl, email, masterPassword, deviceIdentifier }) {
    this.serverUrl = normalizeServer(serverUrl);
    const { kdf, kdfType, iterations } = await this.prelogin(email);
    if (kdfType === 1) throw new Error("ARGON2_UNSUPPORTED: 该账号使用 Argon2id，当前插件版本只支持 PBKDF2 账号");
    const masterKey = this.deriveMasterKey(masterPassword, email, kdf);
    const res = await this.#identity({
      grant_type: "password",
      username: email,
      password: this.authHash(masterKey, masterPassword),
      scope: "api offline_access",
      client_id: "web",
      deviceType: "7",
      deviceIdentifier,
      deviceName: "Wox",
    });
    if (res.status === 400 && res.json?.TwoFactorProviders2) {
      throw new Error(`2FA_REQUIRED: ${Object.keys(res.json.TwoFactorProviders2).join(",")}`);
    }
    if (res.status === 429) throw new Error("RATE_LIMITED: 登录过于频繁，请约 60 秒后再试");
    if (res.status !== 200 || !res.json?.access_token) {
      throw new Error(`${res.status === 400 ? "MASTER_PASSWORD_WRONG" : `TOKEN_${res.status}`}: ${responseSummary(res)}`);
    }
    const t = res.json;
    this.accessToken = t.access_token;
    this.refreshToken = t.refresh_token ?? null;
    this.deviceIdentifier = deviceIdentifier;
    this.expiresAt = Date.now() + (Number(t.expires_in ?? 3600) - 60) * 1000;

    const unlock = t.UserDecryptionOptions?.MasterPasswordUnlock;
    if (!t.Key) throw new Error("LEGACY_KEY_FORMAT: 该账号没有 UserKey（旧版密钥格式），当前插件版本不支持");
    const salt = unlock?.Salt ?? email.trim().toLowerCase();
    const effectiveKdf = unlock?.Kdf
      ? (unlock.Kdf.KdfType === 1
          ? { argon2id: { iterations: unlock.Kdf.Iterations, memory: unlock.Kdf.Memory, parallelism: unlock.Kdf.Parallelism } }
          : { pBKDF2: { iterations: unlock.Kdf.Iterations } })
      : kdf;
    this.kdfInfo = { type: unlock?.Kdf?.KdfType ?? kdfType, iterations: unlock?.Kdf?.Iterations ?? iterations };
    this.userKey = this.P.decrypt_user_key_with_master_password(t.Key, masterPassword, salt, effectiveKdf);
    if (this.userKey.length !== 64) throw new Error("USER_KEY_LENGTH");
    this.privateKeyDer = this.P.symmetric_decrypt_bytes(t.PrivateKey, this.userKey);
    this.items = null;
    return { email, kdfType: this.kdfInfo.type, iterations: this.kdfInfo.iterations, hasRefreshToken: Boolean(this.refreshToken) };
  }

  // Organisation keys are not part of the login response on Vaultwarden: they
  // arrive in /sync as profile.organizations[].key, wrapped either under the
  // user key or under our own RSA public key.
  #ingestOrganizationKeys(orgs) {
    for (const org of Array.isArray(orgs) ? orgs : []) {
      const id = org.id ?? org.Id;
      if (!id) continue;
      // The name is plaintext while the key is not, and the preview shows the
      // organisation by name the way the vault does.
      const name = org.name ?? org.Name;
      if (typeof name === "string" && name) this.orgNames.set(id, name);
      const blob = org.key ?? org.Key;
      if (!blob || this.orgKeys.has(id)) continue;
      try {
        this.orgKeys.set(
          id,
          encType(blob) === "3." || encType(blob) === "4."
            ? this.P.decapsulate_key_unsigned(blob, this.privateKeyDer)
            : this.P.unwrap_symmetric_key(blob, this.userKey),
        );
      } catch {
        this.diagnostics.orgKeysFailed++;
      }
    }
  }

  async refreshTokenIfNeeded() {
    if (this.accessToken && Date.now() < this.expiresAt) return true;
    if (!this.refreshToken) return false;
    const res = await this.#identity({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      client_id: "web",
      scope: "api offline_access",
      deviceType: "7",
      deviceIdentifier: this.deviceIdentifier ?? "wox-plugin-bitwarden",
      deviceName: "Wox",
    });
    if (res.status !== 200 || !res.json?.access_token) return false;
    this.accessToken = res.json.access_token;
    this.refreshToken = res.json.refresh_token ?? this.refreshToken;
    this.expiresAt = Date.now() + (Number(res.json.expires_in ?? 3600) - 60) * 1000;
    return true;
  }

  #decryptField(blob, key) {
    if (!blob) return "";
    try {
      return this.P.symmetric_decrypt_string(blob, key);
    } catch {
      this.diagnostics.undecryptable++;
      return "";
    }
  }

  #keyForCipher(cipher) {
    const baseKey = cipher.organizationId ? this.orgKeys.get(cipher.organizationId) : this.userKey;
    if (!baseKey) return null;
    if (!cipher.key) return baseKey;
    try {
      return this.P.unwrap_symmetric_key(cipher.key, baseKey);
    } catch {
      return null;
    }
  }

  async sync({ force = false, maxAgeMs = 60000 } = {}) {
    if (!this.unlocked) throw new Error("LOCKED");
    if (!force && this.items && Date.now() - this.syncedAt < maxAgeMs) return this.items;
    if (!(await this.refreshTokenIfNeeded())) throw new Error("SESSION_EXPIRED");
    const data = await this.#api("/sync");
    const folders = new Map((data.folders ?? []).map((f) => [f.id, this.#decryptField(f.name, this.userKey)]));
    this.diagnostics = {
      ciphers: 0,
      skipped: 0,
      nonLogin: 0,
      undecryptable: 0,
      orgKeysFailed: this.diagnostics.orgKeysFailed,
      orgKeySource: this.diagnostics.orgKeySource,
    };
    // Ciphers of an organisation are keyed by that organisation's key, which the
    // sync payload itself carries; ingest it before the cipher loop.
    this.#ingestOrganizationKeys(data.profile?.organizations ?? data.profile?.Organizations);
    if (this.orgKeys.size > 0) this.diagnostics.orgKeySource = "sync";
    const items = [];
    for (const cipher of data.ciphers ?? []) {
      this.diagnostics.ciphers++;
      // Recycle bin first: the counters must stay mutually exclusive, otherwise a
      // deleted non-login cipher is counted twice depending on check order.
      if (cipher.deletedDate) {
        this.diagnostics.skipped++;
        continue;
      }
      if (cipher.type !== LOGIN_TYPE) {
        this.diagnostics.nonLogin++;
        continue;
      }
      const key = this.#keyForCipher(cipher);
      if (!key) {
        this.diagnostics.skipped++;
        continue;
      }
      const name = this.#decryptField(cipher.name, key);
      if (!name) {
        this.diagnostics.skipped++;
        continue;
      }
      items.push(this.#toItem(cipher, key, name, folders));
    }
    this.items = items;
    this.syncedAt = Date.now();
    return this.items;
  }

  #toItem(cipher, key, name, folders) {
    const login = cipher.login ?? {};
    const uris = (login.uris ?? [])
      .map((u) => this.#decryptField(u?.uri, key).trim())
      .filter(Boolean);
    // Names, usernames and URIs must be decrypted up front because search runs
    // locally. Passwords, TOTP secrets and the note stay as ciphertext and are
    // decrypted only when the user asks for that one field.
    return {
      id: cipher.id,
      name,
      username: this.#decryptField(login.username, key),
      uris,
      uriHosts: uris.map(hostOf).filter(Boolean),
      primaryUri: uris[0] ?? "",
      folderName: cipher.folderId ? folders.get(cipher.folderId) ?? "" : "",
      favorite: Boolean(cipher.favorite),
      organizationId: cipher.organizationId ?? null,
      organizationName: cipher.organizationId ? this.orgNames.get(cipher.organizationId) ?? "" : "",
      reprompt: cipher.reprompt ?? 0,
      editable: cipher.edit !== false,
      hasAttachments: Boolean(cipher.attachments && Object.keys(cipher.attachments).length),
      updated: cipher.revisionDate ?? cipher.creationDate ?? "",
      key,
      secrets: {
        password: login.password ?? null,
        totp: login.totp ?? null,
        note: cipher.notes ?? null,
        fields: (cipher.fields ?? []).map((f) => ({
          name: this.#decryptField(f?.name, key),
          value: f?.value ?? null,
        })),
      },
    };
  }

  hasField(item, field) {
    if (field === "password") return Boolean(item.secrets.password);
    if (field === "totp") return Boolean(item.secrets.totp);
    if (field === "note") return Boolean(item.secrets.note);
    return false;
  }

  decryptField(item, field) {
    const blob = item.secrets[field];
    if (!blob) return "";
    return this.P.symmetric_decrypt_string(blob, item.key);
  }

  // TOTP codes are time-based, so the secret is decrypted fresh on every call.
  totpCode(item, timeMs = Date.now()) {
    const secret = this.decryptField(item, "totp");
    if (!secret) return null;
    return { code: null, ...(require("./totp").generate(secret, timeMs)) };
  }
}

module.exports = { VaultwardenClient, normalizeServer, CLIENT_VERSION };

// Wox UI wiring for the Bitwarden/Vaultwarden plugin.
// Trigger: pw   Commands: lock
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { VaultwardenClient } = require("./client");
const { formatClock, formatStamp } = require("./time");
const favicon = require("./favicon");
const { searchItems } = require("./search");
const icons = require("./icons");

const SYNC_MAX_AGE_MS = 60000;
const MAX_RESULTS = 50;
const MAX_USAGE_ITEMS = 500;

class BitwardenPlugin {
  constructor(client = new VaultwardenClient(), deps = {}) {
    this.client = client;
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init));
    this.icons = deps.icons ?? favicon.createIconCache();
    this.api = null;
    this.usageFile = null;
    this.usage = null;
    // The host calls the extracted lifecycle functions without a receiver.
    this.init = this.init.bind(this);
    this.query = this.query.bind(this);
  }

  async init(ctx, params) {
    this.api = params.API;
    try {
      this.usageFile = path.join(await this.api.GetCacheFolder(ctx), "usage.json");
    } catch {
      this.usageFile = null;
    }
    await this.api.OnSettingChanged(ctx, async (_c, key) => {
      if (key === "serverUrl") this.client.clearSession();
    });
    await this.api.OnUnload(ctx, async () => this.client.clearSession());
    await this.api.Log(ctx, "Info", "bitwarden plugin initialized");
  }

  async #settings(ctx) {
    const [serverUrl, email, deviceId] = await Promise.all([
      this.api.GetSetting(ctx, "serverUrl"),
      this.api.GetSetting(ctx, "accountEmail"),
      this.api.GetSetting(ctx, "deviceId"),
    ]);
    return { serverUrl: (serverUrl || "").trim(), email: email || "", deviceId: deviceId || "" };
  }

  async #deviceId(ctx) {
    const existing = await this.api.GetSetting(ctx, "deviceId");
    if (existing) return existing;
    const id = crypto.randomUUID();
    // IsLocal, not PlatformSpecific: PlatformSpecific only files the value under
    // "deviceId@windows" and still uploads it, which would put the same
    // Vaultwarden device identifier on two machines.
    await this.#save(ctx, "deviceId", id, { IsLocal: true });
    return id;
  }

  // SetSetting reports whether the write landed; the deprecated SaveSetting only
  // logs the failure core-side and hands the plugin nothing back.
  async #save(ctx, key, value, options = {}) {
    const result = await this.api.SetSetting(ctx, { Key: key, Value: value, PlatformSpecific: false, ...options });
    if (!result || result.Success !== true) {
      const reason = result && result.ErrMsg ? result.ErrMsg : "no result";
      await this.api.Log(ctx, "Warning", `setting write failed: ${key}: ${reason}`.slice(0, 160));
    }
    return result;
  }

  async query(ctx, query) {
    try {
      const command = (query.Command || "").toLowerCase();
      // `lock` is the only command: dropping the keys is the one thing a plain
      // query cannot do. Unlocking and refreshing happen on any `pw` query, and
      // the session lives in memory only, so restarting Wox already logs out.
      // Every other query needs a server, and QueryRequirements.AnyQuery already
      // blocks it core-side (manager.go:1631) before query() is even called.
      if (command === "lock") return { Results: [await this.buildLockRow(ctx)] };
      if (!this.client.unlocked) {
        return { Results: [await this.buildLoginForm(ctx, "unlock_title")] };
      }
      return { Results: await this.buildSearchRows(ctx, query.Search, false) };
    } catch (error) {
      return { Results: [await this.buildErrorRow(ctx, error)] };
    }
  }

  // --- login / session rows ---------------------------------------------

  async buildLoginForm(ctx, titleKey) {
    const { serverUrl, email } = await this.#settings(ctx);
    const field = (type, key, label, options = {}) => ({
      Type: type,
      Value: {
        Key: key,
        Label: label,
        Suffix: "",
        DefaultValue: options.defaultValue ?? "",
        Tooltip: "",
        MaxLines: 1,
        Validators: options.required === false ? [] : [{ Type: "not_empty", Value: {} }],
      },
      DisabledInPlatforms: [],
      IsPlatformSpecific: false,
    });
    return {
      Id: "pw-login",
      Title: await this.t(ctx, titleKey),
      SubTitle: await this.t(ctx, "login_subtitle", { server: serverUrl }),
      Icon: icons.LOGIN_ICON,
      Preview: {
        PreviewType: "markdown",
        PreviewData: await this.t(ctx, "login_preview", { server: serverUrl }),
      },
      Actions: [
        {
          Id: "pw-action-login",
          Type: "form",
          Name: "i18n:login_action",
          Icon: icons.KEY_ICON,
          IsDefault: true,
          PreventHideAfterAction: true,
          Form: [
            field("textbox", "email", await this.t(ctx, "field_email"), { defaultValue: email }),
            field("password", "masterPassword", await this.t(ctx, "field_master_password")),
          ],
          OnSubmit: async (actionCtx, formCtx) => this.submitLogin(actionCtx, formCtx.Values),
        },
      ],
    };
  }

  async submitLogin(ctx, values) {
    const { serverUrl } = await this.#settings(ctx);
    const email = String(values.email || "").trim();
    const masterPassword = String(values.masterPassword || "");
    try {
      await this.client.login({
        serverUrl,
        email,
        masterPassword,
        deviceIdentifier: await this.#deviceId(ctx),
      });
      await this.#save(ctx, "accountEmail", email);
      await this.api.Notify(ctx, await this.t(ctx, "login_success"));
      await this.api.RefreshQuery(ctx, { PreserveSelectedIndex: false });
    } catch (error) {
      await this.api.Log(ctx, "Error", `login failed: ${error && error.message ? error.message : String(error)}`.slice(0, 500));
      await this.api.Notify(ctx, await this.errorMessage(ctx, error));
    }
  }

  async buildLockRow(ctx) {
    if (!this.client.unlocked) return this.simpleRow(ctx, "already_locked_title", "already_locked_subtitle", icons.LOCK_ICON);
    return {
      Id: "pw-lock",
      Title: await this.t(ctx, "lock_title"),
      SubTitle: await this.t(ctx, "lock_subtitle"),
      Icon: icons.LOCK_ICON,
      Actions: [
        {
          Id: "pw-action-lock",
          Name: "i18n:lock_action",
          Icon: icons.LOCK_ICON,
          IsDefault: true,
          PreventHideAfterAction: true,
          Action: async (actionCtx) => {
            this.client.lock();
            await this.api.Notify(actionCtx, await this.t(actionCtx, "lock_done"));
            await this.api.RefreshQuery(actionCtx, { PreserveSelectedIndex: false });
          },
        },
      ],
    };
  }

  // --- result rows -------------------------------------------------------

  async buildSearchRows(ctx, search, forceSync) {
    const items = await this.client.sync({ force: forceSync, maxAgeMs: SYNC_MAX_AGE_MS });
    void this.icons.probe([...new Set(items.flatMap((i) => i.uriHosts))], this.fetch);
    const usage = await this.loadUsage(ctx);
    const matched = searchItems(items, search, { limit: MAX_RESULTS, usage });
    if (matched.length === 0) {
      return [await this.simpleRow(ctx, "no_results", "no_results_subtitle", icons.VAULT_ICON)];
    }
    return Promise.all(matched.map((item) => this.buildItemRow(ctx, item)));
  }

  async buildItemRow(ctx, item) {
    const host = item.uriHosts[0] || "";
    return {
      Id: `pw-item-${item.id}`,
      Title: item.name,
      SubTitle: await this.subtitleFor(ctx, item),
      // The cipher id is the one thing about this row that never changes: not the
      // name, not the language, not the query. Wox keys history and pins on it.
      IdentityKey: item.id,
      Icon: this.icons.iconFor(host, icons.VAULT_ICON),
      Tails: await this.buildTails(ctx, item),
      Preview: await this.buildPreview(ctx, item, false),
      Actions: await this.buildActions(ctx, item, false),
    };
  }

  // Tails are display-only (Wox's ResultTail has no click callback), and a
  // fourth one can be clipped, so this stays at three at most. The URI host is
  // not shown: it repeats what the title and subtitle already say.
  async buildTails(ctx, item) {
    const tails = [];
    if (item.favorite) tails.push({ Type: "text", Text: "★", TextCategory: "warning" });
    if (this.client.hasField(item, "totp")) {
      tails.push({ Type: "image", Image: icons.CLOCK_ICON, ImageWidth: 22, ImageHeight: 22, Tooltip: await this.t(ctx, "field_totp") });
    }
    return tails;
  }

  async subtitleFor(ctx, item) {
    const shown = item.username || item.uriHosts[0] || item.primaryUri;
    return shown || (await this.t(ctx, "no_username_or_uri"));
  }

  // Rebuilds the whole action set together with preview visibility state.
  async buildActions(ctx, item, revealed) {
    const rowId = `pw-item-${item.id}`;
    const actions = [];
    // Copying the password is the default action: the host hoists whatever is
    // IsDefault to panel row 1 (manager.go:3459) and Enter triggers it, so that is
    // the only keyboard gesture this plugin claims. Everything else is a button.
    if (this.client.hasField(item, "password")) {
      actions.push({
        Id: `pw-copy-password-${item.id}`,
        Name: "i18n:copy_password",
        Icon: icons.COPY_ICON,
        IsDefault: true,
        Action: async (actionCtx) => this.copySecret(actionCtx, item, "password", "password_copied"),
      });
    }
    if (item.username) {
      actions.push({
        Id: `pw-copy-username-${item.id}`,
        Name: "i18n:copy_username",
        Icon: icons.USER_ICON,
        ShowInToolbar: true,
        Action: async (actionCtx) => {
          await this.api.Copy(actionCtx, { type: "text", text: item.username });
          await this.api.Notify(actionCtx, await this.t(actionCtx, "username_copied"));
        },
      });
    }
    // Only the primary address gets an action: the rest are listed and clickable
    // in the preview. This copies instead of launching — spawning the OS handler is
    // what set off his antivirus, and the plugin has no business starting processes.
    if (item.uris.length > 0) {
      actions.push({
        Id: `pw-copy-uri-${item.id}`,
        Name: "i18n:copy_uri",
        Icon: icons.COPY_ICON,
        Action: async (actionCtx) => {
          await this.api.Copy(actionCtx, { type: "text", text: item.uris[0] });
          await this.api.Notify(actionCtx, await this.t(actionCtx, "uri_copied"));
        },
      });
    }
    if (this.client.hasField(item, "totp")) {
      actions.push({
        Id: `pw-copy-totp-${item.id}`,
        Name: "i18n:copy_totp",
        Icon: icons.CLOCK_ICON,
        Action: async (actionCtx) => this.copyTotp(actionCtx, item),
      });
    }
    for (let i = 0; i < item.secrets.fields.length && i < 2; i++) {
      const field = item.secrets.fields[i];
      if (!field.name || !field.value) continue;
      actions.push({
        Id: `pw-copy-field-${item.id}-${i}`,
        Name: `${await this.t(ctx, "copy_field")}: ${field.name}`,
        Icon: icons.COPY_ICON,
        Action: async (actionCtx) => {
          const value = this.client.P.symmetric_decrypt_string(field.value, item.key);
          await this.api.Copy(actionCtx, { type: "text", text: value });
          await this.api.Notify(actionCtx, await this.t(actionCtx, "field_copied"));
        },
      });
    }
    // Last row of the panel, as he asked. It still gets a toolbar button, and the
    // toolbar fits pinned actions in this same source order.
    if (this.client.hasField(item, "password") || this.client.hasField(item, "note")) {
      actions.push({
        Id: `pw-toggle-${item.id}`,
        Name: "i18n:toggle_secret",
        Icon: revealed ? icons.EYE_OFF_ICON : icons.EYE_ICON,
        // Actions are the only mouse-tappable surface a plugin owns
        // (actions_view.go OnTap); preview rows and tails have no callback, so the
        // eye is a toolbar/panel button and has no hotkey of its own.
        ShowInToolbar: true,
        PreventHideAfterAction: true,
        Action: async (actionCtx) => {
          const next = !revealed;
          await this.api.UpdateResult(actionCtx, {
            Id: rowId,
            Preview: await this.buildPreview(actionCtx, item, next),
            Actions: await this.buildActions(actionCtx, item, next),
          });
        },
      });
    }
    if (actions.length === 0) {
      actions.push({
        Id: `pw-copy-name-${item.id}`,
        Name: "i18n:copy_name",
        Icon: icons.COPY_ICON,
        IsDefault: true,
        Action: async (actionCtx) => {
          await this.api.Copy(actionCtx, { type: "text", text: item.name });
        },
      });
    }
    // Enter must always land on something: a row whose only action is the reveal
    // toggle (a login with a note but no credentials) needs a default marked.
    if (!actions.some((action) => action.IsDefault)) actions[0].IsDefault = true;
    return actions;
  }

  async copySecret(ctx, item, field, doneKey) {
    let value = "";
    try {
      value = this.client.decryptField(item, field);
    } catch (error) {
      await this.api.Notify(ctx, await this.t(ctx, "decrypt_failed"));
      await this.api.Log(ctx, "Error", `decrypt ${field} failed: ${error.message}`.slice(0, 120));
      return;
    }
    if (!value) {
      await this.api.Notify(ctx, await this.t(ctx, "nothing_to_copy"));
      return;
    }
    await this.api.Copy(ctx, { type: "text", text: value });
    await this.recordUsage(ctx, item.id);
    await this.api.Notify(ctx, await this.t(ctx, doneKey));
  }

  async copyTotp(ctx, item) {
    try {
      const { code, secondsLeft } = this.client.totpCode(item);
      await this.api.Copy(ctx, { type: "text", text: code });
      await this.recordUsage(ctx, item.id);
      await this.api.Notify(ctx, await this.t(ctx, "totp_copied", { code, seconds: secondsLeft }));
    } catch (error) {
      await this.api.Log(ctx, "Error", `totp failed: ${error.message}`.slice(0, 120));
      await this.api.Notify(ctx, await this.t(ctx, "totp_failed"));
    }
  }

  // Markdown rather than the `list` preview: `list` rows are icon/title/subtitle
  // only and the renderer has no gesture on them, while markdown links open in the
  // browser (markdown_preview_view.go OnOpenLink). That trade costs the icon blocks.
  async buildPreview(ctx, item, reveal) {
    // `_` is deliberately not escaped: CommonMark never emphasises mid-word, and
    // base64url secrets and URLs are full of it.
    const esc = (text) => String(text).replace(/[\\`*[\]<>]/g, (ch) => `\\${ch}`);
    const blocks = [];
    // Two trailing spaces = a CommonMark hard break, so one field stays one block
    // and blocks remain separable by a blank line.
    // Labels are our own translations, so they go in raw; only vault-derived
    // values are escaped.
    const add = (label, value) => blocks.push(`**${label}**  \n${value}`);
    const link = (url) => (/^https?:\/\//i.test(url) ? `[${esc(url)}](<${url.replace(/[<>]/g, encodeURIComponent)}>)` : esc(url));
    // The code and its expiry must come from one instant, or the row contradicts
    // itself about which window it is showing.
    const renderedAt = Date.now();

    if (item.username) add(await this.t(ctx, "field_username"), esc(item.username));
    if (this.client.hasField(item, "password")) {
      const masked = "•".repeat(Math.min(Math.max(this.safeLength(item.secrets.password, 12), 8), 24));
      add(await this.t(ctx, "field_password"), reveal ? esc(safeDecrypt(this.client, item, "password")) : masked);
    }
    // One block per address: joining them into a single line gets folded by the
    // preview panel, which hides every URI after the first couple of lines.
    if (item.uris.length > 0) {
      const label = await this.t(ctx, "field_uris");
      const primaryLabel = await this.t(ctx, "primary_uri");
      for (let i = 0; i < item.uris.length; i++) {
        let rowLabel = label;
        if (item.uris.length > 1) rowLabel = `${label} ${i + 1}/${item.uris.length}${i === 0 ? ` · ${primaryLabel}` : ""}`;
        add(rowLabel, link(item.uris[i]));
      }
    }
    if (this.client.hasField(item, "totp")) {
      // Absolute end time, never "Ns": a frozen countdown on a static preview reads
      // as a live timer and lies within seconds.
      let hint;
      try {
        const totp = this.client.totpCode(item, renderedAt);
        hint = `${totp.code} · ${await this.t(ctx, "totp_expires", { time: formatClock(totp.expiresAt) })}`;
        if (totp.period !== 30) hint += await this.t(ctx, "totp_period", { seconds: totp.period });
      } catch {
        hint = await this.t(ctx, "totp_unavailable");
      }
      add(await this.t(ctx, "field_totp"), esc(hint));
    }
    if (this.client.hasField(item, "note")) {
      add(await this.t(ctx, "field_note"), reveal ? esc(safeDecrypt(this.client, item, "note")) : "••••••");
    }
    // Same two-line block as every field above: label, value, blank line. The
    // metadata is metadata, not a footer squeezed into one run -- and the panel
    // scrolls (markdown_preview_view.go:34), so uniform rhythm costs nothing.
    if (item.folderName) add(await this.t(ctx, "field_folder"), esc(item.folderName));
    add(await this.t(ctx, "field_scope"), esc(item.organizationName || (item.organizationId ? await this.t(ctx, "scope_org") : await this.t(ctx, "scope_personal"))));
    // The server's timestamp is UTC; the reader's clock is not. Parsing and
    // reformatting is what keeps "更新于" the truth for an edit made at 02:00 here.
    const revisedAt = Date.parse(item.updated);
    if (!Number.isNaN(revisedAt)) add(await this.t(ctx, "field_updated"), esc(formatStamp(revisedAt)));
    const tags = [{ Label: reveal ? await this.t(ctx, "tag_revealed") : await this.t(ctx, "tag_hidden") }];
    return {
      PreviewType: "markdown",
      PreviewData: blocks.join("\n\n"),
      PreviewTags: tags,
    };
  }

  safeLength(blob, fallback) {
    if (!blob) return fallback;
    const pieces = String(blob).split(".")[1].split("|");
    return Math.max(0, Math.round((pieces[1].length * 3) / 4) - 16);
  }

  // --- usage ranking (cache folder, never a setting: it is generated data) --

  async loadUsage(ctx) {
    if (this.usage !== null) return this.usage;
    this.usage = {};
    if (!this.usageFile) return this.usage;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.usageFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [id, value] of Object.entries(parsed)) {
          if (value && typeof value.count === "number" && typeof value.lastUsed === "number") this.usage[id] = value;
        }
      }
    } catch {
      this.usage = {};
    }
    return this.usage;
  }

  async recordUsage(ctx, id) {
    const usage = await this.loadUsage(ctx);
    const current = usage[id] || { count: 0, lastUsed: 0 };
    usage[id] = { count: current.count + 1, lastUsed: Date.now() };
    const trimmed = Object.fromEntries(
      Object.entries(usage).sort((a, b) => b[1].lastUsed - a[1].lastUsed).slice(0, MAX_USAGE_ITEMS),
    );
    this.usage = trimmed;
    if (!this.usageFile) return;
    try {
      fs.mkdirSync(path.dirname(this.usageFile), { recursive: true });
      fs.writeFileSync(this.usageFile, JSON.stringify(trimmed), "utf8");
    } catch (error) {
      await this.api.Log(ctx, "Warning", `usage write failed: ${error.message}`.slice(0, 120));
    }
  }

  // --- helpers -------------------------------------------------------------

  async simpleRow(ctx, titleKey, subtitleKey, icon, extra = "") {
    return {
      Id: `pw-${titleKey}`,
      Title: await this.t(ctx, titleKey),
      SubTitle: (await this.t(ctx, subtitleKey)) + extra,
      Icon: icon,
      Actions: [],
    };
  }

  async buildErrorRow(ctx, error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      Id: "pw-error",
      Title: await this.t(ctx, "error_title"),
      SubTitle: await this.errorMessage(ctx, message),
      Icon: icons.WARNING_ICON,
      Actions: [],
    };
  }

  async errorMessage(ctx, message) {
    if (/MASTER_PASSWORD_WRONG/.test(message)) return this.t(ctx, "err_password_wrong");
    if (/2FA_REQUIRED/.test(message)) return this.t(ctx, "err_2fa_unsupported");
    if (/RATE_LIMITED/.test(message)) return this.t(ctx, "err_rate_limited");
    if (/SESSION_EXPIRED/.test(message)) return this.t(ctx, "err_session_expired");
    if (/LEGACY_KEY_FORMAT/.test(message)) return this.t(ctx, "err_legacy_key");
    if (/ARGON2_UNSUPPORTED/.test(message)) return this.t(ctx, "err_argon2");
    if (/PRELOGIN_/.test(message)) return this.t(ctx, "err_prelogin");
    if (/LOCKED/.test(message)) return this.t(ctx, "err_locked");
    if (/Failed to fetch|fetch failed|ENOTFOUND|ECONN|abort/i.test(message)) return this.t(ctx, "err_unreachable");
    return this.t(ctx, "err_generic");
  }

  async t(ctx, key, vars = {}) {
    let text = await this.api.GetTranslation(ctx, key);
    for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, String(value));
    return text;
  }
}

function safeDecrypt(client, item, field) {
  try {
    return client.decryptField(item, field);
  } catch {
    return "—";
  }
}

module.exports = { BitwardenPlugin, SYNC_MAX_AGE_MS };

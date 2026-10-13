// {
//   "Id": "818bb7c0-b653-4fa5-8d5b-96d32e82d230",
//   "Name": "i18n:plugin_name",
//   "Author": "tanyp",
//   "Website": "https://github.com/tanyunpeng/wox-plugins",
//   "Version": "0.0.1",
//   "MinWoxVersion": "2.4.2",
//   "Runtime": "NODEJS",
//   "Description": "i18n:plugin_description",
//   "Icon": "svg:<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'><rect width='48' height='48' rx='12' fill='#7c3aed'/><path d='M11 13a4 4 0 0 1 4-4h18a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H22l-7 6v-6a4 4 0 0 1-4-4z' fill='#f5f3ff'/><path d='M17 17h14M17 23h9' stroke='#7c3aed' stroke-width='2.5' stroke-linecap='round'/></svg>",
//   "TriggerKeywords": ["pt"],
//   "SupportedOS": ["Windows", "Linux", "Darwin"],
//   "Features": [
//     { "Name": "mru", "Params": { "HashBy": "identityKey" } }
//   ],
//   "SettingDefinitions": [
//     {
//       "Type": "table",
//       "Value": {
//         "Key": "templates",
//         "Title": "i18n:setting_templates",
//         "Tooltip": "i18n:setting_templates_tip",
//         "SortColumnKey": "title",
//         "SortOrder": "asc",
//         "MaxHeight": 460,
//         "EnableSearch": true,
//         "SearchColumnKey": "title",
//         "Columns": [
//           {
//             "Key": "title",
//             "Label": "i18n:col_title",
//             "Type": "text",
//             "Width": 140,
//             "Validators": [{ "Type": "not_empty", "Value": {} }]
//           },
//           {
//             "Key": "body",
//             "Label": "i18n:col_body",
//             "Type": "text",
//             "Width": 420,
//             "TextMaxLines": 10,
//             "Validators": [{ "Type": "not_empty", "Value": {} }]
//           },
//           {
//             "Key": "note",
//             "Label": "i18n:col_note",
//             "Type": "text",
//             "Width": 200,
//             "TextMaxLines": 3
//           },
//           {
//             "Key": "id",
//             "Label": "i18n:col_id",
//             "Type": "text",
//             "HideInTable": true,
//             "HideInUpdate": true
//           }
//         ]
//       },
//       "IsPlatformSpecific": false
//     }
//   ],
//   "I18n": {
//     "en_US": {
//       "plugin_name": "Prompts",
//       "plugin_description": "Prompt template manager: press Enter to copy a template to the clipboard, edit templates in plugin settings.",
//       "setting_templates": "Prompt Templates",
//       "setting_templates_tip": "One row per template: the title is used for search and display, the body is the copied text, and the note shows as the result subtitle. Templates sync through your Wox account.",
//       "col_title": "Title",
//       "col_body": "Content",
//       "col_note": "Note",
//       "col_id": "Internal id",
//       "empty_title": "No prompt templates yet",
//       "empty_sub": "Open Wox Settings → Plugins → Prompts and add rows in the template table",
//       "action_copy": "Copy to clipboard",
//       "note_tag": "Note"
//     },
//     "zh_CN": {
//       "plugin_name": "提示词",
//       "plugin_description": "提示词模板管理：回车复制到剪贴板，设置表格里维护标题/内容/说明。",
//       "setting_templates": "提示词模板",
//       "setting_templates_tip": "每条模板一行：标题用于搜索和展示，内容为复制的正文，说明显示在结果行副标题。模板随 Wox 云同步。",
//       "col_title": "标题",
//       "col_body": "内容",
//       "col_note": "说明",
//       "col_id": "内部编号",
//       "empty_title": "还没有提示词模板",
//       "empty_sub": "打开 Wox 设置 → 插件 → 提示词，在模板表格里添加标题、内容和说明",
//       "action_copy": "复制到剪贴板",
//       "note_tag": "说明"
//     }
//   }
// }

// Two omissions are deliberate. Plugin Tools are not registered: they need
// MinWoxVersion 2.4.5 while a single-file plugin stays on the 2.4.2 floor, and a
// tool would let another plugin copy a template without anyone pressing Enter.
// No debounce either: the table is read from one setting and is small.

const SETTING_TEMPLATES = "templates"

const RESULT_ICON = {
  ImageType: "svg",
  ImageData:
    "<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'><rect width='48' height='48' rx='12' fill='#7c3aed'/><path d='M11 13a4 4 0 0 1 4-4h18a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H22l-7 6v-6a4 4 0 0 1-4-4z' fill='#f5f3ff'/><path d='M17 17h14M17 23h9' stroke='#7c3aed' stroke-width='2.5' stroke-linecap='round'/></svg>"
}

const ACTION_COPY_ICON = {
  ImageType: "svg",
  ImageData:
    "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='var(--wox-theme-icon-color)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='8' y='8' width='12' height='12' rx='2'/><path d='M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2'/></svg>"
}

// Kept separate from the display mapping so the id backfill can write every
// stored row back, including ones too malformed to show.
function readRows(raw) {
  if (!raw) return []
  try {
    const rows = JSON.parse(raw)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function toTemplates(rows) {
  const list = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    if (typeof row.title !== "string" || typeof row.body !== "string") continue
    const title = row.title.trim()
    if (!title) continue
    const note = typeof row.note === "string" ? row.note.trim() : ""
    const id = typeof row.id === "string" ? row.id.trim() : ""
    list.push({ id, title, note, body: row.body })
  }
  return list
}

function firstLine(body) {
  for (const line of body.split(/\r?\n/)) {
    const text = line.trim()
    if (text) return text
  }
  return ""
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

class PromptPlugin {
  async init(ctx, params) {
    this.api = params.API
    // Start-page MRU restore can run before the first query, and the restore
    // callback has no time to await a setting read, so seed the copy at load.
    await this.loadTemplates(ctx)
    if (typeof this.api.OnMRURestore === "function") {
      await this.api.OnMRURestore(ctx, async (_ctx, mruData) => this.restoreMRU(mruData))
    }
  }

  // Must return synchronously from the in-memory copy; Wox waits only 300ms.
  restoreMRU(mruData) {
    const data = (mruData && mruData.ContextData) || {}
    const tpl = data.id
      ? this.templates.find((t) => t.id === data.id)
      : this.templates.find((t) => t.title === data.title)
    return tpl ? this.templateResult(tpl) : null
  }

  async loadTemplates(ctx) {
    let raw = ""
    try {
      raw = await this.api.GetSetting(ctx, SETTING_TEMPLATES)
    } catch {
      raw = ""
    }
    const rows = readRows(raw)
    // New rows arrive without an id because the id column is hidden in the edit
    // dialog. Mint one for every row that lacks it, whatever the store does next:
    // the host keeps every action of the plugin in one map keyed by action Id, so
    // rows sharing an empty Id would steal each other's copy.
    let minted = false
    for (const row of rows) {
      if (!row || typeof row !== "object") continue
      if (typeof row.title !== "string" || !row.title.trim()) continue
      if (typeof row.id === "string" && row.id.trim()) continue
      row.id = crypto.randomUUID()
      minted = true
    }
    // Persisting the minted ids is best effort; the in-memory copy is already safe
    // for this session. SetSetting reports the failure, SaveSetting never did.
    if (minted) {
      const result = await this.api.SetSetting(ctx, {
        Key: SETTING_TEMPLATES,
        Value: JSON.stringify(rows),
        PlatformSpecific: false
      })
      if (!result || result.Success !== true) {
        const reason = result && result.ErrMsg ? result.ErrMsg : "no result"
        await this.api.Log(ctx, "Warning", `template ids not stored: ${reason}`)
      }
    }
    this.templates = toTemplates(rows)
    return this.templates
  }

  async query(ctx, query) {
    const templates = await this.loadTemplates(ctx)
    if (templates.length === 0) {
      return { Results: [this.emptyResult()] }
    }
    const search = (query.Search || "").trim().toLowerCase()
    const matched = search
      ? templates.filter(
          (t) =>
            t.title.toLowerCase().includes(search) ||
            t.note.toLowerCase().includes(search) ||
            t.body.toLowerCase().includes(search)
        )
      : templates
    return { Results: matched.map((t) => this.templateResult(t)) }
  }

  emptyResult() {
    return {
      Title: "i18n:empty_title",
      SubTitle: "i18n:empty_sub",
      Icon: RESULT_ICON,
      Actions: []
    }
  }

  // Action Ids are the host's only key for dispatch: it caches every action of
  // a plugin in one map, so a shared Id silently steals another row's copy, and
  // any space/slash from user text breaks core action lookup. The uuid is ASCII,
  // unique per row, and free of user text.
  templateResult(tpl) {
    const preview = {
      PreviewType: "markdown",
      PreviewData: tpl.body
    }
    if (tpl.note) {
      preview.PreviewTags = [{ Label: "i18n:note_tag", Tooltip: tpl.note }]
    }
    return {
      Title: tpl.title,
      SubTitle: tpl.note || clip(firstLine(tpl.body), 50),
      Icon: RESULT_ICON,
      IdentityKey: `prompt:${tpl.id}`,
      ContextData: { id: tpl.id, title: tpl.title },
      Preview: preview,
      Actions: [
        {
          Id: `copy-${tpl.id}`,
          Name: "i18n:action_copy",
          Icon: ACTION_COPY_ICON,
          IsDefault: true,
          ContextData: { id: tpl.id, title: tpl.title },
          Action: async (ctx) => {
            await this.api.Copy(ctx, { type: "text", text: tpl.body })
            await this.api.HideApp(ctx)
          }
        }
      ]
    }
  }
}

// The host extracts methods from the exported object and calls them without a
// receiver (wox.plugin.host.nodejs/src/jsonrpc.ts getMethod), so bind first.
const promptPlugin = new PromptPlugin()
promptPlugin.init = promptPlugin.init.bind(promptPlugin)
promptPlugin.query = promptPlugin.query.bind(promptPlugin)

module.exports.plugin = promptPlugin

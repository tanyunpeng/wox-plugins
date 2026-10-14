// The todo plugin. One native list, one refinement row above it: 状态. There is
// no preview pane (the list already shows every field) and no in-row control
// (Wox result icons are not clickable), so checking a task off is the Enter
// action and a toolbar button. Creating is a command — `td new ` or
// `td new 买牛奶`; editing is a one-field form and the due date is picked from
// result rows, because an action form cannot open a menu
// (ui/launcher/form_adapter.go:78 leaves openChoice unset). All of it stays on
// the panel: the data key is stored undeclared, rides Wox cloud sync, and the
// settings page stays empty.

const data = require("./data")
const icons = require("./icons")

const KEY_TASKS = "tasks"
const CMD_NEW = "new"
// Must match TriggerKeywords in plugin.json, and the trailing space is not
// decoration: Wox only reads a keyword (and a command) when the text contains a
// space (wox.core/plugin/query.go:634 `mustContainSpace`), so ChangeQuery("td") drops
// out of the plugin and fires a global search for "td" through every plugin.
// That is what killed the date picker: the leave callback cleared the state the
// picker had just set (host log 2026-10-14 18:47:04).
const TRIGGER = "td "
// How many days the picker lists. The launcher scrolls, but a row per day is
// the honest limit of "pick from the list" without a date control.
const DUE_DAYS = 14
// The create row is durable, like the note plugin's own, so MRU can bring it back.
const NEW_ROW = "new"
// Rows are ordered by score, one point per position (see `response`). The SDK
// documents Score as 0-100 (references/sdk_nodejs.md:77), so the base is the top
// of that range and the stamp clamps rather than going negative.
const SCORE_BASE = 100
// Strings the host does not run through its own i18n table (form field labels,
// a tail or subtitle that carries a value) are resolved once at init.
const LABEL_KEYS = ["field_task_title", "field_due", "badge_completed"]

// Chords follow the platform convention (references/hotkeys.md:5): the primary
// modifier, which is Ctrl on Windows/Linux and Command on macOS, never a bare
// Alt (Alt+1-9 is the launcher's own quick select). Primary+Enter is the one
// alternate the spec endorses for a plain result list, so the date picker takes
// it; the other two carry Shift because Ctrl+E and Ctrl+D are readline bindings
// in a text field (hotkeys.md tells us to prefer avoiding editor chords).
const PRIMARY = process.platform === "darwin" ? "cmd" : "ctrl"
const HOTKEY_DUE = `${PRIMARY}+enter`
const HOTKEY_EDIT = `${PRIMARY}+shift+e`
const HOTKEY_DELETE = `${PRIMARY}+shift+d`

class TodoPlugin {
  async init(ctx, params) {
    this.api = params.API
    this.cached = { tasks: [] }
    this.zh = false
    this.t = {}
    this.picker = null
    this.inCommand = false
    this.rawQuery = ""
    await this.load(ctx)
    this.zh = (await this.tr(ctx, "view_all")) === "全部"
    this.t = await this.formStrings(ctx)
    if (typeof this.api.OnMRURestore === "function") {
      await this.api.OnMRURestore(ctx, async (_ctx, mruData) => this.restoreMRU(mruData))
    }
    // A picker left open when the user walks away is stale the next time he
    // lands here; Wox fires this on a real plugin-context switch.
    if (typeof this.api.OnLeavePluginQuery === "function") {
      await this.api.OnLeavePluginQuery(ctx, async () => {
        this.picker = null
      })
    }
  }

  // Resolved once at init: core only runs `i18n:` through the plugin's table for
  // titles, subtitles, tails, preview tags and action names
  // (wox-src/core-manager.go:3376-3429), and the launcher form's own translator
  // is Wox-scoped, so a form field label or dropdown option must arrive already
  // readable.
  async formStrings(ctx) {
    const strings = {}
    for (const key of LABEL_KEYS) strings[key] = await this.tr(ctx, key)
    return strings
  }

  // Must return synchronously from the in-memory copy: Wox waits only 300 ms
  // and does not allow host API calls inside the restore callback, so the
  // restored row carries no preview.
  restoreMRU(mruData) {
    const id = mruData && mruData.ContextData ? mruData.ContextData.id : null
    if (!id) return null
    if (id === NEW_ROW) return this.newTaskRow("i18n:cmd_new_sub")
    const task = this.cached.tasks.find((t) => t.id === id)
    if (!task) return null
    return this.taskRow(task)
  }

  async query(ctx, query) {
    const state = await this.load(ctx)
    this.zh = (await this.tr(ctx, "view_all")) === "全部"
    const command = (query.Command || "").toLowerCase()
    const search = (query.Search || "").trim()
    this.rawQuery = query.RawQuery || ""
    const refinements = query.Refinements || {}
    const status = ["all", "pending", "done"].includes(refinements.status) ? refinements.status : "all"
    // Whether the next mutation has to leave the command to show its result.
    this.inCommand = command !== ""

    // The only command, and it owns the query: no filter chips here, and an
    // open date picker is over.
    if (command === CMD_NEW) {
      this.picker = null
      return this.response(this.newRows(state, search), [])
    }
    // While a picker is open it owns the list: every row is a choice.
    const picker = this.pickerRows(state, search)
    if (picker) return this.response(picker, [])
    const visible = this.visibleTasks(state, status, search)

    const rows = visible.map((t) => this.taskRow(t))
    // Only needed as a row when there is nothing to hang the toolbar buttons on.
    if (rows.length === 0) rows.push(this.newTaskRow("i18n:empty_sub"))
    return this.response(rows, [await this.statusRefinement(ctx, state.tasks, status)])
  }

  // The host re-sorts every response and breaks score ties by Title, then
  // SubTitle, then Id (core-manager.go:3062-3103), so returning rows in our own
  // order is not enough: the order has to be written into the score. Strictly
  // descending by index keeps 逾期 → 今天 → 明天 → 更晚 → 无截止 as we chose it,
  // and keeps two tasks with the same title from swapping places under the caret.
  response(rows, refinements) {
    rows.forEach((row, index) => {
      row.Score = Math.max(1, SCORE_BASE - index)
    })
    return { Results: rows, Refinements: refinements, Layout: { ResultPreviewWidthRatio: 0 } }
  }

  visibleTasks(state, status, search) {
    const needle = search.toLowerCase()
    return data
      .filterTasks(state.tasks, status)
      .filter((t) => !needle || t.title.toLowerCase().includes(needle))
  }

  // `td new 买牛奶` offers the typed text as a task; without text it is the
  // plain create form. The typed text never goes into an id: the host routes an
  // action by its id string, and a CJK space in it does not survive that trip —
  // the text belongs to ContextData, which does.
  newRows(state, search) {
    if (!search) return [this.newTaskRow("i18n:cmd_new_sub")]
    return [
      {
        // A row that only exists for the text typed right now: no IdentityKey,
        // so MRU cannot bring back a stale title (SKILL.md:57).
        Id: `todo:${NEW_ROW}`,
        Title: search,
        SubTitle: "i18n:cmd_new_sub",
        Icon: icons.RESULT_NEW_TASK,
        Actions: [
          {
            Id: "task-new-from-query",
            Name: "i18n:action_new_task",
            Icon: icons.ACTION_ADD,
            IsDefault: true,
            PreventHideAfterAction: true,
            ContextData: { title: search },
            Action: async (ctx, actionCtx) => {
              await this.createTask(ctx, actionCtx.ContextData.title)
            },
          },
        ],
      },
    ]
  }

  async load(ctx) {
    let tasksRaw = ""
    let readFailed = false
    try {
      tasksRaw = await this.api.GetSetting(ctx, KEY_TASKS)
    } catch (e) {
      // A failed read is not an empty list. Writing the parsed result of a
      // failed read back would delete every task, so the flag has to travel.
      readFailed = true
      await this.log(ctx, `setting read failed: ${e && e.message}`)
    }
    const taskRows = data.parseRows(tasksRaw)
    if (!readFailed && data.mintIds(taskRows)) await this.write(ctx, KEY_TASKS, taskRows)
    this.cached = { tasks: data.normalizeTasks(taskRows) }
    return { ...this.cached, taskRows, readFailed }
  }

  // The one way a mutation reaches storage: a list we could not read must never
  // be written back (that would store an empty array over every task), and a
  // write the host did not confirm must never be reported as success.
  async commit(ctx, state, rows) {
    if (state.readFailed || !(await this.write(ctx, KEY_TASKS, rows))) {
      await this.notify(ctx, "toast_save_failed")
      return false
    }
    return true
  }

  async loadForWrite(ctx) {
    const state = await this.load(ctx)
    if (state.readFailed) {
      await this.notify(ctx, "toast_save_failed")
      return null
    }
    return state
  }

  async statusRefinement(ctx, tasks, status) {
    return {
      Id: "status",
      Title: await this.tr(ctx, "filter_status"),
      Type: "singleSelect",
      // No Hotkey on purpose: the host renders the chord as a fourth chip in
      // the filter row, which reads as a bogus option.
      Hotkey: "",
      Persist: true,
      DefaultValue: [status],
      Options: [
        { Value: "all", Title: await this.tr(ctx, "view_all"), Count: data.countTasks(tasks, "all") },
        { Value: "pending", Title: await this.tr(ctx, "view_pending"), Count: data.countTasks(tasks, "pending") },
        { Value: "done", Title: await this.tr(ctx, "view_done"), Count: data.countTasks(tasks, "done") },
      ],
    }
  }

  // Synchronous on purpose: the MRU restore callback shares it and may not
  // await anything inside Wox's 300 ms budget. The leading icon only ever says
  // done or not done; the due state and the completion time are the tails, the
  // date is the subtitle.
  taskRow(task) {
    const today = data.localDate(new Date())
    // The due badge stays on a completed task: "今天截止" is still true after
    // it got checked off, and 逾期 is the reason it is still red.
    const status = data.dueStatus(task.due, today)
    const tails = []
    if (status === "overdue") tails.push({ Type: "text", Text: "i18n:badge_overdue", TextCategory: "danger" })
    else if (status === "today") tails.push({ Type: "text", Text: "i18n:badge_today", TextCategory: "warning" })
    if (task.done && task.doneAt) {
      tails.push({ Type: "text", Text: `${this.t.badge_completed} ${data.shortDateTime(task.doneAt)}` })
    }

    return {
      Id: `todo:task:${task.id}`,
      Title: task.title,
      SubTitle: task.due ? data.formatDue(task.due, today, this.zh) : "",
      Icon: task.done ? icons.RESULT_BOX_DONE : icons.RESULT_BOX_OPEN,
      Tails: tails,
      IdentityKey: `todo:task:${task.id}`,
      ContextData: { id: task.id },
      Actions: this.actionsFor(task),
    }
  }

  actionsFor(task) {
    // Creating is `td new`, so it is not a button on every row.
    return [this.toggleAction(task), this.dueAction(task), this.editAction(task), this.deleteAction(task)]
  }

  toggleAction(task) {
    return {
      Id: `toggle-${task.id}`,
      Name: task.done ? "i18n:action_reopen" : "i18n:action_complete",
      Icon: icons.ACTION_TOGGLE,
      IsDefault: true,
      PreventHideAfterAction: true,
      ShowInToolbar: true,
      ContextData: { id: task.id, done: String(!task.done) },
      Action: async (ctx, actionCtx) => {
        await this.setDone(ctx, actionCtx.ContextData, actionCtx.ResultId)
      },
    }
  }

  editAction(task) {
    return {
      Id: `edit-${task.id}`,
      Name: "i18n:action_edit",
      Icon: icons.ACTION_EDIT,
      Hotkey: HOTKEY_EDIT,
      // Panel only (his call, 2026-10-14): the toolbar keeps 勾选完成 and
      // 设置截止日期. The chord still works — a panel action keeps its hotkey
      // (wox.core/plugin/query.go:373-375).
      PreventHideAfterAction: true,
      Type: "form",
      Form: this.taskForm(task),
      ContextData: { id: task.id },
      OnSubmit: async (ctx, formCtx) => {
        await this.saveTask(ctx, formCtx.Values, task.id)
      },
    }
  }

  dueAction(task) {
    return {
      Id: `due-${task.id}`,
      Name: "i18n:action_pick_due",
      Icon: icons.ACTION_DUE,
      Hotkey: HOTKEY_DUE,
      ShowInToolbar: true,
      PreventHideAfterAction: true,
      ContextData: { id: task.id },
      Action: async (ctx, actionCtx) => {
        await this.enterPicker(ctx, actionCtx.ContextData.id)
      },
    }
  }

  deleteAction(task) {
    return {
      Id: `delete-${task.id}`,
      Name: "i18n:action_delete",
      Icon: icons.ACTION_DELETE,
      Hotkey: HOTKEY_DELETE,
      // Off the toolbar again (2026-10-14): it deletes without a confirmation, so
      // it lives in the action panel (Ctrl+K), where it takes two deliberate
      // steps. The chord still works — a panel action keeps its hotkey
      // (wox.core/plugin/query.go:373-375).
      PreventHideAfterAction: true,
      ContextData: { id: task.id },
      Action: async (ctx, actionCtx) => {
        await this.deleteTask(ctx, actionCtx.ContextData.id)
      },
    }
  }

  newTaskRow(subtitle) {
    return {
      Title: "i18n:action_new_task",
      SubTitle: subtitle,
      Icon: icons.RESULT_NEW_TASK,
      IdentityKey: `todo:${NEW_ROW}`,
      ContextData: { id: NEW_ROW },
      Actions: [this.newTaskAction()],
    }
  }

  newTaskAction() {
    return {
      Id: "task-new",
      Name: "i18n:action_new_task",
      Icon: icons.ACTION_ADD,
      PreventHideAfterAction: true,
      // MRU reads the restore identity from the action's ContextData (SKILL.md:68).
      ContextData: { id: NEW_ROW },
      Type: "form",
      Form: this.taskForm(null),
      OnSubmit: async (ctx, formCtx) => {
        await this.saveTask(ctx, formCtx.Values, null)
      },
    }
  }

  // --- due date picker --------------------------------------------------
  // The choices are drawn as the result list itself: the launcher gives a row
  // an icon, a title and a subtitle, which is as close to a date menu as a
  // plugin can get. Enter writes the date and returns to the list.

  pickerRows(state, search) {
    if (!this.picker) return null
    const task = state.tasks.find((t) => t.id === this.picker)
    if (!task) {
      this.picker = null
      return null
    }
    const today = data.localDate(new Date())
    const rows = [this.backRow(task)]
    const needle = search.toLowerCase()
    for (const choice of data.dueChoices(today, this.zh, DUE_DAYS)) {
      // A row set that ignores the input would let him type and see nothing
      // happen, so the typed text narrows the choices instead.
      const haystack = `${choice.Label} ${choice.SubLabel} ${choice.Value}`.toLowerCase()
      if (!needle || haystack.includes(needle)) rows.push(this.dueRow(task, choice))
    }
    return rows
  }

  backRow(task) {
    return {
      Id: "todo:due:back",
      Title: "i18n:action_back",
      SubTitle: `${task.title} · ${this.t.field_due}`,
      Icon: icons.RESULT_BACK,
      Actions: [
        {
          Id: "due-back",
          Name: "i18n:action_back",
          Icon: icons.ACTION_BACK,
          IsDefault: true,
          PreventHideAfterAction: true,
          Action: async (ctx) => {
            this.picker = null
            await this.api.RefreshQuery(ctx, { PreserveSelectedIndex: false })
          },
        },
      ],
    }
  }

  dueRow(task, choice) {
    const id = `todo:due:${choice.Value || "none"}`
    return {
      Id: id,
      Title: choice.Label,
      SubTitle: choice.SubLabel,
      Icon: choice.Value ? icons.RESULT_DATE : icons.RESULT_NO_DATE,
      Actions: [
        {
          Id: `due-apply-${choice.Value || "none"}`,
          Name: "i18n:action_use_date",
          Icon: icons.ACTION_DUE,
          IsDefault: true,
          PreventHideAfterAction: true,
          ContextData: { taskId: task.id, due: choice.Value },
          Action: async (ctx, actionCtx) => {
            await this.applyDue(ctx, actionCtx.ContextData)
          },
        },
      ],
    }
  }

  // One level deep on purpose: the list is repainted instead of a second dialog
  // opening over it. When the input already is the bare keyword a refresh is
  // enough; ChangeQuery with the same text the host may treat as no change at
  // all. Any filter text or command has to go, because the picker ignores it.
  async enterPicker(ctx, id) {
    this.picker = id
    await this.showPicker(ctx)
  }

  async showPicker(ctx) {
    if (this.rawQuery === TRIGGER) {
      await this.api.RefreshQuery(ctx, { PreserveSelectedIndex: false })
      return
    }
    await this.api.ChangeQuery(ctx, { QueryType: "input", QueryText: TRIGGER })
  }

  // --- form ------------------------------------------------------------

  // One level, no nested dialog: only the text is typed here. normalizeDue
  // still reads 今天 / 10.18 for rows written while the date was a text box.
  taskForm(task) {
    return [
      {
        Type: "textbox",
        Value: {
          Key: "title",
          Label: this.t.field_task_title,
          DefaultValue: task ? task.title : "",
          Tooltip: "",
          MaxLines: 1,
          Validators: [{ Type: "not_empty", Value: {} }],
        },
      },
    ]
  }

  // --- mutations -------------------------------------------------------

  async setDone(ctx, values, resultId) {
    const state = await this.loadForWrite(ctx)
    if (!state) return
    const row = state.taskRows.find((r) => r && r.id === values.id)
    if (!row) return
    row.done = values.done === "true"
    row.doneAt = row.done ? data.localDateTime(new Date()) : ""
    if (!(await this.commit(ctx, state, state.taskRows))) return
    await this.notify(ctx, row.done ? "toast_task_done" : "toast_task_reopened")
    // Checking a task off no longer moves the row (a completed task keeps the
    // place its own date gives it), so only the paint changes: SKILL.md:59 says
    // repaint a visible row with UpdateResult and keep RefreshQuery for when
    // rows are added or removed. The host translates Title/SubTitle/Tails and
    // action names on this path too (core-manager.go:3802-3945).
    const task = data.normalizeTasks([row])[0]
    const { Icon, Tails, Actions } = this.taskRow(task)
    await this.api.UpdateResult(ctx, { Id: resultId, Icon, Tails, Actions })
  }

  async applyDue(ctx, values) {
    this.picker = null
    const state = await this.loadForWrite(ctx)
    if (!state) return
    const row = state.taskRows.find((r) => r && r.id === values.taskId)
    if (!row) {
      await this.api.RefreshQuery(ctx, { PreserveSelectedIndex: false })
      return
    }
    row.due = values.due || ""
    if (!(await this.commit(ctx, state, state.taskRows))) return
    await this.notify(ctx, "toast_due_set")
    // Back to the list, with the task that was just changed under the caret.
    await this.api.RefreshQuery(ctx, {
      PreserveSelectedIndex: false,
      SelectedResultId: `todo:task:${row.id}`,
    })
  }

  async deleteTask(ctx, id) {
    const state = await this.loadForWrite(ctx)
    if (!state) return
    const kept = data.removeRow(state.taskRows, id)
    if (kept.length === state.taskRows.length) return
    if (!(await this.commit(ctx, state, kept))) return
    await this.notify(ctx, "toast_task_deleted")
    await this.api.RefreshQuery(ctx, { PreserveSelectedIndex: false })
  }

  async createTask(ctx, title) {
    const text = data.text(title)
    if (!text) return
    const state = await this.loadForWrite(ctx)
    if (!state) return
    const row = { id: crypto.randomUUID(), title: text, due: "", done: false, doneAt: "" }
    if (!(await this.commit(ctx, state, data.upsert(state.taskRows, row)))) return
    await this.afterCreate(ctx, row.id)
  }

  // A create pressed inside `td new` has to leave the command: a refresh there
  // repaints the very create row that was just used, so the task is stored and
  // the screen never moves (his "新增任务没有响应", 2026-10-14).
  async afterCreate(ctx, id) {
    await this.notify(ctx, "toast_task_created")
    if (this.inCommand) await this.api.ChangeQuery(ctx, { QueryType: "input", QueryText: TRIGGER })
    await this.api.RefreshQuery(ctx, {
      PreserveSelectedIndex: false,
      SelectedResultId: `todo:task:${id}`,
    })
  }

  async saveTask(ctx, values, id) {
    const title = data.text(values.title)
    if (!title) return
    const state = await this.loadForWrite(ctx)
    if (!state) return
    const existing = id ? state.taskRows.find((r) => r && r.id === id) : null
    const row = {
      id: existing ? existing.id : crypto.randomUUID(),
      title,
      // The form has no date field; the picker owns it, so an edit must not
      // drop the date that is already on the task.
      due: existing ? data.normalizeDue(data.text(existing.due)) : "",
      done: existing ? existing.done === true : false,
      // Editing must not lose when the task was checked off; the tail only
      // renders on a done row anyway.
      doneAt: existing ? String(existing.doneAt || "") : "",
    }
    if (!(await this.commit(ctx, state, data.upsert(state.taskRows, row)))) return
    if (existing) {
      await this.api.RefreshQuery(ctx, {
        PreserveSelectedIndex: false,
        SelectedResultId: `todo:task:${row.id}`,
      })
    } else {
      await this.afterCreate(ctx, row.id)
    }
  }

  // --- plumbing --------------------------------------------------------

  // True only when the host confirmed the write: a plugin `Log` never reaches
  // wox.log, so a silent failure must not be reported to the user as a success.
  async write(ctx, key, rows) {
    const result = await this.api.SetSetting(ctx, {
      Key: key,
      Value: JSON.stringify(rows),
      PlatformSpecific: false,
    })
    if (!result || result.Success !== true) {
      const reason = result && result.ErrMsg ? result.ErrMsg : "no result"
      await this.log(ctx, `${key} not stored: ${reason}`)
      return false
    }
    return true
  }

  async tr(ctx, key) {
    try {
      const value = await this.api.GetTranslation(ctx, key)
      return value || key
    } catch {
      return key
    }
  }

  async notify(ctx, key) {
    try {
      await this.api.Notify(ctx, await this.tr(ctx, key))
    } catch (e) {
      await this.log(ctx, `notify failed: ${e && e.message}`)
    }
  }

  async log(ctx, message) {
    try {
      await this.api.Log(ctx, "Warning", message)
    } catch {
      // logging must never be the reason an action fails
    }
  }
}

const plugin = new TodoPlugin()
plugin.init = plugin.init.bind(plugin)
plugin.query = plugin.query.bind(plugin)

module.exports = { plugin, TodoPlugin }

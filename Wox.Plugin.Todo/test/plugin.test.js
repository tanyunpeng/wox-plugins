// Behaviour tests against a fake host API: filter semantics, ordering, the
// row shape, the action layout, the add/edit commands, MRU restore, and every
// panel mutation writing the data key back.

const test = require("node:test")
const assert = require("node:assert")

const { TodoPlugin } = require("../src/plugin")
const data = require("../src/data")
const icons = require("../src/icons")

// Dates are relative to the real clock: the plugin reads the system date, so
// a hardcoded date would turn these tests red tomorrow.
const TODAY = data.localDate(new Date())
const PRIMARY = process.platform === "darwin" ? "cmd" : "ctrl"
const WEEK_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
const WEEKDAY = (date) => {
  const [y, m, d] = date.split("-").map(Number)
  return WEEK_ZH[new Date(y, m - 1, d).getDay()]
}
const TASKS = [
  { id: "t-later", title: "悬浮球设计", due: data.addDays(TODAY, 6), done: false },
  { id: "t-overdue", title: "月度更新", due: data.addDays(TODAY, -4), done: false },
  { id: "t-today", title: "海外产品设计", due: TODAY, done: false },
  { id: "t-none", title: "开发者工具氛围感", due: "", done: false },
  { id: "t-done", title: "周报", due: data.addDays(TODAY, -13), done: true, doneAt: `${TODAY} 09:32` },
]

const ZH = {
  view_all: "全部",
  view_pending: "待处理",
  view_done: "已完成",
  filter_status: "状态",
  badge_overdue: "逾期",
  badge_today: "今天",
  badge_completed: "完成于",
  toast_task_created: "任务已创建",
  empty_sub: "还没有任务",
  action_new_task: "新建任务",
  field_task_title: "待办内容",
  field_due: "截止日期",
}

function makeApi(overrides = {}) {
  const calls = { set: [], refresh: [], update: [], notify: [], log: [], change: [] }
  const api = {
    calls,
    settings: {
      tasks: JSON.stringify(TASKS),
    },
    async GetSetting(_ctx, key) {
      return api.settings[key] ?? ""
    },
    async SetSetting(_ctx, opt) {
      calls.set.push(opt)
      api.settings[opt.Key] = opt.Value
      return { Success: true }
    },
    async GetTranslation(_ctx, key) {
      return ZH[key] ?? key
    },
    async OnMRURestore(_ctx, cb) {
      api.mruCallback = cb
    },
    async RefreshQuery(_ctx, param) {
      calls.refresh.push(param)
    },
    async ChangeQuery(_ctx, param) {
      calls.change.push(param)
    },
    async UpdateResult(_ctx, result) {
      calls.update.push(result)
      return api.visibleIds === undefined || api.visibleIds.includes(result.Id)
    },
    async OnLeavePluginQuery(_ctx, cb) {
      api.leaveCallback = cb
    },
    async Notify(_ctx, text) {
      calls.notify.push(text)
    },
    async Log(_ctx, level, text) {
      calls.log.push(text)
    },
  }
  return Object.assign(api, overrides)
}

async function run(api, refinements = {}, query = {}) {
  const plugin = new TodoPlugin()
  await plugin.init({}, { API: api })
  const response = await plugin.query({}, { Search: "", Refinements: refinements, ...query })
  return { plugin, api, response, titles: response.Results.map((r) => r.Title) }
}

const taskRows = (response) => response.Results.filter((r) => r.IdentityKey?.startsWith("todo:task:"))
const titles = (response) => taskRows(response).map((r) => r.Title)
const action = (row, name) => row.Actions.find((a) => a.Name === name)
const rowOf = (response, title) => taskRows(response).find((r) => r.Title === title)

// The host re-sorts every response and breaks score ties by Title, then
// SubTitle, then Id (core-manager.go:3062-3103). Rehearse that here: a plugin
// that only orders its own array looks right in the tests and is not in the
// launcher, which is how the same-title tasks used to swap places.
const hostOrder = (rows) =>
  [...rows]
    .sort((a, b) => b.Score - a.Score || (a.Title < b.Title ? -1 : a.Title > b.Title ? 1 : 0))
    .map((r) => r.Title)

const DUPLICATES = [
  { id: "d-1", title: "吃饭", due: "", done: false, doneAt: "" },
  { id: "d-2", title: "吃饭", due: "", done: false, doneAt: "" },
  { id: "d-3", title: "吃饭", due: "", done: true, doneAt: `${TODAY} 09:00` },
]

test("the default view is 全部: a completed task keeps the place its date gives it", async () => {
  const { response } = await run(makeApi())
  assert.deepEqual(titles(response), ["周报", "月度更新", "海外产品设计", "悬浮球设计", "开发者工具氛围感"])
})

test("待处理 hides the completed tasks", async () => {
  const { response } = await run(makeApi(), { status: "pending" })
  assert.deepEqual(titles(response), ["月度更新", "海外产品设计", "悬浮球设计", "开发者工具氛围感"])
})

test("one refinement only: 状态, three options, no hotkey chip, no preview pane", async () => {
  const { response } = await run(makeApi())
  assert.equal(response.Refinements.length, 1)
  const status = response.Refinements[0]
  assert.equal(status.Id, "status")
  assert.equal(status.Title, "状态")
  assert.equal(status.Hotkey, "")
  assert.equal(status.Persist, true)
  assert.equal(status.DefaultValue[0], "all")
  assert.deepEqual(status.Options.map((o) => [o.Value, o.Title, o.Count]), [
    ["all", "全部", 5],
    ["pending", "待处理", 4],
    ["done", "已完成", 1],
  ])
  assert.equal(response.Layout.ResultPreviewWidthRatio, 0)
})

test("an unknown status value falls back to 全部", async () => {
  const { response } = await run(makeApi(), { status: "bogus" })
  assert.equal(response.Refinements[0].DefaultValue[0], "all")
  assert.equal(titles(response).length, 5)
})

test("rows carry no preview and no checkbox-looking icon", async () => {
  const { response } = await run(makeApi())
  for (const row of taskRows(response)) {
    assert.equal(row.Preview, undefined, row.Title)
    assert.ok(row.Icon.ImageData.includes("<circle"), "status marks are circles, not checkboxes")
  }
})

test("row fields: subtitle is the date, tails are the due badge", async () => {
  const { response } = await run(makeApi())
  const due = data.addDays(TODAY, -4).split("-")
  const overdue = rowOf(response, "月度更新")
  assert.equal(overdue.SubTitle, `${Number(due[1])}月${Number(due[2])}日`)
  assert.deepEqual(overdue.Tails, [{ Type: "text", Text: "i18n:badge_overdue", TextCategory: "danger" }])

  const [, m, d] = TODAY.split("-")
  const today = rowOf(response, "海外产品设计")
  assert.equal(today.SubTitle, `${Number(m)}月${Number(d)}日`)
  assert.deepEqual(today.Tails, [{ Type: "text", Text: "i18n:badge_today", TextCategory: "warning" }])

  const free = rowOf(response, "开发者工具氛围感")
  assert.equal(free.SubTitle, "")
  assert.deepEqual(free.Tails, [])
})

test("the 已完成 view leads with the most recent completion", async () => {
  const api = makeApi({
    settings: {
      tasks: JSON.stringify([
        { id: "d-a", title: "早完成", due: data.addDays(TODAY, -9), done: true, doneAt: `${TODAY} 08:00` },
        { id: "d-b", title: "晚完成", due: data.addDays(TODAY, -2), done: true, doneAt: `${TODAY} 18:30` },
        { id: "d-c", title: "中午完成", due: data.addDays(TODAY, -30), done: true, doneAt: `${TODAY} 12:00` },
        // A row written before completion times existed: no doneAt, so it lands
        // at the end instead of pretending to be the newest.
        { id: "d-d", title: "没有时间戳", due: "", done: true },
      ]),
    },
  })
  const { response } = await run(api, { status: "done" })
  assert.deepEqual(hostOrder(response.Results), ["晚完成", "中午完成", "早完成", "没有时间戳"])
  assert.equal(response.Refinements[0].DefaultValue[0], "done")

  // 全部 keeps ordering by date, because there the pending rows compete.
  const all = await run(makeApi())
  assert.deepEqual(hostOrder(all.response.Results), titles(all.response))
})

test("a completed task keeps its due badge and shows when it was checked off", async () => {
  const { api, response } = await run(makeApi())
  const done = rowOf(response, "周报")
  assert.deepEqual(done.Tails, [
    { Type: "text", Text: "i18n:badge_overdue", TextCategory: "danger" },
    { Type: "text", Text: `完成于 ${data.shortDateTime(`${TODAY} 09:32`)}` },
  ])
  assert.equal(done.Icon, icons.RESULT_BOX_DONE)

  await done.Actions[0].Action({}, { ContextData: done.Actions[0].ContextData })
  const reopened = JSON.parse(api.settings.tasks).find((t) => t.id === "t-done")
  assert.equal(reopened.done, false)
  assert.equal(reopened.doneAt, "", "reopening clears the completion time")
})

test("the launcher keeps our order: overdue, today, tomorrow, later, no date last", async () => {
  const api = makeApi({
    settings: {
      tasks: JSON.stringify([
        { id: "x-none", title: "无期限", due: "", done: false },
        { id: "x-later", title: "更晚", due: data.addDays(TODAY, 30), done: false },
        { id: "x-over", title: "逾期", due: data.addDays(TODAY, -2), done: false },
        { id: "x-tom", title: "明天", due: data.addDays(TODAY, 1), done: false },
        { id: "x-today", title: "今天", due: TODAY, done: false },
      ]),
    },
  })
  const { response } = await run(api)
  assert.deepEqual(hostOrder(response.Results), ["逾期", "今天", "明天", "更晚", "无期限"])
  assert.ok(
    response.Results.every((r, i) => i === 0 || r.Score < response.Results[i - 1].Score),
    "scores are strictly descending, so no tie is left for the host to break by title"
  )
})

test("same-title tasks stay distinguishable: unique ids, own row selected after a toggle", async () => {
  const api = makeApi({ settings: { tasks: JSON.stringify(DUPLICATES) } })
  const { response } = await run(api)
  const rows = taskRows(response)
  assert.deepEqual(hostOrder(rows), ["吃饭", "吃饭", "吃饭"], "the host cannot shuffle them by title into one blob")
  assert.deepEqual(new Set(rows.map((r) => r.IdentityKey)).size, 3)
  assert.deepEqual(new Set(rows.map((r) => r.Id)).size, 3, "SelectedResultId needs a per-row id")

  const second = rows[1]
  await second.Actions[0].Action({}, { ContextData: second.Actions[0].ContextData, ResultId: second.Id })
  assert.deepEqual(JSON.parse(api.settings.tasks).map((t) => [t.id, t.done]), [["d-1", false], ["d-2", true], ["d-3", true]])
  assert.equal(api.calls.update[0].Id, "todo:task:d-2", "the paint lands on the row that was pressed")
})

test("the toolbar keeps 勾选完成 and 设置截止日期; edit and delete stay in the panel", async () => {
  const { response } = await run(makeApi())
  const row = rowOf(response, "月度更新")
  assert.deepEqual(
    row.Actions.map((a) => [a.Name, a.ShowInToolbar === true, a.Hotkey || (a.IsDefault ? "Enter" : "")]),
    [
      ["i18n:action_complete", true, "Enter"],
      ["i18n:action_pick_due", true, `${PRIMARY}+enter`],
      ["i18n:action_edit", false, `${PRIMARY}+shift+e`],
      ["i18n:action_delete", false, `${PRIMARY}+shift+d`],
    ]
  )
  assert.equal(row.Actions[0].IsDefault, true)
  assert.equal(row.Actions[0].PreventHideAfterAction, true)
  assert.equal(action(row, "i18n:action_new_task"), undefined, "creation is the td new command")
})

test("td new <text> stores the task and leaves the command, or nothing moves", async () => {
  const { api, response } = await run(makeApi(), {}, { Command: "new", Search: "买牛奶" })
  assert.deepEqual(response.Refinements, [], "the command owns the query")
  assert.deepEqual(
    response.Results.map((r) => [r.Title, r.SubTitle]),
    [["买牛奶", "i18n:cmd_new_sub"]]
  )
  const created = response.Results[0].Actions[0]
  assert.equal(created.IsDefault, true)
  assert.ok(/^[\w-]+$/.test(created.Id), "an action id carries no user text: " + created.Id)
  await created.Action({}, { ContextData: created.ContextData })
  const saved = JSON.parse(api.settings.tasks).find((t) => t.title === "买牛奶")
  assert.deepEqual([saved.due, saved.done], ["", false])
  // The refresh alone repaints the same create row, which is why Enter looked
  // like it did nothing while the task was in fact stored.
  assert.deepEqual(api.calls.change, [{ QueryType: "input", QueryText: "td " }])
  assert.deepEqual(api.calls.notify, ["任务已创建"])
  assert.equal(api.calls.refresh.at(-1).SelectedResultId, `todo:task:${saved.id}`)
})

test("td new without text is the durable create row, like the note plugin's", async () => {
  const { response } = await run(makeApi(), {}, { Command: "new", Search: "" })
  const row = response.Results[0]
  assert.deepEqual([row.Title, row.SubTitle, row.IdentityKey, row.Score], ["i18n:action_new_task", "i18n:cmd_new_sub", "todo:new", 100])
  assert.equal(action(row, "i18n:action_new_task").Type, "form")
})

test("the task form is one box: the date is picked from the list, not typed", async () => {
  const { response } = await run(makeApi(), {}, { Command: "new", Search: "" })
  const form = action(response.Results[0], "i18n:action_new_task").Form
  assert.deepEqual(
    form.map((f) => [f.Value.Key, f.Type, f.Value.Label]),
    [["title", "textbox", "待办内容"]]
  )
  assert.equal(form[0].Value.Validators.length, 1, "the title is required")
  assert.equal(form[0].Value.DefaultValue, "", "creating starts blank")
  assert.ok(!JSON.stringify(form).includes("i18n:"), "the host does not translate inside a form")
})

test("editing prefills the title", async () => {
  const { response } = await run(makeApi())
  const form = action(rowOf(response, "月度更新"), "i18n:action_edit").Form
  assert.deepEqual(form.map((f) => f.Value.DefaultValue), ["月度更新"])
})

test("the form writes the title and leaves the stored date alone", async () => {
  const { api, response } = await run(makeApi())
  const edit = action(rowOf(response, "月度更新"), "i18n:action_edit")
  await edit.OnSubmit({}, { Values: { title: " 改过的标题 " } })
  const edited = JSON.parse(api.settings.tasks).find((t) => t.id === "t-overdue")
  assert.deepEqual([edited.title, edited.due], ["改过的标题", data.addDays(TODAY, -4)])
  assert.equal(api.calls.refresh.at(-1).SelectedResultId, "todo:task:t-overdue")

  await edit.OnSubmit({}, { Values: { title: "" } })
  assert.equal(api.calls.set.filter((c) => c.Key === "tasks").length, 1, "an empty title writes nothing")
})

test("设置截止日期 is a toolbar action that repaints the list", async () => {
  const { api, response } = await run(makeApi())
  const row = rowOf(response, "月度更新")
  const due = action(row, "i18n:action_pick_due")
  assert.equal(due.ShowInToolbar, true)
  assert.equal(due.Type, undefined)
  assert.equal(due.PreventHideAfterAction, true)

  await due.Action({}, { ContextData: due.ContextData })
  assert.deepEqual(api.calls.change, [{ QueryType: "input", QueryText: "td " }], "the trailing space keeps it a keyword query")
})

test("the keyword he typed is the one ChangeQuery writes back", async () => {
  const api = makeApi()
  const plugin = new TodoPlugin()
  await plugin.init({}, { API: api })

  const list = await plugin.query({}, { TriggerKeyword: "todo", RawQuery: "todo 月度", Search: "月度", Refinements: {} })
  const due = action(rowOf(list, "月度更新"), "i18n:action_pick_due")
  await due.Action({}, { ContextData: due.ContextData })
  assert.deepEqual(api.calls.change, [{ QueryType: "input", QueryText: "todo " }], "the picker keeps his keyword")

  api.calls.change.length = 0
  const command = await plugin.query({}, { TriggerKeyword: "todo", Command: "new", Search: "买牛奶", Refinements: {} })
  const create = command.Results[0].Actions[0]
  await create.Action({}, { ContextData: create.ContextData })
  assert.deepEqual(api.calls.change, [{ QueryType: "input", QueryText: "todo " }], "leaving the command keeps his keyword")
})

test("entering the picker from the bare keyword only refreshes the list", async () => {
  const api = makeApi()
  const plugin = new TodoPlugin()
  await plugin.init({}, { API: api })
  const response = await plugin.query({}, { RawQuery: "td ", Search: "", Refinements: {} })
  const due = action(rowOf(response, "月度更新"), "i18n:action_pick_due")
  await due.Action({}, { ContextData: due.ContextData })
  assert.deepEqual(api.calls.change, [], "ChangeQuery with the same text the host may ignore")
  assert.deepEqual(api.calls.refresh, [{ PreserveSelectedIndex: false }])
  const rows = await plugin.query({}, { RawQuery: "td ", Search: "", Refinements: {} })
  assert.equal(rows.Results[0].Title, "i18n:action_back", "the picker is on screen")
})

test("the picker repaints the list as date rows, 返回 first", async () => {
  const { plugin, response } = await run(makeApi())
  const due = action(rowOf(response, "月度更新"), "i18n:action_pick_due")
  await due.Action({}, { ContextData: due.ContextData })
  const second = await plugin.query({}, { RawQuery: "td", Search: "", Refinements: {} })
  const rows = second.Results
  assert.equal(rows[0].Title, "i18n:action_back")
  assert.equal(rows[0].SubTitle, "月度更新 · 截止日期")
  assert.equal(rows[0].Icon, icons.RESULT_BACK)

  const choices = rows.slice(1)
  assert.equal(choices[0].Title, "无截止时间", "clearing the date is the first choice")
  assert.equal(choices[0].Icon, icons.RESULT_NO_DATE)
  assert.deepEqual(choices.slice(1, 4).map((r) => r.Title), ["今天", "明天", "后天"])
  assert.equal(choices[1].SubTitle, `${WEEKDAY(TODAY)} · ${TODAY}`)
  assert.ok(choices.every((r) => r.Icon === (r.Id === "todo:due:none" ? icons.RESULT_NO_DATE : icons.RESULT_DATE)))
  assert.equal(choices.length, 15, "no date plus two weeks")
  assert.equal(new Set(choices.map((r) => r.Id)).size, choices.length)
  assert.ok(choices.every((r) => !r.IdentityKey), "picker rows are temporary: no IdentityKey for MRU to restore (SKILL.md:57)")
  assert.deepEqual(hostOrder(rows), rows.map((r) => r.Title), "the scores hold the picker's own order")
  assert.ok(!choices.some((r) => r.Actions[0].ContextData.due && r.Actions[0].ContextData.due < TODAY), "no past dates to pick")
  assert.deepEqual(second.Refinements, [], "the picker owns the query")
})

test("entering a date writes it, leaves the picker and selects the task", async () => {
  const { api, plugin, response } = await run(makeApi())
  const due = action(rowOf(response, "月度更新"), "i18n:action_pick_due")
  await due.Action({}, { ContextData: due.ContextData })
  const rows = (await plugin.query({}, { RawQuery: "td", Search: "", Refinements: {} })).Results
  const tomorrow = rows.find((r) => r.Title === "明天")
  assert.equal(tomorrow.Actions.length, 1)
  assert.equal(tomorrow.Actions[0].IsDefault, true)
  assert.equal(tomorrow.Actions[0].Name, "i18n:action_use_date")

  await tomorrow.Actions[0].Action({}, { ContextData: tomorrow.Actions[0].ContextData })
  assert.equal(plugin.picker, null, "the picker closes after one choice")
  assert.equal(JSON.parse(api.settings.tasks).find((t) => t.id === "t-overdue").due, data.addDays(TODAY, 1))
  assert.deepEqual(api.calls.notify, ["toast_due_set"])
  assert.deepEqual(api.calls.refresh.at(-1), { PreserveSelectedIndex: false, SelectedResultId: "todo:task:t-overdue" })

  const list = await plugin.query({}, { RawQuery: "td", Search: "", Refinements: {} })
  assert.equal(list.Results.every((r) => r.IdentityKey.startsWith("todo:task:")), true, "the list is back")
})

test("choosing 无截止时间 clears the date", async () => {
  const { api, plugin, response } = await run(makeApi())
  const due = action(rowOf(response, "月度更新"), "i18n:action_pick_due")
  await due.Action({}, { ContextData: due.ContextData })
  const rows = (await plugin.query({}, { RawQuery: "td", Search: "", Refinements: {} })).Results
  await rows[1].Actions[0].Action({}, { ContextData: rows[1].Actions[0].ContextData })
  assert.equal(JSON.parse(api.settings.tasks).find((t) => t.id === "t-overdue").due, "")
})

test("返回 closes the picker without writing", async () => {
  const { api, plugin, response } = await run(makeApi())
  const due = action(rowOf(response, "月度更新"), "i18n:action_pick_due")
  await due.Action({}, { ContextData: due.ContextData })
  const rows = (await plugin.query({}, { RawQuery: "td", Search: "", Refinements: {} })).Results
  await rows[0].Actions[0].Action({}, { ContextData: {} })
  assert.equal(plugin.picker, null)
  assert.deepEqual(api.calls.set, [], "back writes nothing")
  const list = await plugin.query({}, { RawQuery: "td", Search: "", Refinements: {} })
  assert.deepEqual(titles(list), ["周报", "月度更新", "海外产品设计", "悬浮球设计", "开发者工具氛围感"])
})

test("a picker is dropped when its task is gone or a command is typed", async () => {
  const plugin = new TodoPlugin()
  await plugin.init({}, { API: makeApi() })
  plugin.picker = "t-overdue"
  await plugin.query({}, { RawQuery: "td", Search: "", Refinements: {} })
  assert.equal(plugin.picker, "t-overdue")

  await plugin.query({}, { RawQuery: "td new", Command: "new", Search: "", Refinements: {} })
  assert.equal(plugin.picker, null, "a command ends the picker")

  plugin.picker = "t-gone"
  const rows = await plugin.query({}, { RawQuery: "td", Search: "", Refinements: {} })
  assert.equal(plugin.picker, null)
  assert.equal(titles(rows)[0], "周报")

  plugin.picker = "t-overdue"
  await plugin.api.leaveCallback({}, {})
  assert.equal(plugin.picker, null, "leaving the plugin drops stale state")
})

test("date rows are named for the next days and dated for the rest", () => {
  const choices = data.dueChoices(TODAY, true, 4)
  assert.deepEqual(choices.map((c) => c.Value), ["", TODAY, data.addDays(TODAY, 1), data.addDays(TODAY, 2), data.addDays(TODAY, 3)])
  assert.deepEqual(choices.map((c) => c.Label), ["无截止时间", "今天", "明天", "后天", choices[4].Label])
  assert.equal(choices[4].Label, data.formatDue(choices[4].Value, TODAY, true))
  assert.ok(choices[1].SubLabel.startsWith(WEEKDAY(TODAY)))
  assert.ok(!choices[0].SubLabel, "the clear row has no date to describe")
  assert.equal(data.dueChoices(TODAY, false, 1)[1].Label, "Today")
})


test("an edit keeps the completion state of a done task", async () => {
  const { api, response } = await run(makeApi(), { status: "done" })
  const row = taskRows(response)[0]
  const due = data.addDays(TODAY, -13)
  await action(row, "i18n:action_edit").OnSubmit({}, { Values: { title: "周报" } })
  const saved = JSON.parse(api.settings.tasks).find((t) => t.id === "t-done")
  assert.deepEqual([saved.due, saved.done], [due, true], "an edit keeps both the date and the check")
  assert.equal(saved.doneAt, `${TODAY} 09:32`)
})

test("an empty list leaves one row that creates a task", async () => {
  const { response, titles } = await run(makeApi({ settings: {} }))
  assert.deepEqual(titles, ["i18n:action_new_task"])
  assert.equal(response.Results[0].SubTitle, "i18n:empty_sub")
  assert.deepEqual(response.Results[0].Actions.map((a) => a.Name), ["i18n:action_new_task"])
})

test("search filters inside the current selection", async () => {
  const { response } = await run(makeApi(), { status: "all" }, { Search: "设计" })
  assert.deepEqual(titles(response), ["海外产品设计", "悬浮球设计"])
})

test("勾选完成 repaints the row in place instead of reloading the list", async () => {
  const { api, response } = await run(makeApi())
  const row = rowOf(response, "月度更新")
  await row.Actions[0].Action({}, { ContextData: row.Actions[0].ContextData, ResultId: row.Id })
  assert.equal(JSON.parse(api.settings.tasks).find((t) => t.id === "t-overdue").done, true)
  assert.deepEqual(api.calls.notify, ["toast_task_done"])
  assert.deepEqual(api.calls.refresh, [], "SKILL.md:59: RefreshQuery is for rows added or removed")
  assert.deepEqual(api.calls.change, [])
  const [update] = api.calls.update
  assert.equal(update.Id, "todo:task:t-overdue")
  assert.deepEqual(Object.keys(update).sort(), ["Actions", "Icon", "Id", "Tails"], "only the paints that changed")
  assert.equal(update.Icon, icons.RESULT_BOX_DONE)
  assert.deepEqual(update.Tails, [
    { Type: "text", Text: "i18n:badge_overdue", TextCategory: "danger" },
    { Type: "text", Text: `完成于 ${data.shortDateTime(data.localDateTime(new Date()))}` },
  ])
  assert.equal(update.Actions[0].Name, "i18n:action_reopen", "the same row can be reopened")
  assert.equal(update.Actions[0].ContextData.done, "false")
})

test("reopening repaints the row and clears the completion tail", async () => {
  const { api, response } = await run(makeApi(), { status: "done" })
  const row = taskRows(response)[0]
  await row.Actions[0].Action({}, { ContextData: row.Actions[0].ContextData, ResultId: row.Id })
  assert.equal(JSON.parse(api.settings.tasks).find((t) => t.id === "t-done").done, false)
  assert.deepEqual(api.calls.refresh, [])
  assert.equal(api.calls.update[0].Icon, icons.RESULT_BOX_OPEN)
  assert.deepEqual(api.calls.update[0].Tails, [{ Type: "text", Text: "i18n:badge_overdue", TextCategory: "danger" }])
})

test("delete removes the task row", async () => {
  const { api, response } = await run(makeApi())
  await action(rowOf(response, "月度更新"), "i18n:action_delete").Action({}, { ContextData: { id: "t-overdue" } })
  assert.deepEqual(
    JSON.parse(api.settings.tasks).map((t) => t.id),
    ["t-later", "t-today", "t-none", "t-done"]
  )
})

test("MRU restore rebuilds the same row from memory", async () => {
  const { api } = await run(makeApi())
  assert.ok(api.mruCallback, "init must register the restore callback")
  const restored = await api.mruCallback({}, { ContextData: { id: "t-overdue" } })
  assert.equal(restored.Title, "月度更新")
  assert.equal(restored.IdentityKey, "todo:task:t-overdue")
  assert.equal(restored.Preview, undefined)
  const create = await api.mruCallback({}, { ContextData: { id: "new" } })
  assert.deepEqual([create.Title, create.IdentityKey], ["i18n:action_new_task", "todo:new"])
  assert.equal(await api.mruCallback({}, { ContextData: { id: "gone" } }), null)
  assert.equal(await api.mruCallback({}, {}), null)
})

test("a failed read or a refused write never touches the stored list", async () => {
  const readApi = makeApi({
    async GetSetting() {
      throw new Error("host is busy")
    },
  })
  const first = new TodoPlugin()
  await first.init({}, { API: readApi })
  const row = { id: "t-1", title: "a", due: "", done: false, doneAt: "" }
  await first.setDone({}, { id: "t-1", done: "true" }, "todo:task:t-1")
  assert.deepEqual(readApi.calls.set, [], "an empty read result must not be written back over the real tasks")
  assert.deepEqual(readApi.calls.notify, ["toast_save_failed"])
  assert.deepEqual(readApi.calls.update, [])

  const writeApi = makeApi({
    async SetSetting() {
      return { Success: false, ErrMsg: "disk full" }
    },
  })
  const second = new TodoPlugin()
  await second.init({}, { API: writeApi })
  const stored = writeApi.settings.tasks
  await second.createTask({}, "新任务")
  assert.equal(writeApi.settings.tasks, stored, "the host refused the write, so nothing is stored")
  assert.deepEqual(writeApi.calls.notify, ["toast_save_failed"], "no success toast for a refused write")
  assert.deepEqual(writeApi.calls.change, [], "and no repaint claiming it worked")
})

test("typing while the picker is open narrows the date rows", async () => {
  const { plugin, response } = await run(makeApi())
  const due = action(rowOf(response, "月度更新"), "i18n:action_pick_due")
  await due.Action({}, { ContextData: due.ContextData })
  const rows = (await plugin.query({}, { RawQuery: "td 10-1", Search: "10-1", Refinements: {} })).Results
  assert.equal(rows[0].Title, "i18n:action_back", "返回 always stays")
  const dues = rows.slice(1).map((r) => r.Actions[0].ContextData.due).filter(Boolean)
  assert.deepEqual(dues, [
    TODAY,
    data.addDays(TODAY, 1),
    data.addDays(TODAY, 2),
    data.addDays(TODAY, 3),
    data.addDays(TODAY, 4),
    data.addDays(TODAY, 5),
  ])
  assert.ok(!dues.includes(data.addDays(TODAY, 7)), "10-21 does not match 10-1")
})

test("data helpers: due math, formatting and ordering", () => {
  assert.equal(data.dueStatus(data.addDays(TODAY, -1), TODAY), "overdue")
  assert.equal(data.dueStatus(TODAY, TODAY), "today")
  assert.equal(data.dueStatus(data.addDays(TODAY, 1), TODAY), "tomorrow")
  assert.equal(data.dueStatus(data.addDays(TODAY, 40), TODAY), "later")
  assert.equal(data.dueStatus("", TODAY), "")
  assert.equal(data.dueStatus("garbage", TODAY), "")
  assert.equal(data.daysBetween(data.addDays(TODAY, -4), TODAY), 4)
  const [, m, d] = TODAY.split("-")
  assert.equal(data.formatDue(TODAY, TODAY, true), `${Number(m)}月${Number(d)}日`)
  assert.ok(!data.formatDue(TODAY, TODAY, false).includes(TODAY.slice(0, 4)), "current year is dropped")
  assert.equal(data.formatDue("2999-03-05", TODAY, false), "2999-03-05")
  assert.equal(data.normalizeDue("3.5"), `${new Date().getFullYear()}-03-05`)
  assert.equal(data.normalizeDue("今天", TODAY), TODAY)
  assert.equal(data.normalizeDue("明天", TODAY), data.addDays(TODAY, 1))
  assert.equal(data.normalizeDue("大后天", TODAY), data.addDays(TODAY, 3))
  assert.equal(data.normalizeDue("3天后", TODAY), data.addDays(TODAY, 3))
  assert.equal(data.normalizeDue("in 2 days", TODAY), data.addDays(TODAY, 2))
  assert.equal(data.normalizeDue("constructor", TODAY), "", "prototype keys are not dates")
  assert.equal(data.normalizeDue("看情况", TODAY), "")
  assert.equal(data.shortDateTime(`${TODAY} 09:32`), `${TODAY.slice(5)} 09:32`)
  assert.deepEqual(
    data.filterTasks(TASKS, "pending").map((t) => t.id),
    ["t-overdue", "t-today", "t-later", "t-none"]
  )
  assert.equal(data.countTasks(TASKS, "all"), 5)
})

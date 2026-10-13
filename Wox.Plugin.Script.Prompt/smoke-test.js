// Mimics wox.plugin.host.nodejs/src/jsonrpc.ts: cacheResultActions registers
// every action of a plugin into ONE plugin-wide Map keyed by action Id, and
// action() dispatches through that Map. Also mimics the settings store.
const FILE = require("node:path").join(__dirname, "Wox.Plugin.Script.Prompt.js")
const fs = require("fs")

// 1. metadata header must stay valid JSON and carry the new column + keys.
const lines = fs.readFileSync(FILE, "utf8").split("\n")
const meta = JSON.parse(
  (() => {
    const out = []
    for (const l of lines) {
      if (!l.startsWith("//")) break
      out.push(l.replace(/^\/\/ ?/, ""))
    }
    return out.join("\n")
  })()
)
const cols = meta.SettingDefinitions[0].Value.Columns.map((c) => c.Key)
const idCol = meta.SettingDefinitions[0].Value.Columns.find((c) => c.Key === "id")
console.log("1. header parses | columns:", cols.join(","), "| id col flags:", idCol.HideInTable, idCol.HideInUpdate)
console.log("   col_id in en_US/zh_CN:", !!meta.I18n.en_US.col_id, !!meta.I18n.zh_CN.col_id)

// 2. fake settings store, pre-seeded with pre-id rows incl. a duplicate title.
let store = JSON.stringify([
  { title: "code review", body: "BODY-REVIEW", note: "n1" },
  { title: "翻译/润色", body: "BODY-ZH" },
  { title: "code review", body: "BODY-DUP", note: "dup title" },
  { title: "summarize", body: "BODY-SUM", note: "" }
])
let writes = 0
const copied = []
const api = {
  GetSetting: async () => store,
  SetSetting: async (_c, option) => {
    store = option.Value
    writes++
    return { Success: true, ErrMsg: "" }
  },
  Log: async (_c, _level, _msg) => {},
  OnMRURestore: async (_c, cb) => {
    api.mruCb = cb
  },
  Copy: async (_c, p) => copied.push(p.text),
  HideApp: async () => {}
}

const map = new Map()
const owner = new Map()
// Same template rendered twice (MRU row + list row) may reuse an Id; two
// DIFFERENT templates sharing an Id is the bug: the host map would dispatch the
// wrong closure.
const stolen = []
function register(results) {
  for (const r of results) {
    for (const a of r.Actions ?? []) {
      if (map.has(a.Id) && owner.get(a.Id) !== r.IdentityKey) stolen.push([a.Id, owner.get(a.Id), r.IdentityKey])
      map.set(a.Id, a.Action)
      owner.set(a.Id, r.IdentityKey)
      if (!a.Action) map.delete(a.Id)
    }
  }
}

;(async () => {
  const plugin = require(FILE).plugin
  plugin.init = plugin.init.bind(plugin)
  plugin.query = plugin.query.bind(plugin)

  // A. start-page MRU restore BEFORE any query (uses the legacy title record).
  await plugin.init({}, { API: api })
  const mruRows = []
  for (const title of ["code review", "summarize"]) {
    mruRows.push(await plugin.restoreMRU({ ContextData: { title } }))
  }
  console.log("A. pre-query MRU restore null count:", mruRows.filter((r) => !r).length)
  register(mruRows.filter(Boolean))

  // B. normal query over all four rows.
  const { Results } = await plugin.query({}, { Search: "" })
  register(Results)
  const ids = JSON.parse(store).map((r) => r.id)
  console.log("B. wrote ids on first load:", writes === 1, "| ids unique:", new Set(ids).size, "/", ids.length)
  console.log("   cross-template action Id collisions:", stolen.length)
  console.log("   identity keys:", [...new Set(Results.map((r) => r.IdentityKey))].length, "unique /", Results.length)

  // C. dispatch every visible row's default action through the host map.
  for (const r of [...mruRows.filter(Boolean), ...Results]) {
    await map.get(r.Actions[0].Id)({}, {})
  }
  console.log("C. copies dispatched in row order:", copied)

  // D. rename a template: identity must survive, no id re-mint.
  const rows = JSON.parse(store)
  rows[0].title = "REVIEW RENAMED"
  store = JSON.stringify(rows)
  const r2 = await plugin.query({}, { Search: "" })
  const same = r2.Results[0].IdentityKey === `prompt:${ids[0]}`
  console.log("D. rename keeps IdentityKey:", same, "| extra setting writes:", writes === 1)

  // E. row added through the settings dialog (no id) gets minted once.
  store = JSON.stringify([...JSON.parse(store), { title: "new row", body: "BODY-NEW" }])
  await plugin.query({}, { Search: "" })
  const w2 = writes
  await plugin.query({}, { Search: "" })
  console.log("E. new row minted:", writes === 2, "| steady state rewrites:", writes === 2 ? 0 : writes - w2)

  // F. restore by the new id-based ContextData.
  const byId = await plugin.restoreMRU({ ContextData: { id: ids[2], title: "stale title" } })
  console.log("F. id-based restore ->", byId && byId.Title, "| body copied:", byId && byId.IdentityKey === `prompt:${ids[2]}`)

  // G. malformed / garbage rows must not cause a rewrite loop.
  store = JSON.stringify([{ title: "ok", body: "B" }, "junk", null, { title: "  ", body: "x" }])
  const before = writes
  await plugin.query({}, { Search: "" })
  await plugin.query({}, { Search: "" })
  console.log("G. garbage rows: writes during 2 queries =", writes - before, "| rows shown =", (await plugin.query({}, { Search: "" })).Results.length)

  // H. a store that refuses the write must still leave every row with its own id:
  // rows sharing an empty id would collide in the host's one action map.
  delete require.cache[require.resolve(FILE)]
  let refused = 0
  const refusingApi = {
    GetSetting: async () =>
      JSON.stringify([
        { title: "one", body: "B-ONE" },
        { title: "two", body: "B-TWO" }
      ]),
    SetSetting: async () => {
      refused++
      return { Success: false, ErrMsg: "read-only store" }
    },
    Log: async () => {},
    OnMRURestore: async () => {},
    Copy: async () => {},
    HideApp: async () => {}
  }
  const second = require(FILE).plugin
  second.query = second.query.bind(second)
  await second.init({}, { API: refusingApi })
  const hRows = (await second.query({}, { Search: "" })).Results
  console.log(
    "H. write attempted and refused:",
    refused > 0,
    "| distinct IdentityKey:",
    new Set(hRows.map((r) => r.IdentityKey)).size,
    "/",
    hRows.length,
    "| distinct action Id:",
    new Set(hRows.map((r) => r.Actions[0].Id)).size,
    "/",
    hRows.length
  )
})()

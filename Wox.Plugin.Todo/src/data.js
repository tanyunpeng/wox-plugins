// Pure data layer: setting-row parsing, id minting, due-date facts, view
// selection and ordering. No host APIs in here so it is unit-testable.

function parseRows(raw) {
  if (typeof raw !== "string" || !raw) return []
  try {
    const rows = JSON.parse(raw)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeTasks(rows) {
  const list = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const title = text(row.title)
    if (!title) continue
    list.push({
      id: text(row.id) || title,
      title,
      due: normalizeDue(text(row.due)),
      done: row.done === true || row.done === "true" || row.done === 1,
      doneAt: text(row.doneAt),
    })
  }
  return list
}

// Stored dates are YYYY-MM-DD, but rows written while the field was a text box
// can still hold words, so reading them keeps those tasks on the right day.
const RELATIVE_DAYS = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3, today: 0, tomorrow: 1 }

function normalizeDue(value, today) {
  if (!value) return ""
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const m = value.match(/^(\d{1,2})[\/.-](\d{1,2})$/)
  if (m) {
    const year = new Date().getFullYear()
    return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`
  }
  const base = today || localDate(new Date())
  const word = Object.hasOwn(RELATIVE_DAYS, value.toLowerCase()) ? RELATIVE_DAYS[value.toLowerCase()] : undefined
  if (word !== undefined) return addDays(base, word)
  const inDays = value.match(/^(?:in\s+)?(\d+)\s*(?:天后|days?)$/i)
  if (inDays) return addDays(base, Number(inDays[1]))
  return ""
}

function localDate(now) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

// "2026-10-14 09:32" in the machine's own zone: what a completed task stores.
function localDateTime(now) {
  const hh = String(now.getHours()).padStart(2, "0")
  const mi = String(now.getMinutes()).padStart(2, "0")
  return `${localDate(now)} ${hh}:${mi}`
}

// Drop the year: a done timestamp sits in a list next to its own date.
function shortDateTime(value) {
  return /^\d{4}-(.*)$/.test(value) ? value.slice(5) : value
}

function addDays(dateText, days) {
  const [y, m, d] = dateText.split("-").map(Number)
  const dt = new Date(y, m - 1, d + days)
  return localDate(dt)
}

// Whole days between two YYYY-MM-DD dates (b - a); used for "逾期 N 天".
function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number)
  const [by, bm, bd] = b.split("-").map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

// overdue / today / tomorrow / later — the badge categories. An unparseable
// due string is treated as no due date.
function dueStatus(due, today) {
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return ""
  if (due < today) return "overdue"
  if (due === today) return "today"
  if (due === addDays(today, 1)) return "tomorrow"
  return "later"
}

// The due date is picked from result rows, not typed: a plugin cannot open a
// menu from an action form (ui/launcher/form_adapter.go:78 leaves openChoice
// unset), so the choices are drawn as native rows and the weekday rides in the
// subtitle because a result row has no right-aligned column.
const WEEK_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
const WEEK_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function dueChoices(today, zh, days) {
  const weekday = (date) => {
    const [y, m, d] = date.split("-").map(Number)
    return (zh ? WEEK_ZH : WEEK_EN)[new Date(y, m - 1, d).getDay()]
  }
  const named = {
    0: zh ? "今天" : "Today",
    1: zh ? "明天" : "Tomorrow",
    2: zh ? "后天" : "In 2 days",
  }
  const choices = [{ Label: zh ? "无截止时间" : "No due date", SubLabel: "", Value: "" }]
  for (let i = 0; i < days; i++) {
    const value = addDays(today, i)
    choices.push({
      Label: named[i] || formatDue(value, today, zh),
      SubLabel: `${weekday(value)} · ${value}`,
      Value: value,
    })
  }
  return choices
}

// Short display form: drop the century, drop the year inside the current year.
function formatDue(due, today, zh) {
  if (!due) return ""
  const [, m, d] = due.split("-")
  if (zh) {
    if (due.slice(0, 4) === today.slice(0, 4)) return `${Number(m)}月${Number(d)}日`
    return due
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  if (due >= today.slice(0, 4) + "-01-01" && due <= today.slice(0, 4) + "-12-31") {
    return `${months[Number(m) - 1]} ${Number(d)}`
  }
  return due
}

// The only built-in views: 状态 filters on done.
function matches(task, status) {
  if (status === "pending") return !task.done
  if (status === "done") return task.done
  return true
}

// Overdue first, then today, then later dates ascending, tasks without a due
// date last. Completed tasks are not pushed down: they keep the place their own
// date gives them (he took that rule out on 2026-10-14). Comparing the raw
// YYYY-MM-DD string already puts overdue before today. Inside the 已完成 view
// there is nothing to be overdue, so the newest completion leads instead.
function sortTasks(tasks, status) {
  const byCompletion = status === "done"
  return [...tasks].sort((a, b) => {
    if (byCompletion && a.doneAt !== b.doneAt) return a.doneAt < b.doneAt ? 1 : -1
    if (!a.due !== !b.due) return a.due ? -1 : 1
    if (a.due && a.due !== b.due) return a.due < b.due ? -1 : 1
    return a.title.localeCompare(b.title)
  })
}

function filterTasks(tasks, status) {
  return sortTasks(tasks.filter((t) => matches(t, status)), status)
}

function countTasks(tasks, status) {
  return tasks.filter((t) => matches(t, status)).length
}

// Rows written by the panel have ids already; this covers rows a user pastes
// in by hand. Action ids and IdentityKeys hang off the row id.
function mintIds(rows) {
  let minted = false
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    if (typeof row.id === "string" && row.id.trim()) continue
    row.id = crypto.randomUUID()
    minted = true
  }
  return minted
}

function upsert(rows, row) {
  const index = rows.findIndex((r) => r && typeof r === "object" && r.id === row.id)
  const next = [...rows]
  if (index === -1) next.push(row)
  else next[index] = row
  return next
}

function removeRow(rows, id) {
  return rows.filter((r) => r && typeof r === "object" && r.id !== id)
}

module.exports = {
  parseRows,
  text,
  normalizeTasks,
  normalizeDue,
  localDate,
  localDateTime,
  shortDateTime,
  addDays,
  daysBetween,
  dueStatus,
  dueChoices,
  formatDue,
  matches,
  sortTasks,
  filterTasks,
  countTasks,
  mintIds,
  upsert,
  removeRow,
}

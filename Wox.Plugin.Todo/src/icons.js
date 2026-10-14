// Icon constants. Action glyphs are monochrome and paint with
// var(--wox-theme-icon-color) so the Action Panel can tint them to the row
// label (skill icons.md); result/identity art may be colorful.

const THEME = "var(--wox-theme-icon-color)"

function woxImage(svg) {
  return { ImageType: "svg", ImageData: svg }
}

const STROKE = `fill="none" stroke="${THEME}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`

const ACTION_ADD = woxImage(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ${STROKE}><path d="M12 5v14M5 12h14"/></svg>`
)

const ACTION_DELETE = woxImage(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ${STROKE}><path d="M4 7h16M10 7V5h4v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M10 11v6M14 11v6"/></svg>`
)

const ACTION_EDIT = woxImage(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ${STROKE}><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M15 6l3 3"/></svg>`
)

const ACTION_TOGGLE = woxImage(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ${STROKE}><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/></svg>`
)

const ACTION_DUE = woxImage(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ${STROKE}><rect x="4" y="6" width="16" height="14" rx="3"/><path d="M8 4v4M16 4v4M4 11h16"/></svg>`
)

const ACTION_BACK = woxImage(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ${STROKE}><path d="M10 6l-6 6 6 6M4 12h16"/></svg>`
)

// 48x48 result identity art. Circles only: Wox result icons are not controls,
// and a square outline reads as a checkbox the user can click.
const BLUE = "#2563eb"
const GREEN = "#16a34a"
const WHITE = "#ffffff"

function badgeBase(fill, stroke, mark) {
  return woxImage(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="16" fill="${fill}" stroke="${stroke}" stroke-width="3"/>${mark}</svg>`
  )
}

// The unchecked circle is the theme paint at low opacity, so it reads on both
// the dark and the light appearance: the shared launcher image pipeline resolves
// `var(--wox-theme-icon-color)` to white on dark and black on light
// (wox-src/AGENTS.md:18). A near-white fill was invisible on light themes.
const RESULT_BOX_OPEN = woxImage(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="16" fill="var(--wox-theme-icon-color)" fill-opacity="0.08" stroke="var(--wox-theme-icon-color)" stroke-opacity="0.35" stroke-width="3"/></svg>`
)
const RESULT_BOX_DONE = badgeBase(
  GREEN,
  GREEN,
  `<path d="M16 24l6 6 11-12" fill="none" stroke="${WHITE}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`
)
const RESULT_NEW_TASK = woxImage(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="6" y="6" width="36" height="36" rx="9" fill="${BLUE}"/><path d="M24 15v18M15 24h18" stroke="${WHITE}" stroke-width="4" stroke-linecap="round"/></svg>`
)

// Picker rows are choices, not tasks, so they may use object shapes again. The
// calendar is the row's identity because the launcher paints Icon on the left
// of every result (ui/launcher/form_table_choice.go:25).
const SLATE = "#94a3b8"

const RESULT_DATE = woxImage(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="7" y="10" width="34" height="30" rx="7" fill="${BLUE}"/><rect x="7" y="10" width="34" height="9" rx="4.5" fill="${WHITE}"/><path d="M16 5v8M32 5v8" stroke="${BLUE}" stroke-width="4" stroke-linecap="round"/><path d="M15 27h6M27 27h6M15 34h6M27 34h6" stroke="${WHITE}" stroke-width="3.4" stroke-linecap="round"/></svg>`
)

const RESULT_NO_DATE = woxImage(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="16" fill="none" stroke="${SLATE}" stroke-width="3" stroke-dasharray="5 5"/></svg>`
)

const RESULT_BACK = woxImage(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="16" fill="#f1f5f9" stroke="${SLATE}" stroke-width="3"/><path d="M26 17l-7 7 7 7M19 24h11" fill="none" stroke="${SLATE}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
)

module.exports = {
  ACTION_ADD,
  ACTION_DELETE,
  ACTION_EDIT,
  ACTION_TOGGLE,
  ACTION_DUE,
  ACTION_BACK,
  RESULT_BOX_OPEN,
  RESULT_BOX_DONE,
  RESULT_NEW_TASK,
  RESULT_DATE,
  RESULT_NO_DATE,
  RESULT_BACK,
}

// Clock formatting for the preview. The vault's timestamps arrive as UTC ISO
// strings and TOTP windows are UTC epochs, so every one of them has to be
// converted before a person reads it -- slicing the ISO string prints the UTC
// calendar day, which is the wrong day for anything edited between midnight and
// 08:00 here (UTC+8).
function pad(n) {
  return String(n).padStart(2, "0");
}

// HH:MM:SS -- the end of a TOTP window, which is always within the next minute.
function formatClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// YYYY-MM-DD HH:MM -- a cipher's revision date, shown down to the minute.
function formatStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

module.exports = { formatClock, formatStamp };

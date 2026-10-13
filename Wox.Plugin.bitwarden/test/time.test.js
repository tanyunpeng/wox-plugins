const test = require("node:test");
const assert = require("node:assert");
const { formatClock, formatStamp } = require("../src/time");

test("both formatters read the local clock, not the UTC string", () => {
  // Built from local field values, so the expectation holds in any timezone.
  const ms = new Date(2026, 2, 1, 2, 7, 5).getTime();
  assert.strictEqual(formatStamp(ms), "2026-03-01 02:07", "single-digit month/day/hour get padded");
  assert.strictEqual(formatClock(ms), "02:07:05");
});

test("an ISO instant is formatted by its local day, which is where the old slice lied", () => {
  const ms = Date.parse("2026-02-28T18:00:00.000Z");
  const d = new Date(ms);
  const localDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.ok(formatStamp(ms).startsWith(localDay), `expected the local day ${localDay}, got ${formatStamp(ms)}`);
});

const test = require("node:test");
const assert = require("node:assert");
const { generate, parseSecret, base32Decode } = require("../src/totp");

// RFC 6238 Appendix B, Table 1 "TOTP Table" (fetched 2026-10-12 from
// https://www.rfc-editor.org/rfc/rfc6238.txt). Shared secret is the ASCII string
// "12345678901234567890", step X=30. 8-digit values are quoted by the RFC, so the
// 6-digit codes used in practice are their last 6 digits.
const RFC_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const vectors = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

test("base32Decode reproduces the RFC secret bytes", () => {
  assert.strictEqual(base32Decode(RFC_B32).toString("latin1"), "12345678901234567890");
});

test("bare base32 secret defaults to 6 digits / sha1 / 30 s", () => {
  const parsed = parseSecret(RFC_B32);
  assert.deepStrictEqual(
    { digits: parsed.digits, period: parsed.period, algorithm: parsed.algorithm },
    { digits: 6, period: 30, algorithm: "sha1" },
  );
});

for (const [seconds, eightDigit] of vectors) {
  test(`RFC 6238 vector t=${seconds}`, () => {
    const withEight = generate(`otpauth://totp/x?secret=${RFC_B32}&digits=8&period=30&algorithm=SHA1`, seconds * 1000);
    assert.strictEqual(withEight.code, eightDigit);
    const six = generate(RFC_B32, seconds * 1000);
    assert.strictEqual(six.code, eightDigit.slice(-6));
  });
}

test("otpauth parameters are honoured", () => {
  const parsed = parseSecret("otpauth://totp/Example:a?secret=" + RFC_B32 + "&digits=7&period=60&algorithm=SHA256");
  assert.strictEqual(parsed.digits, 7);
  assert.strictEqual(parsed.period, 60);
  assert.strictEqual(parsed.algorithm, "sha256");
});

test("secondsLeft stays inside the period", () => {
  const res = generate(RFC_B32, 59 * 1000);
  assert.strictEqual(res.secondsLeft, 1);
  const res2 = generate(RFC_B32, 61 * 1000);
  assert.strictEqual(res2.secondsLeft, 29);
});

test("expiresAt is the end of the window the code belongs to", () => {
  // The preview prints this instead of secondsLeft: it is the only freshness
  // statement that stays true after the snapshot is drawn.
  assert.strictEqual(generate(RFC_B32, 59 * 1000).expiresAt, 60_000);
  assert.strictEqual(generate(RFC_B32, 61 * 1000).expiresAt, 90_000);
  assert.strictEqual(generate(`otpauth://totp/x?secret=${RFC_B32}&period=45`, 59 * 1000).expiresAt, 90_000);
});

test("unsupported and malformed secrets fail loudly", () => {
  assert.throws(() => generate("steam://abcdef"), /Steam/);
  assert.throws(() => generate(""), /no TOTP secret/);
  assert.throws(() => generate("!!!!not base32!!!!"), /invalid base32/);
  assert.throws(() => generate(`otpauth://totp/x?secret=${RFC_B32}&algorithm=MD5`), /unsupported TOTP algorithm/);
});

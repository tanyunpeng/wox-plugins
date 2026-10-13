// RFC 6238 TOTP. The SDK's TotpClient needs full client state (verified: it
// throws "null pointer passed to rust" when constructed standalone), so the
// code generation lives here against Node's crypto.
const crypto = require("crypto");

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input) {
  const clean = String(input).replace(/=+$/, "").toUpperCase().replace(/[\s-]/g, "");
  if (!clean) throw new Error("empty base32 secret");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const index = B32_ALPHABET.indexOf(ch);
    if (index < 0) throw new Error("invalid base32 character");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// Bitwarden stores login.totp either as a bare base32 secret or as an otpauth
// URI carrying the real parameters.
function parseSecret(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("no TOTP secret");
  if (text.startsWith("steam://")) throw new Error("Steam guard codes are not supported");
  if (!/^otpauth:\/\//i.test(text)) return { secret: base32Decode(text), digits: 6, period: 30, algorithm: "sha1" };

  const url = new URL(text);
  const params = url.searchParams;
  const algorithm = (params.get("algorithm") || "SHA1").toLowerCase();
  if (!["sha1", "sha256", "sha512"].includes(algorithm)) throw new Error(`unsupported TOTP algorithm ${algorithm}`);
  const digits = Number(params.get("digits") || 6);
  const period = Number(params.get("period") || 30);
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new Error("unsupported TOTP digits");
  if (!Number.isInteger(period) || period <= 0) throw new Error("unsupported TOTP period");
  return { secret: base32Decode(params.get("secret") || ""), digits, period, algorithm };
}

function generate(raw, timeMs = Date.now()) {
  const { secret, digits, period, algorithm } = parseSecret(raw);
  if (secret.length === 0) throw new Error("empty TOTP secret");
  const counter = Math.floor(timeMs / 1000 / period);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const hash = crypto.createHmac(algorithm, secret).update(message).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const binary = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
  const code = String(binary % 10 ** digits).padStart(digits, "0");
  // expiresAt, not a countdown: a rendered preview is a snapshot, and "15s" frozen
  // on screen reads as a live timer and lies within seconds. An absolute end time
  // stays true after the render, so the reader can compare it with their own clock.
  return { code, digits, period, secondsLeft: period - (Math.floor(timeMs / 1000) % period), expiresAt: (counter + 1) * period * 1000 };
}

module.exports = { generate, parseSecret, base32Decode };

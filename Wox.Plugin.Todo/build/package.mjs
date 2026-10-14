// Assemble dist/ and produce the installable .wox (a zip of dist's contents,
// matching the reference plugin's packaging contract).
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deflateRawSync } from "node:zlib"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")

// Wox watches this exact directory for hot reload (wpm.go watches <dir>/dist),
// so it must never be deleted and recreated: that leaves the host's directory
// handle pointing at a dead inode and every build after the first is silent.
// Empty the children instead and keep `dist` itself alive.
mkdirSync(dist, { recursive: true })
for (const name of readdirSync(dist)) rmSync(path.join(dist, name), { recursive: true, force: true })
mkdirSync(path.join(dist, "src"), { recursive: true })

cpSync(path.join(root, "plugin.json"), path.join(dist, "plugin.json"))
cpSync(path.join(root, "index.js"), path.join(dist, "index.js"))
for (const name of readdirSync(path.join(root, "src"))) {
  cpSync(path.join(root, "src", name), path.join(dist, "src", name))
}

// A .wox is a plain zip whose entries are named with forward slashes, which is
// what the official store packages do. PowerShell's Compress-Archive instead
// writes "src\plugin.js", and Go's archive/zip keeps that as one flat file
// name, so a package built that way unpacks into junk on Linux and macOS. The
// container is written here so the build needs nothing but node, everywhere.
const CRC = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? -309822345 ^ (c >>> 8) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function* walk(dir, prefix) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    const entry = prefix ? `${prefix}/${name}` : name
    if (statSync(full).isDirectory()) {
      yield { name: `${entry}/`, data: Buffer.alloc(0), dir: true }
      yield* walk(full, entry)
    } else {
      yield { name: entry, data: readFileSync(full), dir: false }
    }
  }
}

const stamp = new Date()
const dosTime = (stamp.getHours() << 11) | (stamp.getMinutes() << 5) | (stamp.getSeconds() >> 1)
const dosDate = ((stamp.getFullYear() - 1980) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate()

const localBits = (entry, method, sum, size, rawSize) => {
  const head = Buffer.alloc(30)
  head.writeUInt32LE(0x04034b50, 0)
  head.writeUInt16LE(20, 4) // version needed to extract: 2.0
  head.writeUInt16LE(method, 8)
  head.writeUInt16LE(dosTime, 10)
  head.writeUInt16LE(dosDate, 12)
  head.writeUInt32LE(sum, 14)
  head.writeUInt32LE(size, 18)
  head.writeUInt32LE(rawSize, 22)
  head.writeUInt16LE(entry.length, 26)
  return head
}

const centralBits = (entry, method, sum, size, rawSize, isDir, where) => {
  const head = Buffer.alloc(46)
  head.writeUInt32LE(0x02014b50, 0)
  head.writeUInt16LE((3 << 8) | 20, 4) // made by Unix, spec 2.0
  head.writeUInt16LE(20, 6) // version needed to extract: 2.0
  head.writeUInt16LE(method, 10)
  head.writeUInt16LE(dosTime, 12)
  head.writeUInt16LE(dosDate, 14)
  head.writeUInt32LE(sum, 16)
  head.writeUInt32LE(size, 20)
  head.writeUInt32LE(rawSize, 24)
  head.writeUInt16LE(entry.length, 28)
  head.writeUInt32LE((isDir ? 0o40755 : 0o100644) * 0x10000, 38)
  head.writeUInt32LE(where, 42)
  return head
}

const parts = []
const central = []
let cursor = 0
let entries = 0
for (const item of walk(dist, "")) {
  const name = Buffer.from(item.name, "utf8")
  const deflated = item.dir ? item.data : deflateRawSync(item.data, { level: 9 })
  const method = !item.dir && deflated.length < item.data.length ? 8 : 0
  const body = method === 8 ? deflated : item.data
  const sum = crc32(item.data)

  parts.push(localBits(name, method, sum, body.length, item.data.length), name, body)
  central.push(centralBits(name, method, sum, body.length, item.data.length, item.dir, cursor), name)

  cursor += 30 + name.length + body.length
  entries++
}

const centralStart = cursor
for (const part of central) parts.push(part)
const centralSize = cursor - centralStart
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(entries, 8)
end.writeUInt16LE(entries, 10)
end.writeUInt32LE(centralSize, 12)
end.writeUInt32LE(centralStart, 16)
parts.push(end)

const target = path.join(root, "wox.plugin.todo.wox")
rmSync(target, { force: true })
writeFileSync(target, Buffer.concat(parts))
if (!existsSync(target)) {
  console.error("packaging failed: no archive written")
  process.exit(1)
}
console.log(`wrote ${path.basename(target)} (${statSync(target).size} bytes, ${entries} entries)`)

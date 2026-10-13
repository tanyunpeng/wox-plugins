// Self-test for gate4.js: runs the real gate against a LOCAL fake Vaultwarden,
// so the gate script itself is proven before it ever sees the production server.
//
//   node spike/gate4-selftest.js
//
// The fake server is the same synthetic vault as the unit tests (keys and
// secrets generated at run time). The master password goes to the child through
// BW_TEST_PASSWORD, never argv.
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { makeTransport, EMAIL, MASTER_PASSWORD } = require("../test/fixtures");

const transport = makeTransport();

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  // Answering from the "end" listener matters: awaiting it here can miss the
  // event on a fast keep-alive connection and hang the request.
  req.on("end", async () => {
    let fake;
    try {
      fake = await transport(`http://127.0.0.1:${server.address().port}${req.url}`, { method: req.method, body: body || undefined });
    } catch (error) {
      fake = { status: 500, text: async () => JSON.stringify({ error: String(error.message) }) };
    }
    res.writeHead(fake.status, { "Content-Type": "application/json" });
    res.end(await fake.text());
  });
});

server.listen(0, "127.0.0.1", () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  // GATE4_PAD=1 exercises the "terminal handed over a stray space" path: the
  // password is padded and only usable because gate4 is told to trim it.
  const pad = process.env.GATE4_PAD ? " " : "";
  const extra = process.env.GATE4_PAD ? ["--trim"] : [];
  console.log(`fake vaultwarden on ${base}${pad ? " (padded password, --trim)" : ""}`);
  // spawn, not spawnSync: this process is the server and must keep answering
  // while the gate runs.
  const child = spawn(process.execPath, [path.join(__dirname, "gate4.js"), base, EMAIL, ...extra], {
    stdio: "inherit",
    env: { ...process.env, BW_TEST_PASSWORD: `${pad}${MASTER_PASSWORD}${pad}` },
  });
  child.on("close", (code) => {
    server.close();
    console.log(`\ngate4-selftest: child exit ${code}`);
    process.exit(code === 0 ? 0 : 1);
  });
});

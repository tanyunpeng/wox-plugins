const test = require("node:test");
const assert = require("node:assert");
const { createIconCache } = require("../src/favicon");
const icons = require("../src/icons");

const shield = () => icons.VAULT_ICON;

test("a host that serves a favicon gets its url icon", async () => {
  const cache = createIconCache();
  await cache.probe(["github.com"], async () => ({ status: 200 }));
  assert.deepStrictEqual(cache.iconFor("github.com", shield()), {
    ImageType: "url",
    ImageData: "https://github.com/favicon.ico",
  });
});

test("a 404, a server error and a network error all keep the fallback", async () => {
  const cache = createIconCache();
  await cache.probe(["nope.test"], async () => ({ status: 404 }));
  await cache.probe(["broken.test"], async () => ({ status: 500 }));
  await cache.probe(["dead.test"], async () => {
    throw new Error("ENOTFOUND");
  });
  for (const host of ["nope.test", "broken.test", "dead.test"]) {
    assert.strictEqual(cache.iconFor(host, shield()), icons.VAULT_ICON, `${host} must not get a broken url icon`);
  }
});

test("each host is probed once, and an unknown host is not probed at all", async () => {
  const cache = createIconCache();
  let calls = 0;
  const fetchStub = async () => {
    calls += 1;
    return { status: 200 };
  };
  await cache.probe(["a.test", "a.test", "", null], fetchStub);
  await cache.probe(["a.test"], fetchStub);
  assert.strictEqual(calls, 1);
  assert.strictEqual(cache.iconFor("b.test", shield()), icons.VAULT_ICON, "never probed means never guessed");
});

test("concurrent probes for one host share a single request", async () => {
  const cache = createIconCache();
  let calls = 0;
  const fetchStub = async () => {
    calls += 1;
    await new Promise((done) => setTimeout(done, 5));
    return { status: 200 };
  };
  await Promise.all([cache.probe(["c.test"], fetchStub), cache.probe(["c.test"], fetchStub)]);
  assert.strictEqual(calls, 1);
});

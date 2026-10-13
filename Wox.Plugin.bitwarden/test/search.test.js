const test = require("node:test");
const assert = require("node:assert");
const { searchItems, scoreItem, terms, hostOf, normalize } = require("../src/search");

const item = (overrides) => ({
  id: overrides.id ?? Math.random().toString(36).slice(2),
  name: "",
  username: "",
  uriHosts: [],
  primaryUri: "",
  favorite: false,
  ...overrides,
});

test("normalize folds case and full-width forms (no trimming)", () => {
  assert.strictEqual(normalize("Ｇｉｔｈｕｂ"), "github");
  assert.strictEqual(normalize("  Git "), "  git ");
  assert.strictEqual(terms("  Git Hub  ").join("|"), "git|hub");
});

test("hostOf extracts hosts from every stored URI form", () => {
  assert.strictEqual(hostOf("github.com/login"), "github.com");
  assert.strictEqual(hostOf("https://GitLab.com/group/repo"), "gitlab.com");
  assert.strictEqual(hostOf("://internal.example/x"), "internal.example");
  assert.strictEqual(hostOf(""), "");
});

test("empty query matches everything with a base score", () => {
  const items = [item({ name: "a" }), item({ name: "b" })];
  assert.deepStrictEqual(searchItems(items, "  "), items);
  assert.strictEqual(scoreItem(items[0], []), 60);
});

test("every term must match somewhere (AND semantics)", () => {
  const target = item({ name: "GitHub 演示", username: "demo", uriHosts: ["github.com"] });
  assert.ok(scoreItem(target, terms("github demo")) > 0);
  assert.strictEqual(scoreItem(target, terms("github nonexistent")), -1);
});

test("name beats username beats host, exact beats prefix beats contains", () => {
  const target = item({ name: "github", username: "githubuser", uriHosts: ["github.com"] });
  const byName = scoreItem(target, terms("github"));
  assert.ok(byName >= 50);
  const hostOnly = scoreItem(item({ name: "zzz", uriHosts: ["github.com"] }), terms("github"));
  assert.ok(hostOnly < byName && hostOnly > 0);
});

test("favorites sort first, then relevance while typing", () => {
  const plain = item({ name: "github", id: "plain" });
  const fav = item({ name: "github", id: "fav", favorite: true });
  assert.deepStrictEqual(searchItems([plain, fav], "github").map((i) => i.id), ["fav", "plain"]);
});

test("usage count and recency rank otherwise-identical items", () => {
  const a = item({ name: "srv", id: "a" });
  const b = item({ name: "srv", id: "b" });
  const usage = { a: { count: 1, lastUsed: 10 }, b: { count: 1, lastUsed: 20 } };
  assert.deepStrictEqual(searchItems([a, b], "srv", { usage }).map((i) => i.id), ["b", "a"]);
  const usage2 = { b: { count: 5, lastUsed: 1 } };
  assert.deepStrictEqual(searchItems([a, b], "srv", { usage: usage2 }).map((i) => i.id), ["b", "a"]);
});

test("results are capped", () => {
  const many = Array.from({ length: 80 }, (_, i) => item({ name: `item ${i}`, uriHosts: ["x.com"] }));
  assert.strictEqual(searchItems(many, "item", { limit: 50 }).length, 50);
});

// Two decisions pinned as behaviour, not comments: the note is display-only, and
// there is no pinyin matching.
test("only name, username and hosts are searchable; Chinese names are not romanised", () => {
  const noteOnly = item({ name: "GitHub", secrets: { note: "smtp-password  hunter2  recovery" }, folderName: "recovery" });
  assert.strictEqual(scoreItem(noteOnly, terms("hunter2")), -1, "note text must not be searchable");
  assert.strictEqual(scoreItem(noteOnly, terms("recovery")), -1, "folder names must not be searchable either");

  const chinese = item({ name: "公司内网", username: "sannong", uriHosts: ["intranet.internal"] });
  assert.strictEqual(scoreItem(chinese, terms("gongsi")), -1, "pinyin queries must not match");
  assert.ok(scoreItem(chinese, terms("内网")) > 0, "the literal Chinese name still matches");
});

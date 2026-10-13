// Local ranking for decrypted vault items. Vaultwarden is zero-knowledge, so the
// server cannot search names or usernames; scoring happens on the decrypted view.

const normalize = (value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase();

function hostOf(uri) {
  const text = String(uri ?? "").trim();
  if (!text) return "";
  if (/^[a-z][a-z\d+.-]*:/i.test(text)) {
    try {
      return new URL(text).hostname.toLocaleLowerCase();
    } catch {
      return "";
    }
  }
  // Bitwarden stores bare hosts and "://host/path" scheme-match entries too.
  return text.replace(/^:\/\//, "").split("/")[0].toLocaleLowerCase();
}

function terms(query) {
  return normalize(query)
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// A term hits the item when any searchable field contains it. Returns -1 when a
// term matches nothing, which is how every term must match (AND semantics).
function scoreItem(item, queryTerms) {
  const name = normalize(item.name);
  const username = normalize(item.username);
  const hosts = item.uriHosts.map(normalize);
  const haystack = [name, username, ...hosts].filter(Boolean).join("\n");

  if (queryTerms.length === 0) return 60;

  let score = 0;
  for (const term of queryTerms) {
    if (!haystack.includes(term)) return -1;
    if (name === term) score += 50;
    else if (name.startsWith(term)) score += 35;
    else if (name.includes(term)) score += 25;
    else if (username.includes(term)) score += 16;
    else if (hosts.some((h) => h.startsWith(term))) score += 12;
    else if (hosts.some((h) => h.includes(term))) score += 10;
  }
  return Math.min(100, score);
}

function searchItems(items, query, options = {}) {
  const { limit = 50, usage = {} } = options;
  const queryTerms = terms(query);
  const hasQuery = queryTerms.length > 0;

  return items
    .map((item) => ({ item, score: scoreItem(item, queryTerms) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => {
      if (a.item.favorite !== b.item.favorite) return a.item.favorite ? -1 : 1;
      if (hasQuery && a.score !== b.score) return b.score - a.score;
      const au = usage[a.item.id] ?? { count: 0, lastUsed: 0 };
      const bu = usage[b.item.id] ?? { count: 0, lastUsed: 0 };
      if (au.count !== bu.count) return bu.count - au.count;
      if (au.lastUsed !== bu.lastUsed) return bu.lastUsed - au.lastUsed;
      if (!hasQuery && a.score !== b.score) return b.score - a.score;
      return String(a.item.name).localeCompare(String(b.item.name));
    })
    .slice(0, limit)
    .map(({ item }) => item);
}

module.exports = { normalize, hostOf, scoreItem, searchItems, terms };

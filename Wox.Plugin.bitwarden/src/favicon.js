// Site icons for result rows.
//
// Wox renders an `url` image with no fallback: if the fetch fails the row simply
// loses its icon (common/image.go GetImage returns the error). Many vault hosts
// are bare IPs or internal names without a /favicon.ico, so we probe first and
// only hand Wox a URL we know answers. The query never waits: an unknown host
// shows the shield this round and its real icon on the next one.
const { favicon } = require("./icons");

const PROBE_TIMEOUT_MS = 4000;

function createIconCache() {
  // host -> true (serves an icon) | false (keep the fallback)
  const resolved = new Map();
  const inflight = new Map();

  async function probeHost(host, fetchImpl) {
    try {
      const res = await fetchImpl(`https://${host}/favicon.ico`, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      resolved.set(host, res.status < 400);
    } catch {
      resolved.set(host, false);
    }
  }

  // Returns the promise for the probes started by this call; callers that do not
  // care can ignore it. A host is fetched at most once, success or not.
  function probe(hosts, fetchImpl = (url, init) => fetch(url, init)) {
    const pending = [];
    for (const host of hosts) {
      if (!host || resolved.has(host)) continue;
      if (!inflight.has(host)) {
        const run = probeHost(host, fetchImpl).finally(() => inflight.delete(host));
        inflight.set(host, run);
      }
      pending.push(inflight.get(host));
    }
    return Promise.all(pending);
  }

  function iconFor(host, fallback) {
    return resolved.get(host) === true ? favicon(host) : fallback;
  }

  return { probe, iconFor };
}

module.exports = { createIconCache };

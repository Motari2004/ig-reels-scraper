/**
 * wakeBackend.js
 *
 * Drop into your Vercel project (frontend or API route — it's plain fetch,
 * works in both). Pings the Render backend's /healthz endpoint, detects
 * whether it's asleep, and waits it out with backoff before you fire the
 * real request — instead of the real request itself hanging for 30-60s with
 * no feedback.
 *
 * Usage in a browser component:
 *
 *   const awake = await wakeBackend('https://your-app.onrender.com', {
 *     onStatus: (s) => setBackendStatus(s), // drive a UI banner off this
 *   });
 *   if (!awake) {
 *     // show "backend didn't wake up in time, try again" — rare, but Render
 *     // cold starts can occasionally exceed maxWaitMs under load.
 *     return;
 *   }
 *   // safe to call /api/scrape/start now
 *
 * Usage in a Vercel API route (gatekeeping before you proxy the real call —
 * see api-route-example.js in this folder):
 *
 *   const awake = await wakeBackend(process.env.RENDER_BACKEND_URL);
 */

/**
 * @param {string} baseUrl - e.g. "https://your-app.onrender.com" (no trailing slash)
 * @param {object} [opts]
 * @param {(status: {phase: 'checking'|'awake'|'waking'|'timeout', wasSleeping?: boolean, elapsedMs?: number}) => void} [opts.onStatus]
 *        Called as the wake process progresses — wire this to a UI indicator.
 * @param {number} [opts.pingTimeoutMs=5000] - how long a single /healthz ping is allowed to take
 * @param {number} [opts.maxWaitMs=90000] - give up after this long overall
 * @param {number} [opts.pollIntervalMs=3000] - gap between retries while waking
 * @returns {Promise<boolean>} true once /healthz responds OK, false if maxWaitMs is exceeded
 */
async function wakeBackend(baseUrl, opts = {}) {
  const {
    onStatus = () => {},
    pingTimeoutMs = 5000,
    maxWaitMs = 90000,
    pollIntervalMs = 3000,
  } = opts;

  const url = `${baseUrl.replace(/\/$/, '')}/healthz`;
  const start = Date.now();

  onStatus({ phase: 'checking' });

  // Fast path: if it's already awake, this resolves in well under a second.
  if (await pingOnce(url, pingTimeoutMs)) {
    onStatus({ phase: 'awake', wasSleeping: false, elapsedMs: Date.now() - start });
    return true;
  }

  // Slow path: it's asleep (or genuinely down). Poll until it comes up or we time out.
  onStatus({ phase: 'waking' });

  while (Date.now() - start < maxWaitMs) {
    await sleep(pollIntervalMs);
    if (await pingOnce(url, pingTimeoutMs)) {
      onStatus({ phase: 'awake', wasSleeping: true, elapsedMs: Date.now() - start });
      return true;
    }
  }

  onStatus({ phase: 'timeout', elapsedMs: Date.now() - start });
  return false;
}

async function pingOnce(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false; // timeout, network error, or the instance is still spinning up
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { wakeBackend };

/**
 * Example Vercel API route: pages/api/scrape/start.js (or app/api/scrape/start/route.js
 * if you're on the App Router — adapt the export shape accordingly).
 *
 * This is the "proxy" piece from the earlier CORS/auth discussion: the browser
 * calls THIS route, not Render directly. That keeps your Render API key out of
 * client-side JS, sidesteps CORS entirely (server-to-server calls don't hit it),
 * and lets you gate the request behind wakeBackend() so the browser gets a
 * meaningful "waking up" response instead of a raw timeout.
 *
 * Env vars to set in Vercel:
 *   RENDER_BACKEND_URL   e.g. https://your-app.onrender.com
 *   RENDER_API_KEY       matches AUTH_USER/AUTH_PASS or a bearer token on the
 *                         Render side, depending which auth scheme you land on
 */

const { wakeBackend } = require('../../../vercel-integration/wakeBackend'); // adjust path to match your project layout

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const backendUrl = process.env.RENDER_BACKEND_URL;

  const awake = await wakeBackend(backendUrl, {
    maxWaitMs: 90000,
    onStatus: (status) => {
      // Optional: log cold-start events server-side so you can see how often
      // this actually happens in practice.
      if (status.phase === 'awake' && status.wasSleeping) {
        console.log(`Render backend woke from sleep in ${status.elapsedMs}ms`);
      }
    },
  });

  if (!awake) {
    return res.status(503).json({
      error: 'Backend did not wake up in time. Please try again.',
    });
  }

  // Backend is confirmed awake — forward the actual request.
  const upstream = await fetch(`${backendUrl}/api/scrape/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RENDER_API_KEY}`,
    },
    body: JSON.stringify(req.body),
  });

  const data = await upstream.json();
  return res.status(upstream.status).json(data);
};

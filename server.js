'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { scrapeProfiles } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Optional HTTP Basic Auth. Disabled (no-op) unless both AUTH_USER and AUTH_PASS
 * are set — which they should be for any deployment reachable outside localhost,
 * since this app accepts session cookies and can trigger outbound scraping.
 */
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function basicAuth(req, res, next) {
  const expectedUser = process.env.AUTH_USER;
  const expectedPass = process.env.AUTH_PASS;
  if (!expectedUser || !expectedPass) return next(); // auth not configured — allow through

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  const reject = () => {
    res.set('WWW-Authenticate', 'Basic realm="Reel Reader"');
    return res.status(401).send('Authentication required');
  };

  if (scheme !== 'Basic' || !encoded) return reject();

  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return reject();
  }

  const sep = decoded.indexOf(':');
  if (sep === -1) return reject();

  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  if (timingSafeStringEqual(user, expectedUser) && timingSafeStringEqual(pass, expectedPass)) {
    return next();
  }
  return reject();
}

app.use(basicAuth);
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** @type {Map<string, {id:string,status:string,log:Array,results:Array,error:string|null,startedAt:number}>} */
const jobs = new Map();

// Drop jobs older than 2 hours so memory doesn't grow forever in long-running sessions.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.startedAt < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

app.post('/api/scrape/start', (req, res) => {
  const { cookies, usernames, maxReels, maxScrolls, headless } = req.body || {};

  if (!Array.isArray(cookies) || cookies.length === 0) {
    return res.status(400).json({ error: 'cookies (from cookie.json) are required' });
  }
  if (!Array.isArray(usernames) || usernames.filter((u) => u && u.trim()).length === 0) {
    return res.status(400).json({ error: 'at least one target username is required' });
  }

  const jobId = uuidv4();
  const job = {
    id: jobId,
    status: 'running',
    log: [{ time: Date.now(), message: 'Job queued' }],
    results: [],
    error: null,
    startedAt: Date.now(),
  };
  jobs.set(jobId, job);

  scrapeProfiles(
    cookies,
    usernames,
    { maxReels, maxScrolls, headless: headless !== false },
    (message, result) => {
      job.log.push({ time: Date.now(), message });
      if (result) job.results.push(result);
    }
  )
    .then(() => {
      job.status = 'done';
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err.message;
      job.log.push({ time: Date.now(), message: `Fatal error: ${err.message}` });
    });

  res.json({ jobId });
});

app.get('/api/scrape/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

app.get('/api/scrape/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const format = (req.query.format || 'json').toLowerCase();

  if (format === 'csv') {
    let csv = 'username,status,reel_url\n';
    for (const r of job.results) {
      if (!r.reels || r.reels.length === 0) {
        csv += `${r.username},${r.status},\n`;
      } else {
        for (const url of r.reels) {
          csv += `${r.username},${r.status},${url}\n`;
        }
      }
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="reels_${job.id}.csv"`);
    return res.send(csv);
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="reels_${job.id}.json"`);
  res.send(JSON.stringify(job.results, null, 2));
});

app.listen(PORT, () => {
  console.log(`IG Reels Scraper running at http://localhost:${PORT}`);
});

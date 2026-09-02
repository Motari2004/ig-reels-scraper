'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { scrapeProfiles } = require('./scraper');
const axios = require('axios');

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

/** @type {Map<string, {id:string,status:string,log:Array,results:Array,error:string|null,startedAt:number,vercel:{sent:boolean,count:number}}>} */
const jobs = new Map();

// Drop jobs older than 2 hours so memory doesn't grow forever in long-running sessions.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.startedAt < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

// ============== VERCEL INTEGRATION ==============

const VERCEL_WEBHOOK_URL = process.env.VERCEL_WEBHOOK_URL || 'https://fetchgram-one.vercel.app/api/process-reels';
const VERCEL_STORAGE_URL = process.env.VERCEL_STORAGE_URL || 'https://fetchgram-one.vercel.app/api/scraped/store';
const VERCEL_API_KEY = process.env.VERCEL_API_KEY || '';

async function sendReelsToVercel(jobId, results) {
  try {
    // Extract all reel URLs from the results
    const allReelUrls = [];
    for (const profile of results) {
      if (profile.reels && profile.reels.length > 0) {
        allReelUrls.push(...profile.reels);
      }
    }

    if (allReelUrls.length === 0) {
      console.log(`[Job ${jobId}] No reels found to send to Vercel.`);
      return { sent: false, count: 0, message: 'No reels to send' };
    }

    console.log(`[Job ${jobId}] Sending ${allReelUrls.length} reels to Vercel...`);

    const payload = { 
      reels: allReelUrls,
      job_id: jobId,
      timestamp: new Date().toISOString()
    };

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'IG-Reels-Scraper/1.0'
    };

    // Add API key if configured
    if (VERCEL_API_KEY) {
      headers['X-API-Key'] = VERCEL_API_KEY;
    }

    // Send to process-reels endpoint (for generating download URLs)
    let processResponse = null;
    try {
      processResponse = await axios.post(VERCEL_WEBHOOK_URL, payload, {
        headers: headers,
        timeout: 120000 // 2 minutes timeout for processing many URLs
      });
      console.log(`[Job ${jobId}] Successfully sent to Vercel process endpoint.`);
    } catch (error) {
      console.error(`[Job ${jobId}] Failed to send to Vercel process endpoint:`, error.message);
      if (error.response) {
        console.error(`[Job ${jobId}] Response:`, error.response.status, error.response.data);
      }
    }

    // Send to storage endpoint (for storing results)
    let storageResponse = null;
    try {
      const storagePayload = {
        results: results,
        job_id: jobId,
        timestamp: new Date().toISOString()
      };
      
      storageResponse = await axios.post(VERCEL_STORAGE_URL, storagePayload, {
        headers: headers,
        timeout: 30000
      });
      console.log(`[Job ${jobId}] Stored results on Vercel storage.`);
    } catch (error) {
      console.error(`[Job ${jobId}] Failed to store results on Vercel:`, error.message);
      if (error.response) {
        console.error(`[Job ${jobId}] Response:`, error.response.status, error.response.data);
      }
    }
    
    return {
      sent: true,
      count: allReelUrls.length,
      message: `Sent ${allReelUrls.length} reels to Vercel`,
      process_status: processResponse ? processResponse.status : null,
      storage_status: storageResponse ? storageResponse.status : null
    };
  } catch (error) {
    console.error(`[Job ${jobId}] Failed to send results to Vercel:`, error.message);
    if (error.response) {
      console.error(`[Job ${jobId}] Vercel responded with:`, error.response.status, error.response.data);
    }
    return {
      sent: false,
      count: 0,
      error: error.message,
      details: error.response ? error.response.data : null
    };
  }
}

// ============== ROUTES ==============

app.post('/api/scrape/start', (req, res) => {
  const { cookies, usernames, maxReels, maxScrolls, headless, sendToVercel } = req.body || {};

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
    vercel: { sent: false, count: 0 }
  };
  jobs.set(jobId, job);

  // Store whether to send to Vercel
  const shouldSendToVercel = sendToVercel !== false; // Default: true

  scrapeProfiles(
    cookies,
    usernames,
    { maxReels, maxScrolls, headless: headless !== false },
    (message, result) => {
      job.log.push({ time: Date.now(), message });
      if (result) job.results.push(result);
    }
  )
    .then(async () => {
      job.status = 'done';
      job.log.push({ time: Date.now(), message: '✅ Scraping completed' });
      
      // Send results to Vercel if enabled
      if (shouldSendToVercel) {
        job.log.push({ time: Date.now(), message: '📤 Sending results to Vercel...' });
        const result = await sendReelsToVercel(jobId, job.results);
        job.vercel = result;
        
        if (result.sent) {
          job.log.push({ time: Date.now(), message: `✅ Sent ${result.count} reels to Vercel` });
        } else {
          job.log.push({ time: Date.now(), message: `❌ Failed to send to Vercel: ${result.error || 'Unknown error'}` });
        }
      } else {
        job.log.push({ time: Date.now(), message: 'ℹ️ Skipped sending to Vercel (disabled)' });
      }
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err.message;
      job.log.push({ time: Date.now(), message: `❌ Fatal error: ${err.message}` });
    });

  res.json({ 
    jobId,
    vercel_enabled: shouldSendToVercel,
    vercel_webhook: shouldSendToVercel ? VERCEL_WEBHOOK_URL : null
  });
});

app.get('/api/scrape/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  
  // Return a clean response
  res.json({
    id: job.id,
    status: job.status,
    log: job.log || [],
    results: job.results || [],
    error: job.error,
    startedAt: job.startedAt,
    vercel: job.vercel || { sent: false, count: 0 }
  });
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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'IG Reels Scraper',
    version: '1.0.0',
    uptime: process.uptime(),
    vercel_webhook_configured: !!VERCEL_WEBHOOK_URL,
    vercel_storage_configured: !!VERCEL_STORAGE_URL,
    active_jobs: jobs.size
  });
});

// Get latest job results
app.get('/api/scrape/latest', (req, res) => {
  let latestJob = null;
  let latestTime = 0;
  
  for (const [id, job] of jobs) {
    if (job.startedAt > latestTime && job.status === 'done') {
      latestTime = job.startedAt;
      latestJob = job;
    }
  }
  
  if (!latestJob) {
    return res.status(404).json({ error: 'No completed jobs found' });
  }
  
  res.json({
    id: latestJob.id,
    status: latestJob.status,
    results: latestJob.results || [],
    startedAt: latestJob.startedAt,
    vercel: latestJob.vercel || { sent: false, count: 0 }
  });
});

app.listen(PORT, () => {
  console.log(`IG Reels Scraper running at http://localhost:${PORT}`);
  console.log(`Vercel webhook: ${VERCEL_WEBHOOK_URL || 'Not configured'}`);
  console.log(`Vercel storage: ${VERCEL_STORAGE_URL || 'Not configured'}`);
  console.log(`Vercel API Key: ${VERCEL_API_KEY ? 'Configured ✓' : 'Not configured'}`);
});
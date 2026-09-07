'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { scrapeProfiles } = require('./scraper');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ============== LOGGING ==============
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} ${message}`);
  if (data) {
    console.log(`${timestamp} DATA:`, JSON.stringify(data, null, 2).substring(0, 500));
  }
}

function logMemory() {
  const used = process.memoryUsage();
  const mb = (used.heapUsed / 1024 / 1024).toFixed(1);
  log(`💾 MEMORY: ${mb}MB heap used (rss: ${(used.rss / 1024 / 1024).toFixed(1)}MB)`);
}

// ============== AUTH ==============
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function basicAuth(req, res, next) {
  const expectedUser = process.env.AUTH_USER;
  const expectedPass = process.env.AUTH_PASS;
  if (!expectedUser || !expectedPass) return next();

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
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============== JOB STORAGE ==============
const jobs = new Map();

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const before = jobs.size;
  for (const [id, job] of jobs) {
    if (job.startedAt < cutoff) jobs.delete(id);
  }
  const after = jobs.size;
  if (before !== after) {
    log(`🧹 Cleaned ${before - after} old jobs, ${after} remaining`);
  }
}, 30 * 60 * 1000);

// ============== VERCEL INTEGRATION ==============

const VERCEL_WEBHOOK_URL = process.env.VERCEL_WEBHOOK_URL || 'https://fetchgram-one.vercel.app/api/process-reels';
const VERCEL_STORAGE_URL = process.env.VERCEL_STORAGE_URL || 'https://fetchgram-one.vercel.app/api/scraped/store';
const VERCEL_API_KEY = process.env.VERCEL_API_KEY || '';

async function sendReelsToVercel(jobId, results) {
  try {
    const allReelUrls = [];
    for (const profile of results) {
      if (profile.reels && profile.reels.length > 0) {
        allReelUrls.push(...profile.reels);
      }
    }

    if (allReelUrls.length === 0) {
      log(`[Job ${jobId}] No reels found to send to Vercel.`);
      return { sent: false, count: 0, message: 'No reels to send' };
    }

    log(`[Job ${jobId}] Sending ${allReelUrls.length} reels to Vercel...`);

    const payload = { 
      reels: allReelUrls,
      job_id: jobId,
      timestamp: new Date().toISOString()
    };

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'IG-Reels-Scraper/1.0'
    };

    if (VERCEL_API_KEY) {
      headers['X-API-Key'] = VERCEL_API_KEY;
    }

    let processResponse = null;
    try {
      processResponse = await axios.post(VERCEL_WEBHOOK_URL, payload, {
        headers: headers,
        timeout: 120000
      });
      log(`[Job ${jobId}] Successfully sent to Vercel process endpoint.`);
    } catch (error) {
      log(`[Job ${jobId}] Failed to send to Vercel process endpoint: ${error.message}`);
      if (error.response) {
        log(`[Job ${jobId}] Response: ${error.response.status} - ${JSON.stringify(error.response.data).substring(0, 200)}`);
      }
    }

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
      log(`[Job ${jobId}] Stored results on Vercel storage.`);
    } catch (error) {
      log(`[Job ${jobId}] Failed to store results on Vercel: ${error.message}`);
      if (error.response) {
        log(`[Job ${jobId}] Response: ${error.response.status} - ${JSON.stringify(error.response.data).substring(0, 200)}`);
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
    log(`[Job ${jobId}] Failed to send results to Vercel: ${error.message}`);
    if (error.response) {
      log(`[Job ${jobId}] Vercel responded with: ${error.response.status} - ${JSON.stringify(error.response.data).substring(0, 200)}`);
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

  log(`📥 Received scrape request: ${usernames ? usernames.length : 0} profiles, maxReels=${maxReels || 'default'}, maxScrolls=${maxScrolls || 'default'}`);

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

  const shouldSendToVercel = sendToVercel !== false;
  log(`[Job ${jobId}] Created job for ${usernames.length} profiles`);

  scrapeProfiles(
    cookies,
    usernames,
    { 
      maxReels: maxReels || 500,
      maxScrolls: maxScrolls || 200,
      headless: headless !== false,
      jobId: jobId 
    },
    (message, result) => {
      job.log.push({ time: Date.now(), message });
      if (result) job.results.push(result);
    }
  )
    .then(async (allResults) => {
      // 🔥 FIX: Check if allResults exists
      if (!allResults) {
        log(`[Job ${jobId}] ⚠️ No results returned from scraper`);
        job.status = 'error';
        job.error = 'No results returned from scraper';
        job.log.push({ time: Date.now(), message: '❌ No results returned from scraper' });
        return;
      }
      
      job.status = 'done';
      const totalReels = allResults.reduce((sum, r) => sum + (r.reels ? r.reels.length : 0), 0);
      job.log.push({ time: Date.now(), message: `✅ Scraping completed: ${totalReels} reels` });
      
      log(`[Job ${jobId}] ✅ Scraping completed: ${allResults.length} profiles, ${totalReels} reels`);
      
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
      log(`[Job ${jobId}] ❌ Fatal error: ${err.message}`);
      if (err.stack) {
        log(`[Job ${jobId}] 📚 Stack: ${err.stack}`);
      }
    });

  res.json({ 
    jobId,
    vercel_enabled: shouldSendToVercel,
    vercel_webhook: shouldSendToVercel ? VERCEL_WEBHOOK_URL : null,
    max_reels: maxReels || 500,
    max_scrolls: maxScrolls || 200,
    profiles: usernames.length
  });
});

app.get('/api/scrape/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  
  const totalReels = job.results.reduce((sum, r) => sum + (r.reels ? r.reels.length : 0), 0);
  
  res.json({
    id: job.id,
    status: job.status,
    log: job.log || [],
    results: job.results || [],
    total_reels: totalReels,
    profiles: job.results.length,
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
  const totalJobs = jobs.size;
  const runningJobs = [...jobs.values()].filter(j => j.status === 'running').length;
  
  res.json({
    status: 'healthy',
    service: 'IG Reels Scraper',
    version: '1.0.0',
    uptime: process.uptime(),
    vercel_webhook_configured: !!VERCEL_WEBHOOK_URL,
    vercel_storage_configured: !!VERCEL_STORAGE_URL,
    active_jobs: totalJobs,
    running_jobs: runningJobs
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
  
  const totalReels = latestJob.results.reduce((sum, r) => sum + (r.reels ? r.reels.length : 0), 0);
  
  res.json({
    id: latestJob.id,
    status: latestJob.status,
    results: latestJob.results || [],
    total_reels: totalReels,
    profiles: latestJob.results.length,
    startedAt: latestJob.startedAt,
    vercel: latestJob.vercel || { sent: false, count: 0 }
  });
});

app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🤖 IG Reels Scraper v2.0`);
  console.log(`========================================`);
  console.log(`🚀 Running at http://localhost:${PORT}`);
  console.log(`📤 Vercel webhook: ${VERCEL_WEBHOOK_URL || 'Not configured'}`);
  console.log(`💾 Vercel storage: ${VERCEL_STORAGE_URL || 'Not configured'}`);
  console.log(`🔑 Vercel API Key: ${VERCEL_API_KEY ? 'Configured ✓' : 'Not configured'}`);
  console.log(`========================================`);
  logMemory();
});
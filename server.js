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
app.use(express.json({ limit: '50mb' })); // 🔥 Increased for 1000+ reels
app.use(express.static(path.join(__dirname, 'public')));

// ============== JOB STORAGE ==============
const jobs = new Map();

// Clean old jobs every 30 minutes
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
  const startTime = Date.now();
  log(`📤 [Job ${jobId}] Sending results to Vercel...`);
  
  try {
    // Extract all reel URLs from the results
    const allReelUrls = [];
    const profileMap = {};
    
    for (const profile of results) {
      if (profile.reels && profile.reels.length > 0) {
        const username = profile.username || 'unknown';
        profileMap[username] = profile;
        allReelUrls.push(...profile.reels);
      }
    }

    if (allReelUrls.length === 0) {
      log(`[Job ${jobId}] No reels found to send to Vercel.`);
      return { sent: false, count: 0, message: 'No reels to send' };
    }

    log(`[Job ${jobId}] 📤 Sending ${allReelUrls.length} reels from ${Object.keys(profileMap).length} profiles to Vercel...`);
    logMemory();

    // 🔥 For large batches, send in chunks to avoid timeout
    const CHUNK_SIZE = 500;
    let totalSent = 0;
    let totalStored = 0;
    let errors = [];

    // Send to process-reels endpoint (for generating download URLs)
    if (allReelUrls.length > CHUNK_SIZE) {
      log(`[Job ${jobId}] 📦 Large batch (${allReelUrls.length}), splitting into chunks of ${CHUNK_SIZE}`);
      
      for (let i = 0; i < allReelUrls.length; i += CHUNK_SIZE) {
        const chunk = allReelUrls.slice(i, i + CHUNK_SIZE);
        const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
        const totalChunks = Math.ceil(allReelUrls.length / CHUNK_SIZE);
        
        log(`[Job ${jobId}] 📦 Sending chunk ${chunkNum}/${totalChunks} (${chunk.length} reels)...`);
        
        try {
          const payload = { 
            reels: chunk,
            job_id: jobId,
            chunk: chunkNum,
            total_chunks: totalChunks,
            timestamp: new Date().toISOString()
          };

          const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'IG-Reels-Scraper/1.0'
          };
          
          if (VERCEL_API_KEY) {
            headers['X-API-Key'] = VERCEL_API_KEY;
          }

          const response = await axios.post(VERCEL_WEBHOOK_URL, payload, {
            headers: headers,
            timeout: 120000
          });
          
          totalSent += chunk.length;
          log(`[Job ${jobId}] ✅ Chunk ${chunkNum}/${totalChunks} sent (${chunk.length} reels)`);
          
        } catch (error) {
          log(`[Job ${jobId}] ❌ Chunk ${chunkNum}/${totalChunks} failed: ${error.message}`);
          errors.push(`Chunk ${chunkNum}: ${error.message}`);
        }
        
        // Small delay between chunks
        if (i + CHUNK_SIZE < allReelUrls.length) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    } else {
      // Small batch - send all at once
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

      const response = await axios.post(VERCEL_WEBHOOK_URL, payload, {
        headers: headers,
        timeout: 120000
      });
      totalSent = allReelUrls.length;
      log(`[Job ${jobId}] ✅ Sent ${totalSent} reels to Vercel process endpoint`);
    }

    // Send to storage endpoint (for storing results)
    try {
      const storagePayload = {
        results: results,
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

      const storageResponse = await axios.post(VERCEL_STORAGE_URL, storagePayload, {
        headers: headers,
        timeout: 60000 // 60 seconds for storage
      });
      
      totalStored = results.length;
      log(`[Job ${jobId}] ✅ Stored ${totalStored} profiles on Vercel storage`);
      
    } catch (error) {
      log(`[Job ${jobId}] ❌ Storage failed: ${error.message}`);
      errors.push(`Storage: ${error.message}`);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`[Job ${jobId}] ✅ Vercel send complete: ${totalSent} reels, ${totalStored} profiles in ${elapsed}s`);
    
    return {
      sent: true,
      count: totalSent,
      profiles: totalStored,
      chunks: Math.ceil(allReelUrls.length / CHUNK_SIZE),
      errors: errors.length > 0 ? errors : null,
      message: `Sent ${totalSent} reels to Vercel`,
      elapsed: elapsed
    };
    
  } catch (error) {
    log(`[Job ${jobId}] ❌ Failed to send results to Vercel: ${error.message}`);
    if (error.response) {
      log(`[Job ${jobId}] Response: ${error.response.status} - ${JSON.stringify(error.response.data).substring(0, 200)}`);
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

  log(`📥 Received scrape request: ${usernames ? usernames.length : 0} profiles, maxReels=${maxReels || 'default'}`);

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

  // Start scraping in background (non-blocking)
  scrapeProfiles(
    cookies,
    usernames,
    { 
      maxReels: maxReels || 500, // 🔥 Default 500
      maxScrolls: maxScrolls || 200, // 🔥 Default 200 scrolls for 1000+ reels
      headless: headless !== false,
      jobId: jobId 
    },
    (message, result) => {
      job.log.push({ time: Date.now(), message });
      if (result) job.results.push(result);
    }
  )
    .then(async (allResults) => {
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
          job.log.push({ time: Date.now(), message: `❌ Failed to send: ${result.error || 'Unknown error'}` });
        }
      } else {
        job.log.push({ time: Date.now(), message: 'ℹ️ Skipped sending to Vercel (disabled)' });
      }
      
      logMemory();
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err.message;
      job.log.push({ time: Date.now(), message: `❌ Fatal error: ${err.message}` });
      log(`[Job ${jobId}] ❌ Fatal error: ${err.message}`);
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
    vercel: job.vercel || { sent: false, count: 0 },
    message: job.status === 'done' ? `✅ ${totalReels} reels from ${job.results.length} profiles` : job.status
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

// Health check endpoint with detailed info
app.get('/api/health', (req, res) => {
  const totalJobs = jobs.size;
  const runningJobs = [...jobs.values()].filter(j => j.status === 'running').length;
  const totalReels = [...jobs.values()].reduce((sum, j) => {
    return sum + j.results.reduce((s, r) => s + (r.reels ? r.reels.length : 0), 0);
  }, 0);
  
  res.json({
    status: 'healthy',
    service: 'IG Reels Scraper',
    version: '2.0.0',
    uptime: process.uptime(),
    memory_usage: process.memoryUsage(),
    config: {
      vercel_webhook: !!VERCEL_WEBHOOK_URL,
      vercel_storage: !!VERCEL_STORAGE_URL,
      vercel_api_key: !!VERCEL_API_KEY
    },
    jobs: {
      total: totalJobs,
      running: runningJobs,
      completed: totalJobs - runningJobs,
      total_reels_scraped: totalReels
    }
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
  console.log(`🔑 Vercel API Key: ${VERCEL_API_KEY ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`⚙️  Max scrolls: ${process.env.MAX_SCROLLS || 200}`);
  console.log(`🎯 Max reels: ${process.env.MAX_REELS || 500}`);
  console.log(`========================================`);
});
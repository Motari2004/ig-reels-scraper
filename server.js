'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { scrapeProfiles } = require('./scraper');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ============== 📝 ENHANCED LOGGING ==============

function logWithTimestamp(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...(data && { data })
  };
  console.log(JSON.stringify(logEntry));
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
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============== JOB STORAGE ==============

/** @type {Map<string, {id:string,status:string,log:Array,results:Array,error:string|null,startedAt:number,vercel:{sent:boolean,count:number}}>} */
const jobs = new Map();

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
  logWithTimestamp('INFO', `📤 sendReelsToVercel called for job ${jobId}`, {
    resultsCount: results ? results.length : 0
  });

  try {
    // Extract all reel URLs from the results
    const allReelUrls = [];
    let totalProfiles = 0;
    let profilesWithReels = 0;

    for (const profile of results) {
      totalProfiles++;
      if (profile.reels && profile.reels.length > 0) {
        profilesWithReels++;
        logWithTimestamp('DEBUG', `Profile ${profile.username} has ${profile.reels.length} reels`, {
          username: profile.username,
          reelCount: profile.reels.length,
          status: profile.status
        });
        
        // Log first few reels for debugging
        const sampleReels = profile.reels.slice(0, 3);
        logWithTimestamp('DEBUG', `Sample reels for ${profile.username}`, {
          sampleReels
        });
        
        allReelUrls.push(...profile.reels);
      } else {
        logWithTimestamp('WARN', `Profile ${profile.username} has no reels`, {
          username: profile.username,
          status: profile.status,
          reels: profile.reels
        });
      }
    }

    logWithTimestamp('INFO', `📊 Job ${jobId} summary`, {
      totalProfiles,
      profilesWithReels,
      totalReels: allReelUrls.length,
      firstReel: allReelUrls.length > 0 ? allReelUrls[0] : null
    });

    if (allReelUrls.length === 0) {
      logWithTimestamp('WARN', `[Job ${jobId}] No reels found to send to Vercel.`);
      return { sent: false, count: 0, message: 'No reels to send' };
    }

    logWithTimestamp('INFO', `[Job ${jobId}] Sending ${allReelUrls.length} reels to Vercel...`);

    const payload = { 
      reels: allReelUrls,
      job_id: jobId,
      timestamp: new Date().toISOString(),
      profileCount: totalProfiles,
      reelCount: allReelUrls.length
    };

    logWithTimestamp('DEBUG', `[Job ${jobId}] Payload to Vercel`, {
      jobId,
      reelCount: allReelUrls.length,
      payloadSize: JSON.stringify(payload).length
    });

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'IG-Reels-Scraper/1.0'
    };

    if (VERCEL_API_KEY) {
      headers['X-API-Key'] = VERCEL_API_KEY;
      logWithTimestamp('DEBUG', `[Job ${jobId}] Using Vercel API Key`);
    }

    // Send to process-reels endpoint
    let processResponse = null;
    try {
      logWithTimestamp('INFO', `[Job ${jobId}] Sending to Vercel process endpoint: ${VERCEL_WEBHOOK_URL}`);
      processResponse = await axios.post(VERCEL_WEBHOOK_URL, payload, {
        headers: headers,
        timeout: 120000
      });
      logWithTimestamp('INFO', `[Job ${jobId}] Vercel process endpoint responded with status ${processResponse.status}`);
    } catch (error) {
      logWithTimestamp('ERROR', `[Job ${jobId}] Failed to send to Vercel process endpoint`, {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
    }

    // Send to storage endpoint
    let storageResponse = null;
    try {
      const storagePayload = {
        results: results,
        job_id: jobId,
        timestamp: new Date().toISOString()
      };
      
      logWithTimestamp('INFO', `[Job ${jobId}] Sending to Vercel storage endpoint: ${VERCEL_STORAGE_URL}`);
      storageResponse = await axios.post(VERCEL_STORAGE_URL, storagePayload, {
        headers: headers,
        timeout: 30000
      });
      logWithTimestamp('INFO', `[Job ${jobId}] Vercel storage endpoint responded with status ${storageResponse.status}`);
    } catch (error) {
      logWithTimestamp('ERROR', `[Job ${jobId}] Failed to store results on Vercel`, {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
    }
    
    return {
      sent: true,
      count: allReelUrls.length,
      message: `Sent ${allReelUrls.length} reels to Vercel`,
      process_status: processResponse ? processResponse.status : null,
      storage_status: storageResponse ? storageResponse.status : null
    };
  } catch (error) {
    logWithTimestamp('ERROR', `[Job ${jobId}] sendReelsToVercel error`, {
      message: error.message,
      stack: error.stack
    });
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

  logWithTimestamp('INFO', '📥 Received scrape request', {
    usernames,
    maxReels,
    maxScrolls,
    headless,
    sendToVercel,
    cookiesCount: cookies ? cookies.length : 0
  });

  if (!Array.isArray(cookies) || cookies.length === 0) {
    logWithTimestamp('ERROR', 'No cookies provided', { cookies });
    return res.status(400).json({ error: 'cookies (from cookie.json) are required' });
  }
  if (!Array.isArray(usernames) || usernames.filter((u) => u && u.trim()).length === 0) {
    logWithTimestamp('ERROR', 'No usernames provided', { usernames });
    return res.status(400).json({ error: 'at least one target username is required' });
  }

  const jobId = uuidv4();
  logWithTimestamp('INFO', `📋 Created job ${jobId}`);

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

  logWithTimestamp('INFO', `🚀 Starting scrapeProfiles for job ${jobId}`);

  scrapeProfiles(
    cookies,
    usernames,
    { maxReels, maxScrolls, headless: headless !== false },
    (message, result) => {
      job.log.push({ time: Date.now(), message });
      if (result) {
        logWithTimestamp('DEBUG', `📊 Scrape progress: ${message}`, {
          username: result.username,
          status: result.status,
          reelCount: result.reels ? result.reels.length : 0
        });
        job.results.push(result);
      } else {
        logWithTimestamp('DEBUG', `📊 Scrape progress: ${message}`);
      }
    }
  )
    .then(async () => {
      job.status = 'done';
      logWithTimestamp('INFO', `✅ Job ${jobId} completed`, {
        resultsCount: job.results.length,
        allResults: job.results
      });
      
      job.log.push({ time: Date.now(), message: '✅ Scraping completed' });
      
      if (shouldSendToVercel) {
        job.log.push({ time: Date.now(), message: '📤 Sending results to Vercel...' });
        logWithTimestamp('INFO', `📤 Sending job ${jobId} results to Vercel`);
        const result = await sendReelsToVercel(jobId, job.results);
        job.vercel = result;
        
        if (result.sent) {
          job.log.push({ time: Date.now(), message: `✅ Sent ${result.count} reels to Vercel` });
          logWithTimestamp('INFO', `✅ Successfully sent ${result.count} reels to Vercel for job ${jobId}`);
        } else {
          const errorMsg = result.error || 'Unknown error';
          job.log.push({ time: Date.now(), message: `❌ Failed to send to Vercel: ${errorMsg}` });
          logWithTimestamp('ERROR', `❌ Failed to send job ${jobId} to Vercel`, { error: errorMsg });
        }
      } else {
        job.log.push({ time: Date.now(), message: 'ℹ️ Skipped sending to Vercel (disabled)' });
        logWithTimestamp('INFO', `ℹ️ Skipped sending job ${jobId} to Vercel (disabled)`);
      }
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err.message;
      job.log.push({ time: Date.now(), message: `❌ Fatal error: ${err.message}` });
      logWithTimestamp('ERROR', `❌ Job ${jobId} failed`, {
        error: err.message,
        stack: err.stack
      });
    });

  res.json({ 
    jobId,
    vercel_enabled: shouldSendToVercel,
    vercel_webhook: shouldSendToVercel ? VERCEL_WEBHOOK_URL : null
  });
});

app.get('/api/scrape/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    logWithTimestamp('WARN', `Job ${req.params.jobId} not found`);
    return res.status(404).json({ error: 'job not found' });
  }
  
  logWithTimestamp('DEBUG', `Status check for job ${req.params.jobId}`, {
    status: job.status,
    resultsCount: job.results.length
  });

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
  if (!job) {
    logWithTimestamp('WARN', `Job ${req.params.jobId} not found for download`);
    return res.status(404).json({ error: 'job not found' });
  }

  const format = (req.query.format || 'json').toLowerCase();
  logWithTimestamp('INFO', `Downloading job ${req.params.jobId} in ${format} format`);

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

app.get('/api/health', (req, res) => {
  logWithTimestamp('DEBUG', 'Health check', {
    uptime: process.uptime(),
    activeJobs: jobs.size,
    vercelStorage: !!VERCEL_STORAGE_URL
  });

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
    logWithTimestamp('WARN', 'No completed jobs found for latest request');
    return res.status(404).json({ error: 'No completed jobs found' });
  }
  
  logWithTimestamp('INFO', `Returning latest job ${latestJob.id}`, {
    resultsCount: latestJob.results.length
  });

  res.json({
    id: latestJob.id,
    status: latestJob.status,
    results: latestJob.results || [],
    startedAt: latestJob.startedAt,
    vercel: latestJob.vercel || { sent: false, count: 0 }
  });
});

app.listen(PORT, () => {
  logWithTimestamp('INFO', `IG Reels Scraper running at http://localhost:${PORT}`, {
    port: PORT,
    vercelWebhook: VERCEL_WEBHOOK_URL || 'Not configured',
    vercelStorage: VERCEL_STORAGE_URL || 'Not configured',
    vercelApiKey: VERCEL_API_KEY ? 'Configured ✓' : 'Not configured'
  });
  
  console.log(`IG Reels Scraper running at http://localhost:${PORT}`);
  console.log(`Vercel webhook: ${VERCEL_WEBHOOK_URL || 'Not configured'}`);
  console.log(`Vercel storage: ${VERCEL_STORAGE_URL || 'Not configured'}`);
  console.log(`Vercel API Key: ${VERCEL_API_KEY ? 'Configured ✓' : 'Not configured'}`);
});

// ============== ERROR HANDLING ==============

process.on('uncaughtException', (error) => {
  logWithTimestamp('FATAL', 'Uncaught Exception', {
    message: error.message,
    stack: error.stack
  });
});

process.on('unhandledRejection', (reason, promise) => {
  logWithTimestamp('FATAL', 'Unhandled Rejection', {
    reason: reason,
    promise: promise
  });
});
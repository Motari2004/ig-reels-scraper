'use strict';

const { chromium } = require('playwright');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ============== LOGGING HELPERS ==============
let currentJobId = null;
let currentProfile = null;
let reelCount = 0;
let scrollCount = 0;
let startTime = null;

function log(message, data = null) {
  const timestamp = new Date().toISOString();
  const prefix = currentJobId ? `[Job ${currentJobId}]` : '';
  const profilePrefix = currentProfile ? ` @${currentProfile}` : '';
  const reelsPrefix = reelCount > 0 ? ` (${reelCount} reels)` : '';
  const scrollPrefix = scrollCount > 0 ? ` [scroll ${scrollCount}]` : '';
  
  console.log(`${timestamp} ${prefix}${profilePrefix}${scrollPrefix}${reelsPrefix} ${message}`);
  if (data) {
    console.log(`${timestamp} ${prefix} DATA:`, JSON.stringify(data, null, 2).substring(0, 500));
  }
}

function logMemory() {
  const used = process.memoryUsage();
  const mb = (used.heapUsed / 1024 / 1024).toFixed(1);
  log(`💾 MEMORY: ${mb}MB heap used (rss: ${(used.rss / 1024 / 1024).toFixed(1)}MB)`);
}

// ============== COOKIE FUNCTIONS ==============

function normalizeCookies(rawCookies) {
  const sameSiteMap = {
    no_restriction: 'None',
    unspecified: 'Lax',
    lax: 'Lax',
    strict: 'Strict',
    none: 'None',
  };

  log(`🍪 Normalizing ${rawCookies.length} cookies...`);
  
  return rawCookies
    .filter((c) => c && c.name && c.value !== undefined && c.domain)
    .map((c) => {
      const cookie = {
        name: c.name,
        value: String(c.value),
        domain: c.domain,
        path: c.path || '/',
        secure: c.secure !== undefined ? Boolean(c.secure) : true,
        httpOnly: Boolean(c.httpOnly),
      };

      const expiration = c.expirationDate || c.expires;
      if (expiration && expiration > 0) {
        cookie.expires = Math.floor(expiration);
      }

      const rawSameSite = (c.sameSite || 'lax').toString().toLowerCase();
      cookie.sameSite = sameSiteMap[rawSameSite] || 'Lax';
      if (cookie.sameSite === 'None') cookie.secure = true;

      return cookie;
    });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

// ============== REEL COLLECTION ==============

async function collectReelUrls(page, { maxReels, maxScrolls }) {
  const seen = new Set();
  let previousHeight = 0;
  let stableRounds = 0;
  let noNewReelsCount = 0;
  let scrollCount = 0;
  let previousSeenSize = 0;
  
  log(`🔍 Starting reel collection with maxReels=${maxReels || 'unlimited'}, maxScrolls=${maxScrolls}`);

  const scrapeVisible = async () => {
    const hrefs = await page.$$eval('a[href*="/reel/"]', (as) =>
      as.map((a) => a.getAttribute('href')).filter(Boolean)
    );
    for (const href of hrefs) {
      const full = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
      seen.add(full.split('?')[0]);
    }
    return hrefs.length;
  };

  // Initial scrape
  log('📊 Initial scrape...');
  const initialCount = await scrapeVisible();
  previousSeenSize = seen.size;
  reelCount = seen.size;
  log(`📊 Initial scrape found ${seen.size} reels (${initialCount} links)`);
  
  if (seen.size === 0) {
    log('⚠️ No reels found in initial scrape, waiting longer...');
    await randomDelay(3000, 5000);
    const retryCount = await scrapeVisible();
    reelCount = seen.size;
    log(`📊 Retry scrape found ${seen.size} reels (${retryCount} links)`);
  }

  const maxScrollLimit = maxScrolls || 200;
  log(`🔄 Starting scroll loop with ${maxScrollLimit} scrolls max`);

  for (let i = 0; i < maxScrollLimit; i++) {
    if (maxReels && seen.size >= maxReels) {
      log(`🎯 Reached max reels limit: ${maxReels}`);
      break;
    }

    // Scroll
    const scrollDistance = 2000 + Math.random() * 1500;
    await page.mouse.wheel(0, scrollDistance);
    await randomDelay(800, 1600);
    
    // Scrape
    const newLinks = await scrapeVisible();
    const newSeenSize = seen.size;
    const newReels = newSeenSize - previousSeenSize;
    scrollCount = i + 1;
    reelCount = seen.size;
    
    // Log scroll progress
    if (scrollCount % 5 === 0 || newReels > 0) {
      log(`🔄 Scroll ${scrollCount}/${maxScrollLimit}: ${reelCount} reels (+${newReels}) | ${newLinks} links found`);
    }

    // Check feed growth
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) {
      stableRounds += 1;
      if (stableRounds >= 3) {
        log(`📌 Feed stopped growing after ${stableRounds} stable scrolls`);
        break;
      }
    } else {
      stableRounds = 0;
    }
    
    // No new reels detection
    if (newReels === 0 && scrollCount > 3) {
      noNewReelsCount++;
      if (noNewReelsCount >= 4) {
        log(`📌 No new reels in last 4 scrolls`);
        break;
      }
    } else {
      noNewReelsCount = 0;
    }
    
    previousHeight = currentHeight;
    previousSeenSize = seen.size;
    
    await randomDelay(100, 300);
  }

  const totalReels = seen.size;
  log(`✅ FINISHED: ${scrollCount} scrolls, ${totalReels} reels collected`);
  log(`📊 Average: ${scrollCount > 0 ? Math.round(totalReels / scrollCount) : 0} reels/scroll`);

  const urls = [...seen];
  return maxReels ? urls.slice(0, maxReels) : urls;
}

// ============== SINGLE PROFILE SCRAPING ==============

async function scrapeOneProfile(context, username, options) {
  const page = await context.newPage();
  const cleanUsername = username.trim().replace(/^@/, '');
  currentProfile = cleanUsername;
  
  log(`🚀 Starting profile scrape...`);

  try {
    const url = `https://www.instagram.com/${encodeURIComponent(cleanUsername)}/reels/`;
    log(`🌐 Navigating to: ${url}`);

    const response = await page.goto(url, { 
      waitUntil: 'domcontentloaded', 
      timeout: 45000 
    });
    
    log(`📄 Page loaded, status: ${response ? response.status() : 'unknown'}`);
    await randomDelay(1200, 2200);

    if (response && [404].includes(response.status())) {
      log('❌ Profile not found (404)');
      return { username: cleanUsername, status: 'not_found', reels: [] };
    }

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    log(`📄 Body text length: ${bodyText.length} characters`);

    if (/Log in to see|Log In • Instagram/i.test(bodyText) && /password/i.test(bodyText)) {
      log('🔒 Login wall detected - cookies may be expired');
      return { username: cleanUsername, status: 'login_wall', reels: [] };
    }

    if (/This Account is Private/i.test(bodyText)) {
      log('🔒 Account is private');
      return { username: cleanUsername, status: 'private', reels: [] };
    }

    if (/Sorry, this page isn't available/i.test(bodyText)) {
      log('❌ Page not available');
      return { username: cleanUsername, status: 'not_found', reels: [] };
    }

    if (/No posts yet|No Posts Yet|no posts yet/i.test(bodyText)) {
      log('📭 No posts on this account');
      return { username: cleanUsername, status: 'no_posts', reels: [] };
    }

    const reels = await collectReelUrls(page, options);
    log(`✅ @${cleanUsername}: ${reels.length} reels found`);
    
    return {
      username: cleanUsername,
      status: reels.length ? 'ok' : 'no_reels_found',
      reels,
    };
    
  } catch (err) {
    log(`❌ Error scraping @${cleanUsername}: ${err.message}`);
    return { 
      username: cleanUsername, 
      status: 'error', 
      error: err.message, 
      reels: [] 
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// ============== MAIN SCRAPE FUNCTION ==============

async function scrapeProfiles(cookies, usernames, options, onProgress) {
  const opts = {
    maxReels: options.maxReels && options.maxReels > 0 ? options.maxReels : null,
    maxScrolls: options.maxScrolls && options.maxScrolls > 0 ? options.maxScrolls : 200,
    headless: options.headless !== false,
  };

  global.startTime = Date.now();
  currentJobId = options.jobId || 'unknown';
  
  log(`🚀 STARTING SCRAPE JOB`);
  log(`📋 ${usernames.length} profiles: ${usernames.join(', ')}`);
  log(`⚙️ Options: maxReels=${opts.maxReels || 'unlimited'}, maxScrolls=${opts.maxScrolls}, headless=${opts.headless}`);
  logMemory();

  onProgress(`Launching browser (headless: ${opts.headless})`, null);
  
  const browser = await chromium.launch({ 
    headless: opts.headless,
    args: [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });
  log('✅ Browser launched');

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    log('✅ Browser context created');

    const normalized = normalizeCookies(cookies);
    log(`🍪 Normalized ${normalized.length} cookies`);
    
    if (normalized.length === 0) {
      throw new Error('No valid cookies found after normalizing cookie.json — check the file format.');
    }
    
    await context.addCookies(normalized);
    log(`🍪 Loaded ${normalized.length} cookies into browser session`);

    const allResults = [];
    const totalProfiles = usernames.length;
    let completedProfiles = 0;
    let totalReelsFound = 0;

    for (let i = 0; i < usernames.length; i++) {
      const username = usernames[i];
      if (!username || !username.trim()) continue;

      const cleanUsername = username.trim().replace(/^@/, '');
      currentProfile = cleanUsername;
      
      log(`📌 [${i+1}/${totalProfiles}] Processing @${cleanUsername}...`);
      
      onProgress(`(${i+1}/${totalProfiles}) Scraping @${cleanUsername}…`, null);
      
      const result = await scrapeOneProfile(context, username, opts);
      
      completedProfiles++;
      
      if (result.status === 'ok') {
        totalReelsFound += result.reels.length;
        log(`✅ @${cleanUsername}: ${result.reels.length} reels | Total: ${totalReelsFound} reels`);
        onProgress(`Found ${result.reels.length} reel URL(s) for @${result.username}`, result);
      } else if (result.status === 'login_wall') {
        log(`🔒 @${cleanUsername}: login wall - cookies may be expired`);
        onProgress(`@${result.username}: hit a login wall — cookies may be expired or invalid`, result);
      } else if (result.status === 'private') {
        log(`🔒 @${cleanUsername}: account is private`);
        onProgress(`@${result.username}: account is private`, result);
      } else if (result.status === 'not_found') {
        log(`❌ @${cleanUsername}: profile not found`);
        onProgress(`@${result.username}: profile not found`, result);
      } else if (result.status === 'no_reels_found' || result.status === 'no_posts') {
        log(`ℹ️ @${cleanUsername}: ${result.status}`);
        onProgress(`@${result.username}: ${result.status}`, result);
      } else {
        log(`⚠️ @${cleanUsername}: ${result.error || 'unknown error'}`);
        onProgress(`@${result.username}: error — ${result.error || 'unknown error'}`, result);
      }
      
      allResults.push(result);

      const elapsed = Math.round((Date.now() - global.startTime) / 1000);
      log(`📊 PROGRESS: ${completedProfiles}/${totalProfiles} profiles, ${totalReelsFound} total reels, ${elapsed}s elapsed`);
      logMemory();

      if (i < usernames.length - 1) {
        const delay = 2500 + Math.random() * 3000;
        log(`⏳ Waiting ${Math.round(delay/1000)}s before next profile...`);
        await randomDelay(delay * 0.8, delay * 1.2);
      }
    }

    const totalTime = Math.round((Date.now() - global.startTime) / 1000);
    log(`🎉 SCRAPE COMPLETE: ${completedProfiles} profiles, ${totalReelsFound} total reels in ${totalTime}s`);
    logMemory();

    onProgress(`✅ Complete: ${totalReelsFound} reels from ${completedProfiles} profiles`, null);
    
    // 🔥 FIX: Return the results array
    return allResults;
    
  } catch (err) {
    log(`❌ FATAL ERROR: ${err.message}`);
    if (err.stack) {
      log(`📚 Stack: ${err.stack}`);
    }
    throw err;
  } finally {
    await browser.close().catch(() => {});
    log('🔒 Browser closed');
  }
}

module.exports = { scrapeProfiles, normalizeCookies };
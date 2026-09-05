'use strict';

const { chromium } = require('playwright');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ============== LOGGING ==============
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

function logProgress() {
  const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
  const elapsedStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
  log(`📊 PROGRESS: ${reelCount} reels collected in ${elapsedStr} (${scrollCount} scrolls)`);
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

// ============== REEL COLLECTION WITH DETAILED LOGGING ==============

/**
 * Scroll the reels grid, collecting /reel/ links as they load.
 * 🔥 OPTIMIZED: Continue until maxReels is reached or no more reels load.
 * Supports 1000+ reels with detailed progress logging.
 */
async function collectReelUrls(page, { maxReels, maxScrolls, username }) {
  const seen = new Set();
  let previousHeight = 0;
  let stableRounds = 0;
  let noNewReelsCount = 0;
  let scrollCount = 0;
  let previousSeenSize = 0;
  let startTime = Date.now();
  
  currentProfile = username;
  reelCount = 0;
  scrollCount = 0;

  const scrapeVisible = async () => {
    const hrefs = await page.$$eval('a[href*="/reel/"]', (as) =>
      as.map((a) => a.getAttribute('href')).filter(Boolean)
    );
    for (const href of hrefs) {
      const full = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
      seen.add(full.split('?')[0]);
    }
  };

  // Initial scrape
  log('🔍 Starting reel collection...');
  await scrapeVisible();
  previousSeenSize = seen.size;
  reelCount = seen.size;
  log(`📊 Initial scrape: ${seen.size} reels found`);
  logMemory();

  // 🔥 FIX: Allow up to 200 scrolls for 1000+ reels
  const maxScrollLimit = maxScrolls || 200;
  log(`🎯 Target: ${maxReels || 'unlimited'} reels, ${maxScrollLimit} scrolls max`);

  while (scrollCount < maxScrollLimit) {
    if (maxReels && seen.size >= maxReels) {
      log(`🎯 Reached max reels limit: ${maxReels}`);
      break;
    }

    // Scroll down with random distance
    const scrollDistance = 2000 + Math.random() * 1500;
    await page.mouse.wheel(0, scrollDistance);
    
    // Wait with random delay for content to load
    const loadDelay = 800 + Math.random() * 1200;
    await randomDelay(loadDelay * 0.8, loadDelay * 1.2);

    // Scrape current view
    await scrapeVisible();

    // Check feed growth
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    const newSeenSize = seen.size;
    const newReels = newSeenSize - previousSeenSize;
    
    scrollCount++;
    reelCount = seen.size;
    
    // Log progress every scroll (but more detailed)
    if (scrollCount % 5 === 0 || newReels > 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const reelsPerScroll = Math.round(reelCount / scrollCount);
      log(`🔄 Scroll ${scrollCount}/${maxScrollLimit}: ${reelCount} reels (+${newReels}) | ${reelsPerScroll}/scroll | ${elapsed}s elapsed`);
    }
    
    // Log progress every 50 reels
    if (reelCount % 50 === 0 && reelCount > 0) {
      logProgress();
      logMemory();
    }

    // End detection - feed stopped growing
    if (currentHeight === previousHeight) {
      stableRounds += 1;
      if (stableRounds >= 3) {
        log(`📌 Feed stopped growing - reached end of reels (${stableRounds} stable scrolls)`);
        break;
      }
    } else {
      stableRounds = 0;
    }
    
    // No new reels detection
    if (newReels === 0 && scrollCount > 3) {
      noNewReelsCount++;
      if (noNewReelsCount >= 4) {
        log(`📌 No new reels in last 4 scrolls - reached end`);
        break;
      }
    } else {
      noNewReelsCount = 0;
    }
    
    previousHeight = currentHeight;
    previousSeenSize = seen.size;
    
    // Random small delay between scrolls
    await randomDelay(150, 350);
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const totalReels = seen.size;
  log(`✅ FINISHED: ${scrollCount} scrolls, ${totalReels} reels collected in ${totalTime}s`);
  log(`📊 Average: ${Math.round(totalReels / scrollCount)} reels/scroll`);
  logMemory();

  const urls = [...seen];
  return maxReels ? urls.slice(0, maxReels) : urls;
}

// ============== SINGLE PROFILE SCRAPING ==============

async function scrapeOneProfile(context, username, options) {
  const page = await context.newPage();
  const cleanUsername = username.trim().replace(/^@/, '');
  currentProfile = cleanUsername;
  
  log(`🚀 Starting profile scrape...`);
  const startTime = Date.now();

  try {
    const url = `https://www.instagram.com/${encodeURIComponent(cleanUsername)}/reels/`;
    log(`🌐 Navigating to: ${url}`);
    
    const response = await page.goto(url, { 
      waitUntil: 'domcontentloaded', 
      timeout: 45000 
    });
    
    await randomDelay(1200, 2200);
    log(`📄 Page loaded, status: ${response ? response.status() : 'unknown'}`);

    // Check for errors
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    
    if (response && [404].includes(response.status())) {
      log('❌ Profile not found (404)');
      return { username: cleanUsername, status: 'not_found', reels: [] };
    }

    if (/Log in to see|Log In • Instagram/i.test(bodyText) && /password/i.test(bodyText)) {
      log('🔒 Login wall - cookies may be expired');
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

    // Check for reels grid
    const hasReels = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/reel/"]');
      return links.length > 0;
    });
    
    if (!hasReels) {
      log('ℹ️ No reels found on profile');
      return { username: cleanUsername, status: 'no_reels_found', reels: [] };
    }
    
    log(`✅ Found ${await page.evaluate(() => document.querySelectorAll('a[href*="/reel/"]').length)} reels on initial load`);

    const reels = await collectReelUrls(page, { 
      ...options, 
      username: cleanUsername 
    });
    
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`✅ Completed @${cleanUsername}: ${reels.length} reels in ${elapsed}s`);
    
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

/**
 * Run the full scrape job with detailed logging.
 * @param {Array} cookies - raw cookie objects from cookie.json
 * @param {Array<string>} usernames
 * @param {{maxReels?: number, maxScrolls?: number, headless?: boolean}} options
 * @param {(message: string, resultOrNull: object|null) => void} onProgress
 */
async function scrapeProfiles(cookies, usernames, options, onProgress) {
  const opts = {
    maxReels: options.maxReels && options.maxReels > 0 ? options.maxReels : null,
    maxScrolls: options.maxScrolls && options.maxScrolls > 0 ? options.maxScrolls : 200, // 🔥 Increased to 200 for 1000+ reels
    headless: options.headless !== false,
  };

  global.startTime = Date.now();
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
      '--disable-setuid-sandbox',
    ]
  });

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });

    const normalized = normalizeCookies(cookies);
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
      currentJobId = options.jobId || 'unknown';
      currentProfile = cleanUsername;
      
      log(`📌 [${i+1}/${totalProfiles}] Processing @${cleanUsername}...`);
      const profileStart = Date.now();
      
      onProgress(`(${i+1}/${totalProfiles}) Scraping @${cleanUsername}…`, null);
      
      const result = await scrapeOneProfile(context, username, opts);
      
      const profileTime = Math.round((Date.now() - profileStart) / 1000);
      completedProfiles++;
      
      if (result.status === 'ok') {
        totalReelsFound += result.reels.length;
        log(`✅ @${cleanUsername}: ${result.reels.length} reels (${profileTime}s) | Total: ${totalReelsFound} reels`);
        onProgress(`Found ${result.reels.length} reel URL(s) for @${result.username}`, result);
      } else if (result.status === 'login_wall') {
        log(`🔒 @${cleanUsername}: login wall - cookies may be expired`);
        onProgress(`@${result.username}: hit a login wall — cookies may be expired or invalid`, result);
      } else if (result.status === 'private') {
        log(`🔒 @${cleanUsername}: account is private`);
        onProgress(`@${result.username}: account is private and not accessible with this session`, result);
      } else if (result.status === 'not_found') {
        log(`❌ @${cleanUsername}: profile not found`);
        onProgress(`@${result.username}: profile not found`, result);
      } else if (result.status === 'no_reels_found') {
        log(`ℹ️ @${cleanUsername}: no reels found`);
        onProgress(`@${result.username}: no reels found on the profile`, result);
      } else {
        log(`⚠️ @${cleanUsername}: ${result.error || 'unknown error'}`);
        onProgress(`@${result.username}: error — ${result.error || 'unknown error'}`, result);
      }
      
      allResults.push(result);

      // Progress logging
      const elapsed = Math.round((Date.now() - global.startTime) / 1000);
      const avgTime = Math.round(elapsed / completedProfiles);
      log(`📊 PROGRESS: ${completedProfiles}/${totalProfiles} profiles, ${totalReelsFound} total reels, ${elapsed}s elapsed, avg ${avgTime}s/profile`);
      logMemory();

      if (i < usernames.length - 1) {
        const delay = 3000 + Math.random() * 4000;
        log(`⏳ Waiting ${Math.round(delay/1000)}s before next profile...`);
        await randomDelay(delay * 0.8, delay * 1.2);
      }
    }

    const totalTime = Math.round((Date.now() - global.startTime) / 1000);
    log(`🎉 SCRAPE COMPLETE: ${completedProfiles} profiles, ${totalReelsFound} total reels in ${totalTime}s`);
    log(`📊 Average: ${Math.round(totalReelsFound / completedProfiles)} reels/profile, ${Math.round(totalTime / completedProfiles)}s/profile`);
    logMemory();

    onProgress(`✅ Complete: ${totalReelsFound} reels from ${completedProfiles} profiles`, null);
    
    return allResults;
    
  } catch (err) {
    log(`❌ FATAL ERROR: ${err.message}`);
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeProfiles, normalizeCookies };
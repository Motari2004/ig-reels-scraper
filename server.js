'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ============== LOGGING ==============
function log(message, jobId = null) {
  const timestamp = new Date().toISOString();
  const prefix = jobId ? `[Job ${jobId}]` : '';
  console.log(`${timestamp} ${prefix} ${message}`);
}

function logMemory(jobId = null) {
  const used = process.memoryUsage();
  const mb = (used.heapUsed / 1024 / 1024).toFixed(1);
  log(`💾 MEMORY: ${mb}MB heap used (rss: ${(used.rss / 1024 / 1024).toFixed(1)}MB)`, jobId);
}

// ============== USER AGENTS ==============
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ============== WRITE COOKIES ==============
function writeNetscapeCookies(cookieData, filepath) {
  let content = '# Netscape HTTP Cookie File\n';
  for (const cookie of cookieData) {
    if (!cookie.domain || !cookie.name) continue;
    const domain = cookie.domain;
    const flag = cookie.hostOnly === true ? 'FALSE' : 'TRUE';
    const path = cookie.path || '/';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expiry = cookie.expirationDate || cookie.expiry || 0;
    const name = cookie.name;
    const value = cookie.value || '';
    content += `${domain}\t${flag}\t${path}\t${secure}\t${expiry}\t${name}\t${value}\n`;
  }
  fs.writeFileSync(filepath, content);
  return filepath;
}

// ============== SLEEP ==============
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============== RETRY NAVIGATION ==============
async function navigateWithRetry(page, url, jobId, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        const waitTime = Math.pow(2, attempt) * 3; // 6, 12 seconds
        log(`⏳ Navigation retry ${attempt}/${maxRetries} for @${url.split('/')[3]} in ${waitTime}s...`, jobId);
        await sleep(waitTime * 1000);
      }
      
      log(`🌐 Navigating (attempt ${attempt}/${maxRetries}): ${url}`, jobId);
      
      // Try with different wait strategies
      const waitStrategy = attempt === 1 ? 'domcontentloaded' : 'load';
      const timeout = attempt === 1 ? 45000 : 60000; // 45s first, then 60s
      
      await page.goto(url, {
        waitUntil: waitStrategy,
        timeout: timeout,
      });
      
      // If we get here, navigation succeeded!
      log(`✅ Navigation successful on attempt ${attempt}`, jobId);
      return true;
      
    } catch (error) {
      lastError = error;
      log(`⚠️ Navigation attempt ${attempt} failed: ${error.message}`, jobId);
      
      // Check if it's a timeout error
      if (error.message.includes('Timeout') || error.message.includes('timeout')) {
        log(`⏰ Timeout on attempt ${attempt}, will retry...`, jobId);
        continue;
      }
      
      // Check if it's a connection error
      if (error.message.includes('Connection') || error.message.includes('ECONNREFUSED') || error.message.includes('ERR_CONNECTION')) {
        log(`🔌 Connection error on attempt ${attempt}, will retry...`, jobId);
        continue;
      }
      
      // For other errors, don't retry
      log(`❌ Non-retryable error: ${error.message}`, jobId);
      break;
    }
  }
  
  log(`❌ Navigation failed after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`, jobId);
  throw lastError || new Error('Navigation failed after retries');
}

// ============== SCRAPE PROFILE ==============
async function scrapeProfile(browser, cookies, username, options, progressCallback) {
  const maxReels = options.maxReels || 500;
  const maxScrolls = options.maxScrolls || 200;
  const jobId = options.jobId;
  const startTime = Date.now();
  
  log(`🚀 @${username} Starting profile scrape...`, jobId);
  
  const context = await browser.newContext({
    userAgent: getRandomUserAgent(),
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  
  // Add cookies
  if (cookies && cookies.length > 0) {
    await context.addCookies(cookies.map(c => ({
      name: c.name,
      value: c.value || '',
      domain: c.domain || '.instagram.com',
      path: c.path || '/',
      secure: c.secure || false,
      httpOnly: c.httpOnly || false,
      expires: c.expirationDate || c.expiry || -1,
    })));
  }
  
  const page = await context.newPage();
  
  try {
    // Set extra headers to avoid detection
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    });
    
    const url = `https://www.instagram.com/${username}/reels/`;
    log(`@${username} 🌐 Navigating to: ${url}`, jobId);
    
    // 🔥 USE RETRY NAVIGATION
    await navigateWithRetry(page, url, jobId, 3);
    
    // Check if we're on a login page
    const loginCheck = await page.$('input[name="username"]');
    if (loginCheck) {
      log(`@${username} 🔴 Login page detected! Cookies expired.`, jobId);
      await context.close();
      return { username, status: 'error', reels: [], error: 'Login required - cookies expired' };
    }
    
    // Check for rate limiting
    const rateLimitCheck = await page.$('text="Try Again Later"');
    if (rateLimitCheck) {
      log(`@${username} 🔴 Rate limited!`, jobId);
      await context.close();
      return { username, status: 'error', reels: [], error: 'Rate limited by Instagram' };
    }
    
    // Check for private account
    const privateCheck = await page.$('text="This Account is Private"');
    if (privateCheck) {
      log(`@${username} 🔒 Account is private`, jobId);
      await context.close();
      return { username, status: 'private', reels: [], error: 'Account is private' };
    }
    
    // Check if account exists
    const notFound = await page.$('text="Sorry, this page isn\'t available"');
    if (notFound) {
      log(`@${username} ❌ Account not found`, jobId);
      await context.close();
      return { username, status: 'not_found', reels: [], error: 'Account not found' };
    }
    
    // Wait for reels to load
    await page.waitForSelector('article, [class*="x1yztbdb"], [class*="x1n2onr6"]', { timeout: 15000 }).catch(() => {
      log(`@${username} ⚠️ No reels found, might be no posts`, jobId);
    });
    
    // Scroll and collect reels
    const reels = new Set();
    let scrollCount = 0;
    let noNewReelsCount = 0;
    let previousCount = 0;
    
    log(`@${username} 📊 Starting scroll loop with ${maxScrolls} scrolls max`, jobId);
    
    while (scrollCount < maxScrolls && reels.size < maxReels) {
      // Get current reels
      const currentReels = await page.evaluate(() => {
        const links = [];
        const anchors = document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]');
        for (const a of anchors) {
          const href = a.getAttribute('href');
          if (href && (href.includes('/reel/') || href.includes('/p/'))) {
            const url = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
            if (!links.includes(url)) links.push(url);
          }
        }
        return links;
      });
      
      // Add new reels to set
      for (const url of currentReels) {
        reels.add(url);
      }
      
      const newCount = reels.size;
      const newReelsFound = newCount - previousCount;
      
      if (newReelsFound > 0) {
        noNewReelsCount = 0;
        log(`@${username} (${newCount} reels) 🔄 Scroll ${scrollCount+1}/${maxScrolls}: ${newCount} reels (+${newReelsFound})`, jobId);
        
        if (progressCallback) {
          progressCallback(`@${username}: ${newCount} reels found`);
        }
      } else {
        noNewReelsCount++;
        if (noNewReelsCount >= 3) {
          log(`@${username} 📌 No new reels for 3 scrolls, stopping`, jobId);
          break;
        }
      }
      
      previousCount = newCount;
      
      // Scroll down
      await page.evaluate('window.scrollBy(0, window.innerHeight)');
      await sleep(1500 + Math.random() * 2000);
      
      scrollCount++;
      
      // Every 10 scrolls, check if we're still on the page
      if (scrollCount % 10 === 0) {
        try {
          await page.evaluate('document.title');
        } catch (e) {
          log(`@${username} ⚠️ Page lost, stopping`, jobId);
          break;
        }
      }
    }
    
    const finalReels = Array.from(reels);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    log(`@${username} ✅ Done: ${finalReels.length} reels in ${elapsed}s`, jobId);
    
    await context.close();
    return { username, status: 'ok', reels: finalReels };
    
  } catch (error) {
    log(`@${username} ❌ Error scraping @${username}: ${error.message}`, jobId);
    if (error.stack) {
      log(`@${username} 📚 Stack: ${error.stack.substring(0, 500)}`, jobId);
    }
    await context.close().catch(() => {});
    
    // Return error result instead of throwing
    return { username, status: 'error', reels: [], error: error.message };
  }
}

// ============== SCRAPE PROFILES ==============
async function scrapeProfiles(cookies, usernames, options, progressCallback) {
  const maxReels = options.maxReels || 500;
  const maxScrolls = options.maxScrolls || 200;
  const headless = options.headless !== false;
  const jobId = options.jobId;
  
  log(`🚀 Starting scrape for ${usernames.length} profiles`, jobId);
  log(`📊 Settings: maxReels=${maxReels}, maxScrolls=${maxScrolls}, headless=${headless}`, jobId);
  
  const browser = await chromium.launch({
    headless: headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',
      '--disable-web-security',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  
  const results = [];
  
  try {
    for (let i = 0; i < usernames.length; i++) {
      const username = usernames[i].trim();
      if (!username) continue;
      
      log(`📊 PROGRESS: ${i+1}/${usernames.length} profiles`, jobId);
      
      const result = await scrapeProfile(
        browser, 
        cookies, 
        username, 
        { maxReels, maxScrolls, headless, jobId },
        progressCallback
      );
      
      results.push(result);
      
      // Progress callback
      if (progressCallback) {
        const totalReels = results.reduce((sum, r) => sum + (r.reels ? r.reels.length : 0), 0);
        progressCallback(`📊 PROGRESS: ${i+1}/${usernames.length} profiles, ${totalReels} total reels, ${((Date.now() - options.startTime) / 1000).toFixed(0)}s elapsed`);
      }
      
      // Add delay between profiles to avoid rate limiting
      if (i < usernames.length - 1) {
        const delay = 2000 + Math.random() * 3000;
        log(`⏳ Waiting ${(delay/1000).toFixed(1)}s before next profile...`, jobId);
        await sleep(delay);
      }
    }
    
    log(`✅ All profiles done: ${results.length} profiles`, jobId);
    logMemory(jobId);
    
    return results;
    
  } catch (error) {
    log(`❌ Fatal error: ${error.message}`, jobId);
    if (error.stack) {
      log(`📚 Stack: ${error.stack}`, jobId);
    }
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeProfiles };
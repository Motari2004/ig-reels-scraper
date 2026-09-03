'use strict';

const { chromium } = require('playwright');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Convert cookies exported from a browser extension (Cookie-Editor, EditThisCookie, etc.)
 * into the shape Playwright's context.addCookies() expects.
 */
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

// ============== 🔥 NEW: Get Reels WITH Captions in One Pass ==============

/**
 * Scroll the reels grid, collecting /reel/ links AND their captions as they load.
 * Returns: [{ url: "...", caption: "..." }, ...]
 */
async function collectReelData(page, { maxReels, maxScrolls }) {
  // Use Map to store unique reels by URL
  const seen = new Map();

  const scrapeVisible = async () => {
    // Get ALL reel data in one go - URL + Caption
    const reelData = await page.$$eval('a[href*="/reel/"]', (links) => {
      return links.map((link) => {
        const href = link.getAttribute('href');
        
        // Try multiple ways to find the caption text
        let caption = '';
        
        // Method 1: Find the closest article container
        let container = link.closest('article');
        if (!container) container = link.closest('div[role="article"]');
        if (!container) container = link.closest('div[class*="x1yztbdb"]');
        if (!container) container = link.parentElement;
        
        if (container) {
          // Try different selectors that might contain the caption
          const captionSelectors = [
            'h1',
            'h1 span',
            'div[class*="x1n2onr6"]',
            'div[class*="_a9zr"]',
            'span[class*="x1lliihq"]',
            'div[class*="x1iorvi4"]',
            'div[class*="x1uvtmcs"]'
          ];
          
          for (const selector of captionSelectors) {
            try {
              const el = container.querySelector(selector);
              if (el && el.textContent) {
                const text = el.textContent.trim();
                // Only accept if it's a reasonable length (not just a number or short text)
                if (text.length > 5 && !/^[0-9,]+$/.test(text)) {
                  caption = text;
                  break;
                }
              }
            } catch (e) {
              // Ignore selector errors
            }
          }
          
          // If still no caption, try to get it from the article's text
          if (!caption) {
            try {
              const articleText = container.textContent || '';
              // Look for caption patterns - often after the video thumbnail
              const lines = articleText.split('\n').map(l => l.trim()).filter(l => l.length > 10);
              // The caption is usually the first meaningful text line after the video
              if (lines.length > 0) {
                // Skip lines that look like dates, numbers, or usernames
                for (const line of lines) {
                  if (!/^[0-9,]+$/.test(line) && 
                      !/^[0-9]+[smh]$/.test(line) && 
                      !line.startsWith('@') &&
                      !/^[0-9]+\s+[a-z]+$/.test(line) &&
                      line.length > 3) {
                    caption = line;
                    break;
                  }
                }
              }
            } catch (e) {}
          }
        }
        
        return { href, caption };
      });
    });

    // Add to seen map, keeping the first caption found
    for (const { href, caption } of reelData) {
      if (href) {
        const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
        const cleanUrl = fullUrl.split('?')[0];
        if (!seen.has(cleanUrl)) {
          seen.set(cleanUrl, { url: cleanUrl, caption: caption || '' });
        } else if (caption && !seen.get(cleanUrl).caption) {
          // Update if we found a caption for an existing entry
          const existing = seen.get(cleanUrl);
          seen.set(cleanUrl, { ...existing, caption });
        }
      }
    }
  };

  // Initial scrape
  await scrapeVisible();

  let previousHeight = 0;
  let stableRounds = 0;

  for (let i = 0; i < maxScrolls; i++) {
    if (maxReels && seen.size >= maxReels) break;

    await page.mouse.wheel(0, 2600);
    await randomDelay(900, 1800);
    await scrapeVisible();

    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) {
      stableRounds += 1;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
    }
    previousHeight = currentHeight;
  }

  const results = Array.from(seen.values());
  return maxReels ? results.slice(0, maxReels) : results;
}

// ============== PROFILE SCRAPING ==============

async function scrapeOneProfile(context, username, options, onProgress) {
  const page = await context.newPage();
  try {
    const cleanUsername = username.trim().replace(/^@/, '');
    const url = `https://www.instagram.com/${encodeURIComponent(cleanUsername)}/reels/`;

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await randomDelay(1200, 2200);

    if (response && [404].includes(response.status())) {
      return { username: cleanUsername, status: 'not_found', reels: [] };
    }

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');

    if (/Log in to see|Log In • Instagram/i.test(bodyText) && /password/i.test(bodyText)) {
      return { username: cleanUsername, status: 'login_wall', reels: [] };
    }

    if (/This Account is Private/i.test(bodyText)) {
      return { username: cleanUsername, status: 'private', reels: [] };
    }

    if (/Sorry, this page isn't available/i.test(bodyText)) {
      return { username: cleanUsername, status: 'not_found', reels: [] };
    }

    // 🔥 NEW: Get reels WITH captions
    const reelsWithData = await collectReelData(page, options);
    
    // Count how many have captions
    const withCaptions = reelsWithData.filter(r => r.caption && r.caption.trim().length > 0);
    
    if (onProgress) {
      onProgress(`✅ @${cleanUsername}: ${reelsWithData.length} reels, ${withCaptions.length} with captions`, null);
    }
    
    // Extract just the URLs for backward compatibility (reels array)
    const reelUrls = reelsWithData.map(r => r.url);
    
    return {
      username: cleanUsername,
      status: reelUrls.length ? 'ok' : 'no_reels_found',
      reels: reelUrls,
      reels_with_captions: reelsWithData, // 🔥 NEW: Full data with captions
    };
  } catch (err) {
    return { 
      username: username.trim().replace(/^@/, ''), 
      status: 'error', 
      error: err.message, 
      reels: [],
      reels_with_captions: []
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Run the full scrape job with captions.
 * @param {Array} cookies - raw cookie objects from cookie.json
 * @param {Array<string>} usernames
 * @param {{maxReels?: number, maxScrolls?: number, headless?: boolean}} options
 * @param {(message: string, resultOrNull: object|null) => void} onProgress
 */
async function scrapeProfiles(cookies, usernames, options, onProgress) {
  const opts = {
    maxReels: options.maxReels && options.maxReels > 0 ? options.maxReels : null,
    maxScrolls: options.maxScrolls && options.maxScrolls > 0 ? options.maxScrolls : 8,
    headless: options.headless !== false,
  };

  onProgress(`🚀 Launching browser (headless: ${opts.headless})`, null);
  const browser = await chromium.launch({ headless: opts.headless });

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
    onProgress(`🍪 Loaded ${normalized.length} cookies into the browser session`, null);

    for (let i = 0; i < usernames.length; i++) {
      const username = usernames[i];
      if (!username || !username.trim()) continue;

      const cleanUser = username.trim().replace(/^@/, '');
      onProgress(`(${i + 1}/${usernames.length}) Scraping @${cleanUser}…`, null);
      
      const result = await scrapeOneProfile(context, username, opts, onProgress);

      if (result.status === 'ok') {
        const withCaptions = result.reels_with_captions?.filter(r => r.caption) || [];
        const captionCount = withCaptions.filter(r => r.caption && r.caption.trim().length > 0).length;
        onProgress(`✅ @${result.username}: ${result.reels.length} reels, ${captionCount} with captions`, result);
      } else if (result.status === 'login_wall') {
        onProgress(`⚠️ @${result.username}: hit a login wall — cookies may be expired or invalid`, result);
      } else if (result.status === 'private') {
        onProgress(`🔒 @${result.username}: account is private`, result);
      } else if (result.status === 'not_found') {
        onProgress(`❌ @${result.username}: profile not found`, result);
      } else if (result.status === 'no_reels_found') {
        onProgress(`📭 @${result.username}: no reels found`, result);
      } else {
        onProgress(`❌ @${result.username}: error — ${result.error || 'unknown error'}`, result);
      }

      if (i < usernames.length - 1) {
        await randomDelay(2500, 5500);
      }
    }

    onProgress('✅ Done scraping all profiles!', null);
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeProfiles, normalizeCookies };
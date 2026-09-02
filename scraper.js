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

      // Playwright rejects sameSite=None cookies that aren't marked secure.
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

/**
 * Scroll the reels grid, collecting /reel/ links as they load.
 */
async function collectReelUrls(page, { maxReels, maxScrolls }) {
  const seen = new Set();

  const scrapeVisible = async () => {
    const hrefs = await page.$$eval('a[href*="/reel/"]', (as) =>
      as.map((a) => a.getAttribute('href')).filter(Boolean)
    );
    for (const href of hrefs) {
      const full = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
      seen.add(full.split('?')[0]);
    }
  };

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
      if (stableRounds >= 2) break; // grid stopped growing, likely reached the end
    } else {
      stableRounds = 0;
    }
    previousHeight = currentHeight;
  }

  const urls = [...seen];
  return maxReels ? urls.slice(0, maxReels) : urls;
}

async function scrapeOneProfile(context, username, options) {
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

    const reels = await collectReelUrls(page, options);
    return {
      username: cleanUsername,
      status: reels.length ? 'ok' : 'no_reels_found',
      reels,
    };
  } catch (err) {
    return { username: username.trim().replace(/^@/, ''), status: 'error', error: err.message, reels: [] };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Run the full scrape job.
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

  onProgress(`Launching browser (headless: ${opts.headless})`, null);
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
    onProgress(`Loaded ${normalized.length} cookies into the browser session`, null);

    for (let i = 0; i < usernames.length; i++) {
      const username = usernames[i];
      if (!username || !username.trim()) continue;

      onProgress(`(${i + 1}/${usernames.length}) Scraping @${username.trim().replace(/^@/, '')}…`, null);
      const result = await scrapeOneProfile(context, username, opts);

      if (result.status === 'ok') {
        onProgress(`Found ${result.reels.length} reel URL(s) for @${result.username}`, result);
      } else if (result.status === 'login_wall') {
        onProgress(`@${result.username}: hit a login wall — cookies may be expired or invalid`, result);
      } else if (result.status === 'private') {
        onProgress(`@${result.username}: account is private and not accessible with this session`, result);
      } else if (result.status === 'not_found') {
        onProgress(`@${result.username}: profile not found`, result);
      } else if (result.status === 'no_reels_found') {
        onProgress(`@${result.username}: no reels found on the profile`, result);
      } else {
        onProgress(`@${result.username}: error — ${result.error || 'unknown error'}`, result);
      }

      if (i < usernames.length - 1) {
        await randomDelay(2500, 5500); // be gentle between profiles
      }
    }

    onProgress('Done.', null);
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeProfiles, normalizeCookies };

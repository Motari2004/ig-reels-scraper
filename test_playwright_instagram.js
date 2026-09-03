/**
 * Test Instagram with Playwright using existing browsers
 * Usage: node test_playwright_instagram.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 🔥 Use your existing Chromium installation
const CHROME_PATHS = [
  'C:\\Users\\PC\\AppData\\Local\\ms-playwright\\chromium-1200\\chrome-win64\\chrome.exe',
  'C:\\Users\\PC\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe',
];

function findExistingChromium() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) {
      console.log(`✅ Found browser at: ${p}`);
      return p;
    }
  }
  return null;
}

async function testWithCookies() {
  console.log('='.repeat(60));
  console.log('🔍 TESTING WITH COOKIES');
  console.log('='.repeat(60));
  
  // Load cookies
  const cookiePath = path.join(process.cwd(), 'cookies.json');
  if (!fs.existsSync(cookiePath)) {
    console.log('❌ cookies.json not found in current directory');
    console.log('\n💡 How to get cookies:');
    console.log('  1. Install Cookie-Editor extension in your browser');
    console.log('  2. Log into Instagram');
    console.log('  3. Export cookies as JSON');
    console.log('  4. Save as cookies.json in this folder');
    return;
  }
  
  let cookies;
  try {
    const data = fs.readFileSync(cookiePath, 'utf8');
    cookies = JSON.parse(data);
    console.log(`✅ Loaded ${cookies.length} cookies from cookies.json`);
  } catch (error) {
    console.error(`❌ Error loading cookies: ${error.message}`);
    return;
  }

  // Find existing browser
  const browserPath = findExistingChromium();
  if (!browserPath) {
    console.log('❌ No browser found. Please install Playwright browsers:');
    console.log('   npx playwright install chromium');
    return;
  }

  console.log('\n🚀 Launching browser...');
  
  // 🔥 Use existing browser
  const browser = await chromium.launch({ 
    headless: false,
    executablePath: browserPath,
    slowMo: 300
  });
  
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });
    
    // Add cookies
    const normalized = cookies.map(c => ({
      name: c.name,
      value: String(c.value),
      domain: c.domain || '.instagram.com',
      path: c.path || '/',
      secure: c.secure !== undefined ? Boolean(c.secure) : true,
      httpOnly: Boolean(c.httpOnly),
    }));
    
    await context.addCookies(normalized);
    console.log(`🍪 Added ${normalized.length} cookies to browser`);
    
    const page = await context.newPage();
    
    console.log('\n🌐 Navigating to Instagram...');
    console.log('📍 https://www.instagram.com/nasa/reels/');
    await page.goto('https://www.instagram.com/nasa/reels/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    console.log('✅ Page loaded!');
    
    // Wait for content
    console.log('⏳ Waiting for content to render...');
    await page.waitForTimeout(5000);
    
    // Check page content
    const pageInfo = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      return {
        title: document.title,
        url: window.location.href,
        hasReels: document.querySelectorAll('a[href*="/reel/"]').length,
        hasLogin: bodyText.includes('Log in') || bodyText.includes('Login'),
        hasProfile: bodyText.includes('followers') || bodyText.includes('posts'),
        bodyLength: bodyText.length,
        bodySample: bodyText.substring(0, 300)
      };
    });
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 PAGE INFORMATION');
    console.log('='.repeat(60));
    console.log(`  Title: ${pageInfo.title}`);
    console.log(`  URL: ${pageInfo.url}`);
    console.log(`  Has Login Wall: ${pageInfo.hasLogin}`);
    console.log(`  Has Profile Info: ${pageInfo.hasProfile}`);
    console.log(`  Reel Links Found: ${pageInfo.hasReels}`);
    
    if (pageInfo.hasLogin) {
      console.log('\n❌ Still on login page! Cookies may be expired.');
      console.log('   Please export fresh cookies from your browser.');
    } else if (pageInfo.hasProfile) {
      console.log('\n✅ Logged in successfully!');
      
      if (pageInfo.hasReels > 0) {
        console.log(`\n📹 Found ${pageInfo.hasReels} reel links!`);
        
        // Get reel URLs
        const reelUrls = await page.$$eval('a[href*="/reel/"]', (links) => {
          return links.map(a => a.getAttribute('href'));
        });
        
        console.log('\n📹 First 5 reels:');
        reelUrls.slice(0, 5).forEach((url, i) => {
          const full = url.startsWith('http') ? url : `https://www.instagram.com${url}`;
          console.log(`  ${i+1}. ${full}`);
        });
        
        // 🔥 Try to get captions
        console.log('\n📝 Attempting to extract captions...');
        
        const reelData = await page.$$eval('a[href*="/reel/"]', (links) => {
          return links.map((link) => {
            const href = link.getAttribute('href');
            let caption = '';
            
            // Find the container
            let container = link.closest('article');
            if (!container) container = link.closest('div[role="article"]');
            if (!container) container = link.closest('div[class*="x1yztbdb"]');
            
            if (container) {
              // Try multiple methods to find caption
              const captionSelectors = [
                'div.xyamay9.x1l90r2v > div.x78zum5.xedcshv > div.x78zum5.xedcshv:nth-of-type(1) > div.x1ey2m1c.x78zum5:nth-of-type(1) > div.x78zum5.xdt5ytf:nth-of-type(2)',
                'h1',
                'h1 span',
                'div[class*="x1n2onr6"]',
                'div[class*="x1lliihq"]',
                'span[class*="x1lliihq"]'
              ];
              
              for (const selector of captionSelectors) {
                try {
                  const el = container.querySelector(selector);
                  if (el && el.textContent) {
                    const text = el.textContent.trim();
                    if (text && text.length > 5 && !/^[0-9,]+$/.test(text)) {
                      caption = text;
                      break;
                    }
                  }
                } catch (e) {}
              }
            }
            
            const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
            return { url: fullUrl.split('?')[0], caption };
          });
        });
        
        const withCaptions = reelData.filter(r => r.caption && r.caption.length > 5);
        console.log(`\n📊 Caption Summary:`);
        console.log(`  Total reels: ${reelData.length}`);
        console.log(`  With captions: ${withCaptions.length}`);
        console.log(`  Without captions: ${reelData.length - withCaptions.length}`);
        
        if (withCaptions.length > 0) {
          console.log('\n📝 Sample captions:');
          withCaptions.slice(0, 3).forEach((item, i) => {
            console.log(`  ${i+1}. ${item.caption.substring(0, 80)}...`);
          });
        } else {
          console.log('\n⚠️ No captions found. The caption selector might need updating.');
          console.log('   Look at the browser window to see what the page looks like.');
        }
      } else {
        console.log('\n⚠️ No reel links found on the page');
        console.log('   Possible reasons:');
        console.log('   1. The reels grid needs to be scrolled');
        console.log('   2. The account has no reels');
        console.log('   3. The page structure has changed');
        console.log('\n   Look at the browser window to see what\'s happening.');
      }
    } else {
      console.log('\n⚠️ Unexpected page state');
      console.log(`   Body sample: ${pageInfo.bodySample}`);
    }
    
    console.log('\n⏳ Browser will stay open for 30 seconds...');
    console.log('   Look at the browser window to see what\'s happening');
    await page.waitForTimeout(30000);
    
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    console.error(error.stack);
  } finally {
    await browser.close();
    console.log('\n✅ Test complete!');
  }
}

// Run the test
testWithCookies().catch(console.error);
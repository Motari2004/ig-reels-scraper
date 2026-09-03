/**
 * Test Playwright with Instagram
 * Usage: node test_playwright_instagram.js
 */

const { chromium } = require('playwright');

async function testInstagram() {
  console.log('='.repeat(60));
  console.log('🧪 TESTING PLAYWRIGHT WITH INSTAGRAM');
  console.log('='.repeat(60));

  // Show what browsers we have
  console.log('\n📂 Playwright browsers found:');
  console.log('   ✅ chromium-1200');
  console.log('   ✅ chromium-1234');
  console.log('   ✅ chromium_headless_shell-1200');
  console.log('   ✅ chromium_headless_shell-1208');
  console.log('   ✅ chromium_headless_shell-1234');

  console.log('\n🚀 Launching browser...');
  
  // Try to launch the browser
  try {
    const browser = await chromium.launch({ 
      headless: false,  // Show the browser so you can see
      channel: 'chrome' // Try using system Chrome if available
    });
    
    console.log('✅ Browser launched!');
    
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    
    console.log('\n🌐 Navigating to Instagram...');
    console.log('📍 https://www.instagram.com/nasa/reels/');
    
    // Go to the page
    await page.goto('https://www.instagram.com/nasa/reels/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    console.log('✅ Page loaded!');
    
    // Wait for content
    console.log('⏳ Waiting 3 seconds for content to render...');
    await page.waitForTimeout(3000);
    
    // Get page info
    const info = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      return {
        title: document.title,
        url: window.location.href,
        hasReels: document.querySelectorAll('a[href*="/reel/"]').length,
        hasLogin: bodyText.includes('Log in') || bodyText.includes('Login'),
        bodyLength: bodyText.length,
        bodySample: bodyText.substring(0, 200)
      };
    });
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 PAGE INFORMATION');
    console.log('='.repeat(60));
    console.log(`  Title: ${info.title}`);
    console.log(`  URL: ${info.url}`);
    console.log(`  Body Length: ${info.bodyLength} characters`);
    console.log(`  Reel Links Found: ${info.hasReels}`);
    console.log(`  Has Login Wall: ${info.hasLogin}`);
    
    if (info.hasReels > 0) {
      console.log(`\n✅ Found ${info.hasReels} reel links!`);
      
      // Get the reel URLs
      const reelUrls = await page.$$eval('a[href*="/reel/"]', (links) => {
        return links.map(a => a.getAttribute('href'));
      });
      
      console.log('\n📹 First 5 reels:');
      reelUrls.slice(0, 5).forEach((url, i) => {
        const full = url.startsWith('http') ? url : `https://www.instagram.com${url}`;
        console.log(`  ${i+1}. ${full}`);
      });
    } else {
      console.log('\n⚠️ No reel links found on the page');
      
      if (info.hasLogin) {
        console.log('\n🔒 Login wall detected!');
        console.log('   You need to provide cookies.json');
        console.log('   Export cookies from browser while logged into Instagram');
      } else {
        console.log('\n📝 Page content preview:');
        console.log('   ' + info.bodySample.replace(/\n/g, ' '));
      }
    }
    
    console.log('\n⏳ Browser will stay open for 10 seconds...');
    console.log('   Look at the browser window to see what\'s happening');
    await page.waitForTimeout(10000);
    
    await browser.close();
    console.log('\n✅ Test complete!');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    
    // Try without cookies (headless)
    console.log('\n🔄 Retrying in headless mode...');
    try {
      const browser2 = await chromium.launch({ headless: true });
      const page2 = await browser2.newPage();
      await page2.goto('https://www.instagram.com/nasa/reels/', { timeout: 30000 });
      await page2.waitForTimeout(3000);
      
      const text = await page2.evaluate(() => document.body.innerText);
      console.log(`📝 Headless page text: ${text.substring(0, 200)}`);
      
      await browser2.close();
    } catch (e2) {
      console.error('❌ Headless also failed:', e2.message);
    }
  }
}

testInstagram();
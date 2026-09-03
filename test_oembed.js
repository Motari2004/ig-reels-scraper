#!/usr/bin/env node
/**
 * Test script for Instagram oEmbed API
 * Usage: node test_oembed.js "https://www.instagram.com/natgeo/reel/DczCUSGlvLp/"
 */

const axios = require('axios');

// Instagram oEmbed endpoint
const OEMBED_URL = 'https://api.instagram.com/oembed';

async function testOEmbed(reelUrl) {
    console.log('='.repeat(60));
    console.log('🔍 TESTING OEMBED API');
    console.log('='.repeat(60));
    console.log(`📹 URL: ${reelUrl}\n`);

    try {
        const response = await axios.get(OEMBED_URL, {
            params: { url: reelUrl },
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (response.status === 200) {
            const data = response.data;
            
            console.log('✅ SUCCESS!');
            console.log('-'.repeat(60));
            console.log(`📝 CAPTION:`);
            console.log(`   ${data.title || 'No caption found'}`);
            console.log(`\n👤 AUTHOR: ${data.author_name || 'Unknown'}`);
            console.log(`🔗 AUTHOR URL: ${data.author_url || 'N/A'}`);
            console.log(`🖼️ THUMBNAIL: ${data.thumbnail_url || 'N/A'}`);
            console.log(`📏 THUMBNAIL SIZE: ${data.thumbnail_width || 'N/A'}x${data.thumbnail_height || 'N/A'}`);
            console.log(`📐 WIDTH: ${data.width || 'N/A'}`);
            console.log(`📐 HEIGHT: ${data.height || 'N/A'}`);
            console.log(`📊 TYPE: ${data.type || 'N/A'}`);
            console.log(`📋 VERSION: ${data.version || 'N/A'}`);
            console.log('-'.repeat(60));
            
            // Show raw data
            console.log('\n📦 RAW RESPONSE:');
            console.log(JSON.stringify(data, null, 2));
            
            return data;
        } else {
            console.log(`❌ FAILED: HTTP ${response.status}`);
            console.log(response.data);
            return null;
        }
    } catch (error) {
        console.log('❌ ERROR:');
        if (error.response) {
            console.log(`   Status: ${error.response.status}`);
            console.log(`   Data: ${JSON.stringify(error.response.data, null, 2)}`);
        } else if (error.request) {
            console.log('   No response received from server');
        } else {
            console.log(`   ${error.message}`);
        }
        return null;
    }
}

// ============== TEST MULTIPLE URLS ==============

async function testMultipleUrls(urls) {
    console.log('='.repeat(60));
    console.log(`🔍 TESTING ${urls.length} URLs`);
    console.log('='.repeat(60));
    
    const results = [];
    let successCount = 0;
    
    for (let i = 0; i < urls.length; i++) {
        console.log(`\n📹 [${i + 1}/${urls.length}] Testing...`);
        const result = await testOEmbed(urls[i]);
        results.push(result);
        if (result) successCount++;
        
        // Delay between requests to be gentle
        if (i < urls.length - 1) {
            console.log('⏳ Waiting 1 second...');
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`  ✅ Success: ${successCount}/${urls.length}`);
    console.log(`  ❌ Failed: ${urls.length - successCount}/${urls.length}`);
    console.log('='.repeat(60));
}

// ============== COMMAND LINE ==============

const args = process.argv.slice(2);

if (args.length === 0) {
    // Interactive mode
    console.log('='.repeat(60));
    console.log('🔍 INSTAGRAM OEMBED TESTER');
    console.log('='.repeat(60));
    console.log('\nOptions:');
    console.log('  1. Test a single URL');
    console.log('  2. Test multiple URLs');
    console.log('  3. Test with sample URLs');
    
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    rl.question('\nEnter choice (1-3): ', async (choice) => {
        if (choice === '1') {
            rl.question('Enter Instagram URL: ', async (url) => {
                await testOEmbed(url);
                rl.close();
            });
        } else if (choice === '2') {
            rl.question('Enter URLs (comma separated): ', async (input) => {
                const urls = input.split(',').map(u => u.trim());
                await testMultipleUrls(urls);
                rl.close();
            });
        } else if (choice === '3') {
            const sampleUrls = [
                'https://www.instagram.com/natgeo/reel/DczCUSGlvLp/',
                'https://www.instagram.com/nasa/reel/Dcwk7e1yHaY/',
                'https://www.instagram.com/shaazjung/reel/DcyjXvqhD32/'
            ];
            await testMultipleUrls(sampleUrls);
            rl.close();
        } else {
            console.log('Invalid choice');
            rl.close();
        }
    });
} else {
    // Command line mode
    const firstArg = args[0];
    
    if (firstArg === '--file' || firstArg === '-f') {
        // Read URLs from file
        const fs = require('fs');
        const filePath = args[1];
        if (!filePath) {
            console.log('❌ Please provide a file path');
            process.exit(1);
        }
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const urls = content.split('\n').filter(u => u.trim());
            await testMultipleUrls(urls);
        } catch (error) {
            console.log(`❌ Error reading file: ${error.message}`);
        }
    } else if (firstArg === '--help' || firstArg === '-h') {
        console.log(`
Usage:
  node test_oembed.js "URL"
  node test_oembed.js --file urls.txt
  node test_oembed.js --help

Examples:
  node test_oembed.js "https://www.instagram.com/natgeo/reel/DczCUSGlvLp/"
  node test_oembed.js --file urls.txt
        `);
    } else {
        // Single URL
        await testOEmbed(firstArg);
    }
}
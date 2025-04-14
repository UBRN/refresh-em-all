const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const extensionPath = path.join(__dirname, '../..');
const logFile = path.join(__dirname, 'stress-test-results.json');

// Configuration for stress test
const CONFIG = {
  // Maximum number of iterations to run
  maxIterations: 1000,
  
  // Maximum number of tabs to create
  maxTabs: 100,
  
  // Increase by this many tabs each iteration
  tabIncrement: 5,
  
  // Wait between refreshes (ms)
  waitBetweenRefreshes: 2000,
  
  // Stop test if memory usage exceeds this limit (bytes)
  memoryLimit: 2 * 1024 * 1024 * 1024, // 2GB
  
  // Stop test if an operation takes longer than this (ms)
  operationTimeout: 120000, // 2 minutes
  
  // Stop test if a specific error is encountered multiple times
  maxSameErrorCount: 3
};

// Global tracking objects
const results = {
  startTime: new Date().toISOString(),
  endTime: null,
  iterations: 0,
  maxTabsReached: 0,
  errors: [],
  memoryUsage: [],
  operationTimings: [],
  lastError: null,
  success: false,
  crashPoint: null
};

// Helper to measure memory usage
function getMemoryUsage() {
  const memoryUsage = process.memoryUsage();
  return {
    timestamp: new Date().toISOString(),
    rss: memoryUsage.rss,
    heapTotal: memoryUsage.heapTotal,
    heapUsed: memoryUsage.heapUsed,
    external: memoryUsage.external,
    arrayBuffers: memoryUsage.arrayBuffers,
    systemFree: os.freemem(),
    systemTotal: os.totalmem()
  };
}

// Helper to log results
function logResults() {
  results.endTime = new Date().toISOString();
  
  // Write results to file
  fs.writeFileSync(logFile, JSON.stringify(results, null, 2));
  
  // Print summary
  console.log('\n==== STRESS TEST RESULTS ====');
  console.log(`Iterations completed: ${results.iterations}`);
  console.log(`Maximum tabs refreshed: ${results.maxTabsReached}`);
  console.log(`Test result: ${results.success ? 'PASSED' : 'FAILED'}`);
  if (results.crashPoint) {
    console.log(`Crash point: ${results.crashPoint}`);
  }
  console.log(`Total errors: ${results.errors.length}`);
  if (results.lastError) {
    console.log(`Last error: ${results.lastError.message}`);
    console.log(results.lastError.stack);
  }
  console.log('============================');
  console.log(`Detailed results written to: ${logFile}`);
}

// Function to find extension ID
async function findExtensionId(browser) {
  // Allow a moment for extension to initialize
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const targets = await browser.targets();
  
  // Try to find service worker first (Manifest V3)
  const serviceWorkerTarget = targets.find(target => 
    target.type() === 'service_worker' && 
    target.url().includes('chrome-extension://')
  );
  
  if (serviceWorkerTarget) {
    const extensionId = serviceWorkerTarget.url().split('/')[2];
    console.log(`Found extension via service worker: ${extensionId}`);
    return extensionId;
  }
  
  // Fall back to background page (Manifest V2)
  const backgroundTarget = targets.find(target => 
    target.type() === 'background_page' && 
    target.url().includes('chrome-extension://')
  );
  
  if (backgroundTarget) {
    const extensionId = backgroundTarget.url().split('/')[2];
    console.log(`Found extension via background page: ${extensionId}`);
    return extensionId;
  }
  
  // As a last resort, try to find any extension-related target
  const extensionTarget = targets.find(target => 
    target.url().includes('chrome-extension://')
  );
  
  if (extensionTarget) {
    const extensionId = extensionTarget.url().split('/')[2];
    console.log(`Found extension via other target: ${extensionId}`);
    return extensionId;
  }
  
  throw new Error('Extension not found. Make sure it loaded correctly.');
}

// Main stress test function
async function runStressTest() {
  console.log('Starting stress test...');
  console.log(`Maximum iterations: ${CONFIG.maxIterations}`);
  console.log(`Maximum tabs: ${CONFIG.maxTabs}`);
  
  let browser;
  try {
    // Launch browser with extension
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--start-maximized',
        // Disable CORS to allow cross-origin requests
        '--disable-web-security',
        // Needed for Manifest V3 extensions
        '--disable-features=ExtensionsToolbarMenu',
        // Disable sandboxing for more compatibility
        '--no-sandbox',
        // Avoids GPU-related issues
        '--disable-gpu'
      ]
    });
    
    // Get extension ID using the improved method
    const extensionId = await findExtensionId(browser);
    console.log(`Extension ID: ${extensionId}`);

    // Begin test iterations
    let currentTabCount = 5; // Start with 5 tabs
    let sameErrorCount = 0;
    let prevError = null;
    
    for (let iter = 1; iter <= CONFIG.maxIterations; iter++) {
      results.iterations = iter;
      
      console.log(`\nIteration ${iter}: Testing with ${currentTabCount} tabs`);
      results.maxTabsReached = Math.max(results.maxTabsReached, currentTabCount);
      
      // Record memory usage before operation
      const memBefore = getMemoryUsage();
      results.memoryUsage.push(memBefore);
      
      if (memBefore.rss > CONFIG.memoryLimit) {
        console.log('Memory limit exceeded, stopping test');
        results.crashPoint = 'Memory limit exceeded';
        break;
      }
      
      // Start timing the operation
      const operationStartTime = Date.now();
      
      try {
        // Create the required number of tabs
        const tabs = await createTabs(browser, currentTabCount);
        
        // Open extension popup in a new tab
        const popupPage = await browser.newPage();
        await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
        
        // Click the refresh button
        console.log('Clicking refresh button...');
        await popupPage.click('#refreshAll');
        
        // Wait for loading animation
        console.log('Waiting for refresh to complete...');
        await popupPage.waitForSelector('#loadingContainer[style*="display: block"]', { 
          timeout: CONFIG.operationTimeout 
        });
        
        // Wait for completion
        await popupPage.waitForFunction(() => {
          const statusText = document.querySelector('#statusText');
          return statusText && (
            statusText.textContent.includes('refreshed successfully') ||
            statusText.textContent.includes('with') // "with X errors"
          );
        }, { timeout: CONFIG.operationTimeout });
        
        // Check for errors
        const errorText = await popupPage.evaluate(() => {
          const errorContainer = document.querySelector('#errorContainer');
          if (errorContainer && errorContainer.style.display !== 'none') {
            const errorSummary = document.querySelector('#errorSummary');
            const errorDetails = document.querySelector('#errorDetails');
            return {
              summary: errorSummary ? errorSummary.textContent : '',
              details: errorDetails ? errorDetails.textContent : ''
            };
          }
          return null;
        });
        
        if (errorText) {
          const error = new Error(`Refresh errors detected: ${errorText.summary}`);
          error.details = errorText.details;
          throw error;
        }
        
        // Record operation timing
        const operationDuration = Date.now() - operationStartTime;
        results.operationTimings.push({
          iteration: iter,
          tabCount: currentTabCount,
          duration: operationDuration
        });
        
        console.log(`Operation completed in ${operationDuration}ms`);
        
        // Reset error counter after successful iteration
        sameErrorCount = 0;
        prevError = null;
        
        // Close popup page
        await popupPage.close();
        
        // Close all tabs except the first one
        for (let i = 1; i < tabs.length; i++) {
          await tabs[i].close();
        }
        
        // Increase tab count for next iteration
        currentTabCount = Math.min(currentTabCount + CONFIG.tabIncrement, CONFIG.maxTabs);
        
        // Wait before next iteration
        await new Promise(resolve => setTimeout(resolve, CONFIG.waitBetweenRefreshes));
        
      } catch (error) {
        // Record error and timing
        const operationDuration = Date.now() - operationStartTime;
        
        results.errors.push({
          iteration: iter,
          tabCount: currentTabCount,
          message: error.message,
          details: error.details || null,
          stack: error.stack,
          timestamp: new Date().toISOString()
        });
        
        results.lastError = error;
        
        console.error(`Error during iteration ${iter}:`, error.message);
        
        // Check if it's the same error as before
        if (prevError && prevError.message === error.message) {
          sameErrorCount++;
          
          if (sameErrorCount >= CONFIG.maxSameErrorCount) {
            console.log(`Same error occurred ${sameErrorCount} times, stopping test`);
            results.crashPoint = `Repeated error: ${error.message}`;
            break;
          }
        } else {
          sameErrorCount = 1;
          prevError = error;
        }
        
        // Try to recover by closing all pages
        const pages = await browser.pages();
        for (const page of pages.slice(1)) {
          try {
            await page.close();
          } catch (e) {
            // Ignore errors when closing pages
          }
        }
      }
      
      // Perform garbage collection if available
      if (global.gc) {
        global.gc();
      }
    }
    
    // Test completed successfully
    results.success = true;
    
  } catch (error) {
    // Catastrophic error
    console.error('Stress test failed with error:', error);
    results.lastError = error;
    results.crashPoint = 'Catastrophic error';
    results.errors.push({
      iteration: results.iterations,
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
  } finally {
    // Log final results
    logResults();
    
    // Close browser
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Error closing browser:', e.message);
      }
    }
  }
}

// Helper to create multiple tabs
async function createTabs(browser, count) {
  const tabs = [];
  
  // Test URLs - mixture of different content types
  const testUrls = [
    'https://example.com',
    'https://google.com',
    'https://github.com',
    'https://youtube.com',
    'https://netflix.com',
    'https://wikipedia.org',
    'https://twitter.com',
    'https://reddit.com',
    'https://stackoverflow.com',
    'https://nytimes.com'
  ];
  
  // Create tabs
  for (let i = 0; i < count; i++) {
    const url = testUrls[i % testUrls.length];
    try {
      const page = await browser.newPage();
      
      // Set viewport to ensure consistent testing
      await page.setViewport({
        width: 1280,
        height: 800
      });
      
      // Navigate to URL
      await page.goto(url, {
        waitUntil: 'load',
        timeout: 30000
      });
      
      tabs.push(page);
      
      // Add a small delay between opening tabs to reduce strain
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`Error creating tab ${i+1}:`, error.message);
      // Continue with other tabs
    }
  }
  
  return tabs;
}

// Run the stress test
runStressTest().catch(error => {
  console.error('Fatal error in stress test:', error);
  logResults();
  process.exit(1);
}); 
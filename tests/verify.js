/**
 * Verification Script for Refresh-Em-All Extension
 * 
 * This script helps verify if the extension is working correctly after code changes,
 * particularly with the improvements addressing the fbf7234f-c82b-4801-9981-5c5695a5633c issue.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const extensionPath = path.join(__dirname, '..');
const resultsPath = path.join(__dirname, 'verification-results.json');

// Verification parameters
const VERIFICATION_CONFIG = {
  // Number of tabs to open for verification
  tabCount: 10,
  
  // URLs to open in tabs
  tabUrls: [
    'https://example.com',
    'https://google.com',
    'https://github.com',
    'https://wikipedia.org',
    'https://youtube.com'
  ]
};

// Results object
const results = {
  startTime: new Date().toISOString(),
  endTime: null,
  systemInfo: {
    platform: os.platform(),
    version: os.version(),
    arch: os.arch(),
    totalMemory: os.totalmem(),
    freeMemory: os.freemem()
  },
  extensionInfo: {
    id: null,
    version: null
  },
  refreshOperation: {
    success: false,
    tabsRefreshed: 0,
    errorCount: 0,
    operationDuration: 0
  },
  memoryUsage: [],
  errors: []
};

// Function to measure memory usage
function getMemoryUsage() {
  const memoryUsage = process.memoryUsage();
  return {
    timestamp: new Date().toISOString(),
    rss: memoryUsage.rss,
    heapTotal: memoryUsage.heapTotal,
    heapUsed: memoryUsage.heapUsed,
    external: memoryUsage.external,
    arrayBuffers: memoryUsage.arrayBuffers,
    systemFree: os.freemem()
  };
}

// Function to save verification results
function saveResults() {
  results.endTime = new Date().toISOString();
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  
  console.log('\n==== VERIFICATION RESULTS ====');
  console.log(`Extension ID: ${results.extensionInfo.id || 'Unknown'}`);
  console.log(`Operation Success: ${results.refreshOperation.success ? 'Yes' : 'No'}`);
  console.log(`Tabs Refreshed: ${results.refreshOperation.tabsRefreshed}/${VERIFICATION_CONFIG.tabCount}`);
  console.log(`Error Count: ${results.refreshOperation.errorCount}`);
  console.log(`Operation Duration: ${results.refreshOperation.operationDuration}ms`);
  
  if (results.errors.length > 0) {
    console.log('\nErrors encountered:');
    results.errors.forEach((error, index) => {
      console.log(`\n#${index + 1}: ${error.message}`);
      if (error.details) {
        console.log(`  Details: ${error.details}`);
      }
    });
  }
  
  console.log(`\nFull results saved to: ${resultsPath}`);
  console.log('==============================');
}

// Function to find the extension ID
async function findExtensionId(browser) {
  // Allow some time for the extension to initialize
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Attempt to find the extension using multiple approaches
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
  
  // As a last resort, check for any extension-related targets
  const extensionTarget = targets.find(target => 
    target.url().includes('chrome-extension://')
  );
  
  if (extensionTarget) {
    const extensionId = extensionTarget.url().split('/')[2];
    console.log(`Found extension via other target: ${extensionId}`);
    return extensionId;
  }
  
  // Method 2: List all extensions via chrome://extensions page
  try {
    const extensionsPage = await browser.newPage();
    await extensionsPage.goto('chrome://extensions');
    
    // Execute script to get all extension IDs
    const extensionIds = await extensionsPage.evaluate(() => {
      const extensions = document.querySelectorAll('extensions-item');
      return Array.from(extensions).map(ext => {
        return ext.getAttribute('id');
      });
    });
    
    await extensionsPage.close();
    
    if (extensionIds.length > 0) {
      const extensionId = extensionIds[0]; // Just take the first one if multiple
      console.log(`Found extension via chrome://extensions: ${extensionId}`);
      return extensionId;
    }
  } catch (error) {
    console.error('Error accessing extensions page:', error);
  }
  
  throw new Error('Extension not found. Make sure the extension is loaded correctly.');
}

// Main verification function
async function verifyExtension() {
  console.log('Starting extension verification...');
  console.log(`Tabs to open: ${VERIFICATION_CONFIG.tabCount}`);
  
  results.memoryUsage.push(getMemoryUsage());
  
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
    results.extensionInfo.id = extensionId;
    
    console.log(`Extension ID: ${extensionId}`);
    
    // Open tabs
    const tabs = [];
    for (let i = 0; i < VERIFICATION_CONFIG.tabCount; i++) {
      const url = VERIFICATION_CONFIG.tabUrls[i % VERIFICATION_CONFIG.tabUrls.length];
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      tabs.push(page);
      
      // Add a small delay between opening tabs
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`Opened ${tabs.length} tabs for testing`);
    results.memoryUsage.push(getMemoryUsage());
    
    // Open extension popup
    const popupPage = await browser.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    
    // Enable console logging from the popup
    popupPage.on('console', msg => console.log(`POPUP CONSOLE: ${msg.text()}`));
    
    // Start operation timing
    const operationStartTime = Date.now();
    
    // Capture the state of the UI before clicking
    await popupPage.screenshot({ path: path.join(__dirname, 'before-click.png') });
    console.log('Before-click screenshot saved');
    
    // Ensure button is visible and clickable
    await popupPage.waitForSelector('#refreshAll', { visible: true, timeout: 5000 });
    console.log('Refresh button is visible');
    
    // Click the refresh button
    console.log('Clicking refresh button...');
    await popupPage.click('#refreshAll');
    
    // Take screenshot right after clicking
    await popupPage.screenshot({ path: path.join(__dirname, 'after-click.png') });
    console.log('After-click screenshot saved');
    
    // Wait for refresh operation to complete
    console.log('Waiting for refresh operation to complete...');
    
    try {
      // First, verify the loading container becomes visible
      const loadingDisplayed = await popupPage.waitForSelector('#loadingContainer[style*="display: block"]', { 
        timeout: 5000,
        visible: true
      }).then(() => true).catch(() => false);
      
      if (!loadingDisplayed) {
        console.log('WARNING: Loading container not displayed, operation may not have started');
        // Take screenshot to debug
        await popupPage.screenshot({ path: path.join(__dirname, 'loading-not-displayed.png') });
        
        // Check if the button is still clickable
        const buttonClickable = await popupPage.evaluate(() => {
          const button = document.getElementById('refreshAll');
          return button && !button.disabled;
        });
        
        if (buttonClickable) {
          console.log('Trying to click the button again...');
          await popupPage.click('#refreshAll');
          // Wait again for loading container
          await popupPage.waitForSelector('#loadingContainer[style*="display: block"]', { 
            timeout: 5000,
            visible: true 
          }).catch(() => {
            console.log('Loading container still not visible after second click');
          });
        }
      }
      
      // Take screenshot of loading state
      await popupPage.screenshot({ path: path.join(__dirname, 'loading-state.png') });
      console.log('Loading state screenshot saved');
      
      // Get the tab count from the tab container
      const tabCount = await popupPage.evaluate(() => {
        const tabsContainer = document.getElementById('tabsContainer');
        return tabsContainer ? tabsContainer.childElementCount : 0;
      });
      
      console.log(`Found ${tabCount} tabs to refresh`);
      
      // Monitor the progress by polling the status text periodically
      let lastStatus = '';
      let stabilityCounter = 0;
      const maxStabilityChecks = 10;
      const pollInterval = 1000; // 1 second
      const maxPolls = 60; // 60 seconds timeout
      
      for (let i = 0; i < maxPolls; i++) {
        // Wait a moment
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        
        // Take periodic screenshots during operation
        if (i % 5 === 0) {
          await popupPage.screenshot({ path: path.join(__dirname, `progress-${i}.png`) });
        }
        
        // Check current status
        const currentStatus = await popupPage.evaluate(() => {
          const statusElement = document.getElementById('statusText');
          const loadingContainer = document.getElementById('loadingContainer');
          const errorContainer = document.getElementById('errorContainer');
          const confetti = document.getElementById('confetti');
          
          return {
            statusText: statusElement ? statusElement.textContent : '',
            loadingVisible: loadingContainer ? loadingContainer.style.display !== 'none' : false,
            errorVisible: errorContainer ? errorContainer.style.display !== 'none' : false,
            confettiVisible: confetti ? confetti.style.display !== 'none' : false
          };
        });
        
        console.log(`Poll ${i+1}/${maxPolls}: ${currentStatus.statusText} (loading: ${currentStatus.loadingVisible}, error: ${currentStatus.errorVisible}, confetti: ${currentStatus.confettiVisible})`);
        
        // Check if operation is complete
        const isComplete = !currentStatus.loadingVisible &&
                          (currentStatus.statusText.includes('refreshed successfully') || 
                           currentStatus.statusText.includes('with errors') ||
                           currentStatus.confettiVisible);
        
        if (isComplete) {
          console.log('Operation appears to be complete!');
          break;
        }
        
        // Check for stability (i.e., if the status hasn't changed in several checks)
        if (currentStatus.statusText === lastStatus) {
          stabilityCounter++;
          if (stabilityCounter >= maxStabilityChecks && i > 30) {
            console.log('Status has been stable for a while, assuming operation is stalled or complete');
            break;
          }
        } else {
          stabilityCounter = 0;
          lastStatus = currentStatus.statusText;
        }
      }
      
      // Take a final screenshot
      await popupPage.screenshot({ path: path.join(__dirname, 'final-state.png') });
      console.log('Final state screenshot saved');
      
      // Check the final status
      const finalStatus = await popupPage.evaluate(() => {
        const statusElement = document.getElementById('statusText');
        const loadingContainer = document.getElementById('loadingContainer');
        const errorContainer = document.getElementById('errorContainer');
        const errorDetailsElement = document.getElementById('errorDetails');
        const confetti = document.getElementById('confetti');
        
        // Check for success indication in the UI
        const isSuccess = confetti && confetti.style.display !== 'none' || 
                         (statusElement && statusElement.textContent.includes('successfully'));
        
        return {
          statusText: statusElement ? statusElement.textContent : '',
          loadingVisible: loadingContainer ? loadingContainer.style.display !== 'none' : false,
          hasErrors: errorContainer ? errorContainer.style.display !== 'none' : false,
          errorDetails: errorDetailsElement ? errorDetailsElement.textContent : '',
          isSuccess
        };
      });
      
      // Calculate operation duration
      const operationDuration = Date.now() - operationStartTime;
      
      // Update results
      results.refreshOperation.operationDuration = operationDuration;
      results.refreshOperation.success = finalStatus.isSuccess;
      
      // Extract tab numbers from status text using regex
      const statusMatch = finalStatus.statusText.match(/(\d+)\/(\d+)|(\d+)\s+tabs/i);
      if (statusMatch) {
        // Handle different format possibilities in the status text
        if (statusMatch[1] && statusMatch[2]) {
          // Format: "Refreshed X/Y tabs"
          results.refreshOperation.tabsRefreshed = parseInt(statusMatch[1]);
        } else if (statusMatch[3]) {
          // Format: "All X tabs refreshed successfully"
          results.refreshOperation.tabsRefreshed = parseInt(statusMatch[3]);
        }
      }
      
      // Check for errors
      if (finalStatus.hasErrors) {
        const errorMatch = finalStatus.statusText.match(/with\s+(\d+)\s+errors/i);
        if (errorMatch && errorMatch[1]) {
          results.refreshOperation.errorCount = parseInt(errorMatch[1]);
        }
        
        results.errors.push({
          message: 'Refresh operation completed with errors',
          details: finalStatus.errorDetails || 'No detailed error information available'
        });
      }
      
      // Final memory measurement
      results.memoryUsage.push(getMemoryUsage());
      
      console.log(`Operation completed in ${operationDuration}ms`);
      console.log(`Tabs refreshed: ${results.refreshOperation.tabsRefreshed}`);
      console.log(`Errors: ${results.refreshOperation.errorCount}`);
      
    } catch (error) {
      results.errors.push({
        message: 'Error during verification',
        details: error.message
      });
      
      // Take error screenshot for debugging
      try {
        const errorScreenshotPath = path.join(__dirname, 'verification-error-screenshot.png');
        await popupPage.screenshot({ path: errorScreenshotPath });
        console.log(`Error screenshot saved to: ${errorScreenshotPath}`);
      } catch (screenshotError) {
        console.error('Failed to take error screenshot:', screenshotError.message);
      }
      
      console.error('Error during verification:', error);
    }
    
  } catch (error) {
    results.errors.push({
      message: 'Verification failed',
      details: error.message,
      stack: error.stack
    });
    
    console.error('Verification failed:', error);
  } finally {
    // Save results
    saveResults();
    
    // Close browser
    if (browser) {
      await browser.close();
    }
  }
}

// Run verification
verifyExtension().catch(error => {
  results.errors.push({
    message: 'Unhandled error in verification script',
    details: error.message,
    stack: error.stack
  });
  
  saveResults();
  console.error('Unhandled error:', error);
  process.exit(1);
}); 
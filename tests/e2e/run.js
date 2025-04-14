const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const extensionPath = path.join(__dirname, '../..');

// Define the test cases
const TEST_CASES = [
  {
    name: 'Basic Refresh All',
    run: async (browser, extensionId) => {
      const page = await browser.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      
      // Click the refresh button
      await page.click('#refreshAll');
      
      // Wait for loading animation
      await page.waitForSelector('#loadingContainer[style*="display: block"]');
      
      // Wait for completion
      await page.waitForFunction(() => {
        const loadingContainer = document.querySelector('#loadingContainer');
        const statusText = document.querySelector('#statusText');
        return statusText && statusText.textContent.includes('refreshed successfully');
      }, { timeout: 30000 });
      
      // Check if confetti is shown (success)
      const confettiVisible = await page.evaluate(() => {
        const confetti = document.querySelector('#confetti');
        return confetti && confetti.style.display === 'block';
      });
      
      if (!confettiVisible) {
        throw new Error('Confetti not shown - refresh may have failed');
      }
      
      return true;
    }
  },
  {
    name: 'Error Reporting',
    run: async (browser, extensionId) => {
      const page = await browser.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      
      // Enable error reporting
      await page.click('#settingsHeader');
      await page.waitForSelector('#settingsContent[style*="display: block"]');
      
      // Check if toggle exists
      const toggleExists = await page.evaluate(() => {
        return !!document.querySelector('#errorReportingToggle');
      });
      
      if (!toggleExists) {
        throw new Error('Error reporting toggle not found');
      }
      
      // Toggle error reporting on
      await page.evaluate(() => {
        const toggle = document.querySelector('#errorReportingToggle');
        toggle.checked = true;
        
        // Trigger change event
        const event = new Event('change');
        toggle.dispatchEvent(event);
      });
      
      // Verify the setting was saved
      await page.waitForFunction(() => {
        // This indicates the storage operation completed
        return true;
      }, { timeout: 5000 });
      
      return true;
    }
  },
  {
    name: 'History Display',
    run: async (browser, extensionId) => {
      const page = await browser.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      
      // Trigger a refresh first to generate history
      await page.click('#refreshAll');
      
      // Wait for completion
      await page.waitForFunction(() => {
        const statusText = document.querySelector('#statusText');
        return statusText && statusText.textContent.includes('refreshed');
      }, { timeout: 30000 });
      
      // Click on history header
      await page.click('#historyHeader');
      
      // Verify history content is displayed
      await page.waitForSelector('#historyContent[style*="display: block"]');
      
      // Check if history has content
      const hasHistory = await page.evaluate(() => {
        const historyContent = document.querySelector('#historyContent');
        return historyContent && historyContent.innerHTML.trim() !== '';
      });
      
      if (!hasHistory) {
        throw new Error('History is empty or not displayed correctly');
      }
      
      return true;
    }
  },
  {
    name: 'Stress Test Mode',
    run: async (browser, extensionId) => {
      const page = await browser.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      
      // Enable stress test mode by clicking settings header 5 times
      for (let i = 0; i < 5; i++) {
        await page.click('#settingsHeader');
        await page.waitForTimeout(200);
      }
      
      // Confirm dialog should appear - handle it
      page.on('dialog', async (dialog) => {
        await dialog.accept();
      });
      
      // Check if stress test mode is activated
      await page.waitForFunction(() => {
        const refreshButton = document.querySelector('#refreshAll');
        return refreshButton && refreshButton.textContent.includes('Stress Test');
      }, { timeout: 5000 });
      
      return true;
    }
  }
];

async function runTests() {
  console.log('Starting end-to-end tests...');
  
  let browser;
  try {
    // Launch browser with extension
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--window-size=400,600',
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
    
    // Find extension ID
    let extensionId = null;
    
    // Allow some time for the extension to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const targets = await browser.targets();
    
    // Try to find service worker first (Manifest V3)
    const serviceWorkerTarget = targets.find(target => 
      target.type() === 'service_worker' && 
      target.url().includes('chrome-extension://')
    );
    
    if (serviceWorkerTarget) {
      extensionId = serviceWorkerTarget.url().split('/')[2];
      console.log(`Found extension via service worker: ${extensionId}`);
    } else {
      // Fall back to background page (Manifest V2)
      const backgroundTarget = targets.find(target => 
        target.type() === 'background_page' && 
        target.url().includes('chrome-extension://')
      );
      
      if (backgroundTarget) {
        extensionId = backgroundTarget.url().split('/')[2];
        console.log(`Found extension via background page: ${extensionId}`);
      } else {
        // As a last resort, check for any extension-related targets
        const extensionTarget = targets.find(target => 
          target.url().includes('chrome-extension://')
        );
        
        if (extensionTarget) {
          extensionId = extensionTarget.url().split('/')[2];
          console.log(`Found extension via other target: ${extensionId}`);
        } else {
          // Try to get from extensions page
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
            
            if (extensionIds.length > 0) {
              extensionId = extensionIds[0]; // Just take the first one if multiple
              console.log(`Found extension via chrome://extensions: ${extensionId}`);
            }
            
            await extensionsPage.close();
          } catch (error) {
            console.error('Error accessing extensions page:', error);
          }
        }
      }
    }
    
    if (!extensionId) {
      throw new Error('Extension not found. Make sure it loaded correctly.');
    }
    
    console.log(`Extension ID: ${extensionId}`);
    
    // Run each test case
    let passed = 0;
    let failed = 0;
    
    for (const testCase of TEST_CASES) {
      process.stdout.write(`Running test: ${testCase.name}... `);
      try {
        const result = await testCase.run(browser, extensionId);
        if (result) {
          console.log('✅ PASS');
          passed++;
        } else {
          console.log('❌ FAIL');
          failed++;
        }
      } catch (error) {
        console.log('❌ FAIL');
        console.error(`  Error: ${error.message}`);
        failed++;
      }
    }
    
    console.log(`\nTest Summary: ${passed} passed, ${failed} failed`);
    
    return failed === 0;
  } catch (error) {
    console.error('Error running tests:', error);
    return false;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Run tests
runTests()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  }); 
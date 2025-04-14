/**
 * Extension Loading Debugger
 * 
 * This script helps diagnose issues with loading Chrome extensions in Puppeteer.
 * It will attempt to load the extension using the same configuration as the test scripts
 * and provide detailed information about what it finds.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// Extension path - the root directory of the extension
const extensionPath = path.join(__dirname, '..');

async function debugExtensionLoading() {
  console.log('Starting extension loading debug...');
  console.log(`Extension path: ${extensionPath}`);
  
  // Check if manifest.json exists
  const manifestPath = path.join(extensionPath, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    console.log(`Manifest version: ${manifest.manifest_version}`);
    console.log(`Extension name: ${manifest.name}`);
    console.log(`Background implementation: ${manifest.background ? 
      (manifest.background.service_worker ? 'service_worker' : 'background_page') : 'none'}`);
  } else {
    console.error('Manifest file not found!');
    return;
  }
  
  let browser;
  try {
    // Launch browser with extension
    console.log('Launching browser with extension...');
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--start-maximized',
        // Disable CORS
        '--disable-web-security',
        // Needed for Manifest V3 extensions
        '--disable-features=ExtensionsToolbarMenu',
        // Disable sandboxing for more compatibility
        '--no-sandbox',
        // Avoids GPU-related issues
        '--disable-gpu'
      ]
    });
    
    // Allow time for extension to initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get all targets
    const targets = await browser.targets();
    console.log(`\nFound ${targets.length} targets:`);
    
    // Categorize targets
    const serviceWorkers = targets.filter(t => t.type() === 'service_worker');
    const backgroundPages = targets.filter(t => t.type() === 'background_page');
    const extensionTargets = targets.filter(t => t.url().includes('chrome-extension://'));
    
    // Log detailed info about each target
    console.log('\nDETAILED TARGET INFORMATION:');
    targets.forEach((target, i) => {
      console.log(`\nTarget #${i + 1}:`);
      console.log(`  Type: ${target.type()}`);
      console.log(`  URL: ${target.url()}`);
      try {
        const targetInfo = target._targetInfo || {};
        console.log(`  Target Info: ${JSON.stringify(targetInfo, null, 2)}`);
      } catch (e) {
        console.log(`  Target Info: Error getting target info - ${e.message}`);
      }
    });
    
    // Focus on extension targets
    console.log('\nEXTENSION-RELATED TARGETS:');
    if (extensionTargets.length === 0) {
      console.log('No extension-related targets found!');
    } else {
      extensionTargets.forEach((target, i) => {
        console.log(`\nExtension Target #${i + 1}:`);
        console.log(`  Type: ${target.type()}`);
        console.log(`  URL: ${target.url()}`);
        const extensionId = target.url().split('/')[2];
        console.log(`  Extension ID: ${extensionId}`);
      });
    }
    
    // Specifically look for service workers
    console.log('\nSERVICE WORKER TARGETS:');
    if (serviceWorkers.length === 0) {
      console.log('No service worker targets found!');
    } else {
      serviceWorkers.forEach((sw, i) => {
        console.log(`\nService Worker #${i + 1}:`);
        console.log(`  URL: ${sw.url()}`);
        const extensionId = sw.url().includes('chrome-extension://') ? sw.url().split('/')[2] : 'N/A';
        console.log(`  Extension ID: ${extensionId}`);
      });
    }
    
    // Look for background pages (less likely for Manifest V3)
    console.log('\nBACKGROUND PAGE TARGETS:');
    if (backgroundPages.length === 0) {
      console.log('No background page targets found!');
    } else {
      backgroundPages.forEach((bp, i) => {
        console.log(`\nBackground Page #${i + 1}:`);
        console.log(`  URL: ${bp.url()}`);
        const extensionId = bp.url().includes('chrome-extension://') ? bp.url().split('/')[2] : 'N/A';
        console.log(`  Extension ID: ${extensionId}`);
      });
    }
    
    // Open chrome://extensions to check if extension is properly loaded
    console.log('\nCHECKING CHROME EXTENSIONS PAGE:');
    try {
      const extensionsPage = await browser.newPage();
      await extensionsPage.goto('chrome://extensions');
      
      // Take a screenshot for reference
      const screenshotPath = path.join(__dirname, 'extensions-page-screenshot.png');
      await extensionsPage.screenshot({ path: screenshotPath });
      console.log(`Screenshot of extensions page saved to: ${screenshotPath}`);
      
      // Try to extract extension IDs
      const extensionIds = await extensionsPage.evaluate(() => {
        const extensions = document.querySelectorAll('extensions-item');
        return Array.from(extensions).map(ext => {
          return {
            id: ext.getAttribute('id'),
            name: ext.querySelector('.title')?.textContent || 'Unknown',
            enabled: !ext.querySelector('.toggle')?.getAttribute('disabled')
          };
        });
      });
      
      if (extensionIds.length > 0) {
        console.log('\nExtensions found on chrome://extensions page:');
        extensionIds.forEach((ext, i) => {
          console.log(`\nExtension #${i + 1}:`);
          console.log(`  ID: ${ext.id}`);
          console.log(`  Name: ${ext.name}`);
          console.log(`  Enabled: ${ext.enabled ? 'Yes' : 'No'}`);
        });
      } else {
        console.log('No extensions found on chrome://extensions page!');
      }
      
      await extensionsPage.close();
    } catch (error) {
      console.error('Error accessing extensions page:', error);
    }
    
    console.log('\nDEBUG CONCLUSION:');
    if (extensionTargets.length > 0) {
      const extensionId = extensionTargets[0].url().split('/')[2];
      console.log(`✅ Extension appears to be loaded with ID: ${extensionId}`);
      console.log(`To use this ID in tests, update your test scripts to look for:`);
      console.log(`1. Service workers (for Manifest V3) with the URL pattern: chrome-extension://${extensionId}/*`);
      console.log(`2. Or manually set the extension ID in your tests to: ${extensionId}`);
    } else {
      console.log('❌ Extension does not appear to be loaded correctly!');
      console.log('Check the following:');
      console.log('1. Extension path is correct');
      console.log('2. Manifest.json is valid');
      console.log('3. Extension doesn\'t have errors preventing it from loading');
    }
  } catch (error) {
    console.error('Error in debug script:', error);
  } finally {
    // Close browser
    if (browser) {
      console.log('\nClosing browser...');
      await browser.close();
    }
  }
}

// Run the debug function
debugExtensionLoading().catch(console.error); 
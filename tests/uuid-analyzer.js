#!/usr/bin/env node

/**
 * UUID Analyzer for Refresh-Em-All Extension
 * 
 * This tool helps analyze UUIDs found in error messages or logs.
 * It can identify the prefix meaning and provide insights about the UUID.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// UUID validation pattern
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Known UUID prefixes and their meanings
const UUID_PREFIXES = {
  '00000000': 'Initialization UUID (placeholder)',
  '10000000': 'Batch refresh operation',
  '20000000': 'Tab refresh operation',
  '30000000': 'Media state preservation',
  '40000000': 'Error report',
  '50000000': 'User preference operation',
  'a0000000': 'Debug operation',
  'f0000000': 'Stress test operation',
};

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

/**
 * Analyzes a UUID and returns its details
 */
function analyzeUuid(uuid) {
  if (!uuid) {
    return { isValid: false, message: 'No UUID provided' };
  }

  uuid = uuid.toLowerCase();
  
  if (!UUID_PATTERN.test(uuid)) {
    return { isValid: false, message: 'Invalid UUID format' };
  }

  const prefix = uuid.substring(0, 8);
  const meaning = UUID_PREFIXES[prefix] || 'Unknown prefix';
  const timestampHex = uuid.substring(9, 13);
  const timestampDec = parseInt(timestampHex, 16);
  
  // Assuming the timestamp is a relative time marker in seconds or similar
  const uniqueId = uuid.substring(14).replace(/-/g, '');
  
  return {
    isValid: true,
    uuid,
    prefix,
    meaning,
    timestampHex,
    timestampDec,
    uniqueId,
  };
}

/**
 * Print UUID analysis in a formatted way
 */
function printUuidAnalysis(analysis) {
  if (!analysis.isValid) {
    console.log(`${colors.red}Error: ${analysis.message}${colors.reset}`);
    return;
  }

  console.log(`\n${colors.bright}${colors.cyan}UUID Analysis${colors.reset}`);
  console.log(`${colors.bright}===================${colors.reset}\n`);
  
  console.log(`${colors.bright}UUID:${colors.reset} ${analysis.uuid}`);
  console.log(`${colors.bright}Prefix:${colors.reset} ${analysis.prefix}`);
  console.log(`${colors.bright}Meaning:${colors.reset} ${analysis.meaning}`);
  console.log(`${colors.bright}Timestamp (hex):${colors.reset} ${analysis.timestampHex}`);
  console.log(`${colors.bright}Timestamp (decimal):${colors.reset} ${analysis.timestampDec}`);
  console.log(`${colors.bright}Unique ID:${colors.reset} ${analysis.uniqueId}`);
  
  console.log('\n');
}

/**
 * Load stress test results from file
 */
function loadStressTestResults(filePath) {
  try {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    console.log(`Loading stress test results from: ${resolvedPath}`);
    
    const data = fs.readFileSync(resolvedPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error loading stress test results: ${error.message}`);
    return null;
  }
}

/**
 * Find UUIDs in stress test results
 */
function findUuidsInStressResults(results) {
  if (!results) {
    return [];
  }
  
  const uuids = new Set();
  
  // Function to recursively search for UUID pattern in objects
  function searchForUuids(obj) {
    if (!obj) return;
    
    if (typeof obj === 'string') {
      const matches = obj.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
      if (matches) {
        matches.forEach(match => uuids.add(match.toLowerCase()));
      }
    } else if (typeof obj === 'object') {
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          // Check if the key itself is a UUID
          if (UUID_PATTERN.test(key)) {
            uuids.add(key.toLowerCase());
          }
          // Check values recursively
          searchForUuids(obj[key]);
        }
      }
    }
  }
  
  searchForUuids(results);
  return Array.from(uuids);
}

/**
 * Load extracted UUIDs from file
 */
function loadExtractedUuids(filePath) {
  try {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    console.log(`Loading extracted UUIDs from: ${resolvedPath}`);
    
    const data = fs.readFileSync(resolvedPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error loading extracted UUIDs: ${error.message}`);
    return [];
  }
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log('\nUUID Analyzer for Refresh-Em-All Extension');
    console.log('======================================\n');
    console.log('Usage:');
    console.log('  node uuid-analyzer.js [options] [uuid]');
    console.log('  If no UUID is provided, the tool will enter interactive mode.\n');
    console.log('Options:');
    console.log('  --stress-results <file>  Path to stress test results JSON file');
    console.log('  --extracted <file>       Path to extracted UUIDs JSON file');
    console.log('  --help, -h               Show this help message\n');
    console.log('Examples:');
    console.log('  node uuid-analyzer.js 10000000-abcd-1234-5678-1234567890ab');
    console.log('  node uuid-analyzer.js --stress-results stress-test-results.json');
    console.log('  node uuid-analyzer.js --extracted extracted-uuids.json\n');
    return;
  }
  
  // Check for stress test results option
  const stressResultsIndex = args.indexOf('--stress-results');
  if (stressResultsIndex !== -1 && args.length > stressResultsIndex + 1) {
    const resultsFilePath = args[stressResultsIndex + 1];
    const results = loadStressTestResults(resultsFilePath);
    
    if (results) {
      const uuids = findUuidsInStressResults(results);
      console.log(`Found ${uuids.length} UUIDs in the results`);
      
      if (uuids.length > 0) {
        uuids.forEach((uuid, index) => {
          console.log(`\n${colors.bright}UUID ${index + 1}/${uuids.length}${colors.reset}`);
          const analysis = analyzeUuid(uuid);
          printUuidAnalysis(analysis);
        });
      } else {
        console.log('\nNo UUIDs found in the stress test results.');
        startInteractiveMode();
      }
    }
    return;
  }
  
  // Check for extracted UUIDs option
  const extractedIndex = args.indexOf('--extracted');
  if (extractedIndex !== -1 && args.length > extractedIndex + 1) {
    const extractedFilePath = args[extractedIndex + 1];
    const uuids = loadExtractedUuids(extractedFilePath);
    
    if (uuids && uuids.length > 0) {
      console.log(`Found ${uuids.length} extracted UUIDs`);
      
      uuids.forEach((uuid, index) => {
        console.log(`\n${colors.bright}UUID ${index + 1}/${uuids.length}${colors.reset}`);
        const analysis = analyzeUuid(uuid);
        printUuidAnalysis(analysis);
      });
    } else {
      console.log('\nNo UUIDs found in the extracted UUIDs file.');
      startInteractiveMode();
    }
    return;
  }
  
  // Check for direct UUID parameter
  const possibleUuid = args.find(arg => !arg.startsWith('--'));
  if (possibleUuid) {
    const analysis = analyzeUuid(possibleUuid);
    printUuidAnalysis(analysis);
    return;
  }
  
  // If no valid option was provided, start interactive mode
  startInteractiveMode();
}

/**
 * Start interactive mode to analyze UUIDs
 */
function startInteractiveMode() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  console.log('\nEnter a UUID to analyze (or type "exit" to quit):');
  
  rl.on('line', (input) => {
    const trimmedInput = input.trim();
    
    if (trimmedInput.toLowerCase() === 'exit') {
      rl.close();
      return;
    }
    
    const analysis = analyzeUuid(trimmedInput);
    printUuidAnalysis(analysis);
    
    console.log('Enter another UUID (or type "exit" to quit):');
  });
  
  rl.on('close', () => {
    console.log('\nThank you for using the UUID Analyzer!\n');
    process.exit(0);
  });
}

try {
  main();
} catch (error) {
  console.error(`\n${colors.red}Error: ${error.message}${colors.reset}\n`);
  process.exit(1);
} 
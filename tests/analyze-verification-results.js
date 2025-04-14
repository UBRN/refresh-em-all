/**
 * Verification Results UUID Analyzer
 * 
 * This script extracts UUIDs from verification-results.json and analyzes them
 * using the uuid-analyzer.js tool to help diagnose issues.
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// UUID regex pattern
const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// File paths
const verificationResultsPath = path.join(__dirname, 'verification-results.json');
const analyzerPath = path.join(__dirname, 'uuid-analyzer.js');

async function main() {
  console.log('Analyzing UUIDs in verification results...\n');
  
  // Check if verification results file exists
  if (!fs.existsSync(verificationResultsPath)) {
    console.error('Verification results file not found. Run npm run verify first.');
    process.exit(1);
  }
  
  // Read the verification results
  const verificationResults = JSON.parse(fs.readFileSync(verificationResultsPath, 'utf8'));
  
  // Convert to string for UUID extraction
  const resultsString = JSON.stringify(verificationResults);
  
  // Extract UUIDs
  const foundUuids = [...new Set(resultsString.match(UUID_REGEX) || [])];
  
  console.log(`Found ${foundUuids.length} unique UUIDs in verification results.\n`);
  
  if (foundUuids.length === 0) {
    console.log('No UUIDs found to analyze.');
    return;
  }
  
  // Analyze each UUID
  for (const uuid of foundUuids) {
    console.log(`Analyzing UUID: ${uuid}`);
    console.log('------------------------');
    
    try {
      const { stdout } = await execPromise(`node ${analyzerPath} ${uuid}`);
      console.log(stdout);
    } catch (error) {
      console.error(`Error analyzing UUID ${uuid}:`, error.message);
    }
    
    console.log('------------------------\n');
  }
  
  console.log('UUID analysis complete!');
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
}); 
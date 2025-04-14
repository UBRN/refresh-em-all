#!/usr/bin/env node

/**
 * UUID Extractor for Refresh-Em-All Extension
 * 
 * This tool extracts UUIDs from the background.js file and saves them to a JSON file
 * for analysis with the uuid-analyzer.js tool.
 */

const fs = require('fs');
const path = require('path');

// UUID validation patterns - multiple patterns to catch different UUID formats
const UUID_PATTERNS = [
  // Standard UUID pattern
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  
  // Pattern for UUIDs in string literals that might be broken across lines
  /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/gi,
  /"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/gi,
  /`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`/gi,
  
  // UUIDs as part of code/variables - prefixes like 10000000, 20000000, etc.
  /\b[0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12}\b/gi,
  
  // Pattern for UUID templates (like the one used in generateUuid)
  /'[x-]{8}-[x-]{4}-[x-]{4}-[x-]{4}-[x-]{12}'/gi,
  /"[x-]{8}-[x-]{4}-[x-]{4}-[x-]{4}-[x-]{12}"/gi,
  /`[x-]{8}-[x-]{4}-[x-]{4}-[x-]{4}-[x-]{12}`/gi
];

// Prefixes to look for when generating synthetic test UUIDs
const UUID_PREFIXES = [
  '00000000',
  '10000000',
  '20000000',
  '30000000',
  '40000000',
  '50000000',
  'a0000000',
  'f0000000'
];

/**
 * Extracts UUIDs from a file
 */
function extractUuidsFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const uuids = new Set();
    let uuidTemplateFound = false;

    // Apply each pattern
    UUID_PATTERNS.forEach(pattern => {
      const matches = content.match(pattern) || [];
      matches.forEach(match => {
        // Check if this is a UUID template
        if (match.includes('x') && match.includes('-')) {
          uuidTemplateFound = true;
          // Extract the template format
          console.log(`Found UUID template: ${match}`);
          return;
        }
        
        // Clean up the match (remove quotes if present)
        let uuid = match.replace(/['"` ]/g, '');
        // Normalize to lowercase
        uuid = uuid.toLowerCase();
        // Only add if it looks like a valid UUID
        if (/^[0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12}$/.test(uuid)) {
          // Standardize separators to dashes
          uuid = uuid.replace(/_/g, '-');
          uuids.add(uuid);
        }
      });
    });

    // If we found a UUID template pattern, extract it and generate examples
    if (uuidTemplateFound) {
      console.log('Extracting UUID generation pattern from code...');
      // Try to find the generateUuid function
      const generateUuidMatch = content.match(/function\s+generateUuid\s*\(\s*\)\s*{[\s\S]*?return\s+['"](.*?)['"]\.replace[\s\S]*?}/);
      
      if (generateUuidMatch && generateUuidMatch[1]) {
        const template = generateUuidMatch[1];
        console.log(`Found UUID generation template: ${template}`);
        
        // Look for the replacement function to understand version and variant
        const replaceMatch = content.match(/\.replace\([^)]*[^\n]*?(\bv\s*=\s*[^;]*)/);
        
        if (replaceMatch) {
          console.log(`UUID generation uses replacement pattern: ${replaceMatch[1]}`);
          console.log('Generating example UUIDs based on the pattern...');
          
          // Generate deterministic examples for each prefix
          UUID_PREFIXES.forEach(prefix => {
            // Create an example UUID matching the same format but with our prefix
            let exampleUuid = template.replace(/^x{8}/, prefix);
            // Ensure the version is 4 (the most common UUID version)
            exampleUuid = exampleUuid.replace(/^([^-]*-[^-]*-)[^-]/, '$14');
            // Ensure the variant is correct (8, 9, a, or b in the first position)
            exampleUuid = exampleUuid.replace(/^([^-]*-[^-]*-[^-]*-)[^-]/, '$18');
            
            // Replace remaining x's and y's with realistic values
            exampleUuid = exampleUuid.replace(/[xy]/g, (c, i) => {
              if (i < prefix.length) return prefix[i]; // Keep our prefix intact
              return '0'; // Fill remaining with zeros for predictability
            });
            
            uuids.add(exampleUuid.toLowerCase());
          });
          
          console.log(`Generated ${UUID_PREFIXES.length} example UUIDs from the template.`);
        }
      }
    }

    // If no UUIDs found, look for places where UUIDs might be constructed
    if (uuids.size === 0 && !uuidTemplateFound) {
      // Look for common UUID generation patterns
      if (content.includes('generateUuid') || content.includes('crypto.randomUUID')) {
        console.log('UUID generation functions detected but no actual UUIDs found.');
        console.log('Generating example UUIDs with known prefixes for testing...');
        
        // Generate synthetic example UUIDs for testing
        UUID_PREFIXES.forEach(prefix => {
          const exampleUuid = `${prefix}-0000-4000-8000-000000000000`;
          uuids.add(exampleUuid);
        });
        
        console.log(`Added ${UUID_PREFIXES.length} synthetic UUIDs for analysis.`);
      }
    }

    return Array.from(uuids);
  } catch (error) {
    console.error(`Error extracting UUIDs from file: ${error.message}`);
    return [];
  }
}

/**
 * Analyze the code for potential UUID related functions
 */
function analyzeCodeForUuidFunctions(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const results = {
      generationFunctions: [],
      usageFunctions: [],
      potentialFormatters: []
    };

    // Look for UUID generation
    const generationPatterns = [
      { regex: /function\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*{[^}]*generateUuid|randomUUID|uuid\.v4|uuidv4/g, type: 'generation' },
      { regex: /function\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*{[^}]*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/g, type: 'usage' },
      { regex: /function\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*{[^}]*\.replace\([^)]*UUID|\.match\([^)]*UUID/g, type: 'formatter' }
    ];

    generationPatterns.forEach(pattern => {
      const matches = content.matchAll(pattern.regex);
      for (const match of matches) {
        const funcName = match[1];
        if (pattern.type === 'generation') {
          results.generationFunctions.push(funcName);
        } else if (pattern.type === 'usage') {
          results.usageFunctions.push(funcName);
        } else if (pattern.type === 'formatter') {
          results.potentialFormatters.push(funcName);
        }
      }
    });

    // Specifically look for generateUuid function
    const generateUuidMatch = content.match(/function\s+generateUuid\s*\(\s*\)\s*{[\s\S]*?return\s+['"](.*?)['"]\.replace[\s\S]*?}/);
    if (generateUuidMatch) {
      console.log('\nFound UUID generation implementation:');
      
      const template = generateUuidMatch[0];
      // Extract just the relevant parts for display
      const simplifiedTemplate = template
        .replace(/\s+/g, ' ')
        .replace(/{\s*(.*?)\s*}/, '{ $1 }');
      
      console.log(`${simplifiedTemplate}`);
      
      // Try to determine UUID version and variant from the implementation
      if (template.includes('4xxx')) {
        console.log('- Generates version 4 UUIDs (randomly generated)');
      }
      
      if (template.includes('yxxx') && (template.includes('r & 0x3 | 0x8') || template.includes('v = c === \'x\''))) {
        console.log('- Sets the UUID variant to RFC 4122 (variant 1)');
      }
    }

    return results;
  } catch (error) {
    console.error(`Error analyzing code: ${error.message}`);
    return { generationFunctions: [], usageFunctions: [], potentialFormatters: [] };
  }
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log('\nUUID Extractor for Refresh-Em-All Extension');
    console.log('==========================================\n');
    console.log('Usage:');
    console.log('  node extract-uuids.js [options] [file-path]\n');
    console.log('Options:');
    console.log('  --output <file>     Output JSON file (default: ./extracted-uuids.json)');
    console.log('  --include-synthetic Include synthetic example UUIDs if no real ones found');
    console.log('  --analyze           Analyze code for UUID-related functions');
    console.log('  --help, -h          Show this help message\n');
    console.log('Examples:');
    console.log('  node extract-uuids.js background.js');
    console.log('  node extract-uuids.js --output uuids.json background.js');
    console.log('  node extract-uuids.js --analyze --include-synthetic background.js\n');
    return;
  }
  
  // Default values
  let targetFile = 'background.js';
  let outputFile = './extracted-uuids.json';
  let includeSynthetic = false;
  let analyze = false;
  
  // Process arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output') {
      outputFile = args[++i];
    } else if (args[i] === '--include-synthetic') {
      includeSynthetic = true;
    } else if (args[i] === '--analyze') {
      analyze = true;
    } else if (!args[i].startsWith('--')) {
      targetFile = args[i];
    }
  }
  
  // Resolve paths
  const resolvedTargetFile = path.resolve(process.cwd(), targetFile);
  const resolvedOutputFile = path.resolve(process.cwd(), outputFile);
  
  console.log(`\nExtracting UUIDs from: ${resolvedTargetFile}`);
  
  // Extract UUIDs
  const uuids = extractUuidsFromFile(resolvedTargetFile);
  
  // If analyze flag is set, analyze the code for UUID functions
  if (analyze) {
    console.log('\nAnalyzing code for UUID-related functions...');
    const analysis = analyzeCodeForUuidFunctions(resolvedTargetFile);
    
    if (analysis.generationFunctions.length > 0) {
      console.log('\nPotential UUID generation functions:');
      analysis.generationFunctions.forEach(func => console.log(`- ${func}`));
    }
    
    if (analysis.usageFunctions.length > 0) {
      console.log('\nFunctions that likely use UUIDs:');
      analysis.usageFunctions.forEach(func => console.log(`- ${func}`));
    }
    
    if (analysis.potentialFormatters.length > 0) {
      console.log('\nFunctions that might format or validate UUIDs:');
      analysis.potentialFormatters.forEach(func => console.log(`- ${func}`));
    }
    
    if (analysis.generationFunctions.length === 0 && 
        analysis.usageFunctions.length === 0 && 
        analysis.potentialFormatters.length === 0) {
      console.log('No UUID-related functions detected.');
    }
  }
  
  // Generate synthetic UUIDs if needed and requested
  if (uuids.length === 0 && includeSynthetic) {
    console.log('\nNo UUIDs found. Generating synthetic test UUIDs...');
    UUID_PREFIXES.forEach(prefix => {
      const exampleUuid = `${prefix}-0000-4000-8000-000000000000`;
      uuids.push(exampleUuid);
    });
    console.log(`Added ${UUID_PREFIXES.length} synthetic UUIDs for analysis.`);
  }
  
  console.log(`\nFound ${uuids.length} unique UUIDs`);
  
  // Save to file
  if (uuids.length > 0) {
    fs.writeFileSync(resolvedOutputFile, JSON.stringify(uuids, null, 2));
    console.log(`UUIDs saved to: ${resolvedOutputFile}\n`);
    
    console.log('To analyze these UUIDs, run:');
    console.log(`npm run analyze-extracted\n`);
  } else {
    console.log('No UUIDs found to save\n');
  }
}

main(); 
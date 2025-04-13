// This is a utility script to generate icons of different sizes
// Run this script with Node.js to create the needed icon sizes
// You'll need to install sharp: npm install sharp

const fs = require('fs');
const path = require('path');

// Check if sharp is installed
try {
  const sharp = require('sharp');
  
  // Define icon sizes needed for Chrome extensions
  const sizes = [16, 32, 48, 128];
  
  // Source files (original high-resolution icons)
  const sourceFiles = [
    { 
      src: 'assets/icon-refresh-em-colorful.png', 
      prefix: 'assets/icon-refresh-em-colorful'
    },
    { 
      src: 'assets/icon-refresh-em.png', 
      prefix: 'assets/icon-refresh-em'
    }
  ];
  
  // Create assets directory if it doesn't exist
  if (!fs.existsSync('assets')) {
    fs.mkdirSync('assets');
  }
  
  // Process each source file and create resized versions
  async function processIcons() {
    for (const source of sourceFiles) {
      console.log(`Processing ${source.src}...`);
      
      if (!fs.existsSync(source.src)) {
        console.error(`Source file ${source.src} not found!`);
        continue;
      }
      
      for (const size of sizes) {
        const outputPath = `${source.prefix}-${size}.png`;
        
        try {
          await sharp(source.src)
            .resize(size, size)
            .toFile(outputPath);
          
          console.log(`Created: ${outputPath}`);
        } catch (err) {
          console.error(`Error creating ${outputPath}:`, err);
        }
      }
    }
    
    console.log('All icons generated successfully!');
  }
  
  processIcons().catch(err => {
    console.error('Error processing icons:', err);
  });
  
} catch (err) {
  console.error('Error: sharp module is not installed. Please install it using:');
  console.error('npm install sharp');
  process.exit(1);
} 
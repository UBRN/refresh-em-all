// This is a utility script to generate icons of different sizes
// Run this script with Node.js to create the needed icon sizes
// You'll need to install sharp: npm install sharp

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Check if sharp is installed
try {
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
  
  // Create doc/images/overview directory if it doesn't exist
  if (!fs.existsSync('doc/images/overview')) {
    fs.mkdirSync('doc/images/overview', { recursive: true });
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
  
  // Add function to generate favicon with solid background
  async function generateFavicon() {
    console.log('Generating favicon...');
    
    // Use the colorful icon as the base since it likely has better contrast
    const inputPath = path.join(__dirname, 'assets/icon-refresh-em-colorful.png');
    const outputPath = path.join(__dirname, 'favicon.png');
    
    try {
      // Create a favicon with a solid background
      await sharp(inputPath)
        .resize(32, 32, { fit: 'contain', background: '#2b5797' }) // Blue background to match browser UI
        .toFile(outputPath);
      
      console.log(`✅ Created favicon.png`);
    } catch (error) {
      console.error('Error generating favicon:', error);
    }
  }

  // Generate a high-resolution hero image for README
  async function generateHeroImage() {
    console.log('Generating hero image...');
    
    // Use the colorful icon as the base
    const inputPath = path.join(__dirname, 'assets/icon-refresh-em-colorful.png');
    const outputPath = path.join(__dirname, 'doc/images/overview/hero_image.png');
    
    try {
      // Create a hero image with gradient background
      // Create a 1200x600 canvas with blue gradient background
      const width = 1200;
      const height = 600;
      
      // Create a gradient background
      const gradient = Buffer.from(
        `<svg width="${width}" height="${height}">
          <defs>
            <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#4285f4" />
              <stop offset="100%" stop-color="#2b5797" />
            </linearGradient>
          </defs>
          <rect width="${width}" height="${height}" fill="url(#gradient)" />
        </svg>`
      );
      
      // Read the icon
      const icon = await sharp(inputPath).resize(300, 300).toBuffer();
      
      // Create the hero image with the icon centered
      await sharp(gradient)
        .composite([
          {
            input: icon,
            gravity: 'center'
          }
        ])
        .toFile(outputPath);
      
      console.log(`✅ Created hero_image.png`);
    } catch (error) {
      console.error('Error generating hero image:', error);
    }
  }

  // Include favicon generation in the main flow
  async function main() {
    try {
      // First generate both sets of icon sizes
      await processIcons();
      
      // Then generate the favicon
      await generateFavicon();
      
      // Generate hero image
      await generateHeroImage();
      
      console.log('✅ All assets generated successfully!');
    } catch (error) {
      console.error('Error generating assets:', error);
      process.exit(1);
    }
  }

  main();
} catch (err) {
  console.error('Error: sharp module is not installed. Please install it using:');
  console.error('npm install sharp');
  process.exit(1);
} 
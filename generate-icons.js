#!/usr/bin/env node

'use strict';

// Renders every raster icon from the two SVG sources in assets/.
// icon.svg is the artwork; icon-16.svg is the same artwork with heavier
// strokes so the arrow still reads at 16 px. Both are framed for the toolbar
// (tile edges on whole pixels at 16, 32 and 48). The 128 px icon is the Chrome
// Web Store icon: 96 px of artwork inside a 16 px transparent margin.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = __dirname;
const STORE_VIEWBOX = '-10.5 -10.5 148 148';

function readSvg(name) {
  return fs.readFileSync(path.join(root, 'assets', name), 'utf8');
}

function withViewBox(svg, viewBox) {
  return svg.replace(/viewBox="[^"]+"/, `viewBox="${viewBox}"`);
}

async function render(svg, size, outputPath) {
  await sharp(Buffer.from(svg), { density: 400 })
    .resize(size, size)
    .toColourspace('srgb')
    .png({ compressionLevel: 9 })
    .toFile(path.join(root, outputPath));
  console.log(`Created ${outputPath}`);
}

async function renderHero(svg) {
  const width = 1200;
  const height = 600;
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <radialGradient id="glow" cx="50%" cy="45%" r="70%">
          <stop offset="0" stop-color="#e8efff"/>
          <stop offset="1" stop-color="#f7f9fd"/>
        </radialGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#glow)"/>
    </svg>`
  );
  const icon = await sharp(Buffer.from(withViewBox(svg, STORE_VIEWBOX)), { density: 400 })
    .resize(320, 320)
    .toBuffer();
  const outputPath = 'doc/images/overview/hero_image.png';
  await sharp(background)
    .composite([{ input: icon, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(root, outputPath));
  console.log(`Created ${outputPath}`);
}

async function main() {
  const icon = readSvg('icon.svg');
  const small = readSvg('icon-16.svg');

  await render(small, 16, 'assets/icon-16.png');
  await render(icon, 32, 'assets/icon-32.png');
  await render(icon, 48, 'assets/icon-48.png');
  await render(withViewBox(icon, STORE_VIEWBOX), 128, 'assets/icon-128.png');

  fs.writeFileSync(path.join(root, 'favicon.svg'), icon);
  console.log('Created favicon.svg');

  await renderHero(icon);
}

main().catch(error => {
  console.error(`Icon generation failed: ${error.message}`);
  process.exitCode = 1;
});

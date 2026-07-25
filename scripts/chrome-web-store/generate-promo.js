#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const repositoryRoot = path.resolve(__dirname, '../..');
const sourcePath = path.join(
  repositoryRoot,
  'docs/chrome-web-store/assets/promo/small-440x280.svg'
);
const outputPath = path.join(
  repositoryRoot,
  'docs/chrome-web-store/assets/promo/small-440x280.png'
);

async function main() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  await sharp(Buffer.from(source))
    .resize(440, 280, { fit: 'fill' })
    .flatten({ background: '#174ea6' })
    .toColourspace('srgb')
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toFile(outputPath);

  const metadata = await sharp(outputPath).metadata();
  if (metadata.format !== 'png' || metadata.width !== 440 || metadata.height !== 280) {
    throw new Error(`Unexpected promotional image output: ${JSON.stringify(metadata)}`);
  }

  console.log(`Created ${path.relative(repositoryRoot, outputPath)} (${metadata.width}x${metadata.height})`);
}

main().catch(error => {
  console.error(`Promotional image generation failed: ${error.message}`);
  process.exitCode = 1;
});

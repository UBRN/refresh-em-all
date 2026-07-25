#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { parseZip, RUNTIME_FILES } = require('../package-extension');

const repositoryRoot = path.resolve(__dirname, '../..');
const assetRoot = path.join(repositoryRoot, 'docs/chrome-web-store/assets');
const screenshotDirectory = path.join(assetRoot, 'screenshots');
const promoSvgPath = path.join(assetRoot, 'promo/small-440x280.svg');
const promoPngPath = path.join(assetRoot, 'promo/small-440x280.png');
const resultRoot = path.join(repositoryRoot, 'test-results/chrome-web-store');
const reviewRoot = path.join(resultRoot, 'review');
const expectedPackageSha = 'dae27e545bea8b27f842657781ff8fc172c5ccc431e7650357c6098e74f9954d';
const screenshotNames = [
  '01-ready-1280x800.png',
  '02-refresh-in-progress-1280x800.png',
  '03-refresh-complete-1280x800.png',
  '04-history-1280x800.png',
  '05-privacy-settings-1280x800.png'
];

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find(argument => argument.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hasPngSignature(buffer) {
  return buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

async function inspectPng(filename, width, height, { requireOpaque = false } = {}) {
  const buffer = fs.readFileSync(filename);
  if (!hasPngSignature(buffer)) throw new Error(`${filename} does not have a PNG signature`);

  const image = sharp(buffer);
  const metadata = await image.metadata();
  if (metadata.format !== 'png' || metadata.width !== width || metadata.height !== height) {
    throw new Error(
      `${path.relative(repositoryRoot, filename)} must be ${width}x${height} PNG; `
      + `received ${metadata.format} ${metadata.width}x${metadata.height}`
    );
  }
  if (metadata.space !== 'srgb') {
    throw new Error(`${path.relative(repositoryRoot, filename)} must use sRGB; received ${metadata.space}`);
  }

  const stats = await image.stats();
  const alpha = metadata.hasAlpha
    ? stats.channels[metadata.channels - 1]
    : { min: 255, max: 255 };
  if (requireOpaque && alpha.min !== 255) {
    throw new Error(`${path.relative(repositoryRoot, filename)} has transparent pixels`);
  }

  return {
    path: path.relative(repositoryRoot, filename),
    sha256: sha256(buffer),
    bytes: buffer.length,
    width: metadata.width,
    height: metadata.height,
    space: metadata.space,
    channels: metadata.channels,
    alphaMin: alpha.min,
    alphaMax: alpha.max
  };
}

function validateSvg() {
  const svg = fs.readFileSync(promoSvgPath, 'utf8');
  const forbidden = [
    [/<script\b/i, 'script elements'],
    [/<image\b/i, 'embedded or external images'],
    [/<foreignObject\b/i, 'foreignObject content'],
    [/@import\b/i, 'CSS imports'],
    [/\bfont-family\s*=/i, 'font dependencies'],
    [/\bhref\s*=/i, 'href dependencies'],
    [/url\((?!\s*#)/i, 'external URL references']
  ];
  for (const [pattern, description] of forbidden) {
    if (pattern.test(svg)) throw new Error(`Promotional SVG contains ${description}`);
  }
  if (!/<svg\b[^>]*width="440"[^>]*height="280"/i.test(svg)) {
    throw new Error('Promotional SVG must declare a 440x280 canvas');
  }
}

function dominantEdgeColour(data, info) {
  const counts = new Map();
  const record = (x, y) => {
    const index = (y * info.width + x) * info.channels;
    const colour = `${data[index]},${data[index + 1]},${data[index + 2]}`;
    counts.set(colour, (counts.get(colour) || 0) + 1);
  };
  for (let x = 0; x < info.width; x += 1) {
    record(x, 0);
    record(x, info.height - 1);
  }
  for (let y = 1; y < info.height - 1; y += 1) {
    record(0, y);
    record(info.width - 1, y);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0]
    .split(',').map(Number);
}

async function inspectPackagedIcon(zipPath) {
  const zipBuffer = fs.readFileSync(zipPath);
  const packageSha = sha256(zipBuffer);
  if (packageSha !== expectedPackageSha) {
    throw new Error(`Package SHA-256 mismatch: expected ${expectedPackageSha}, received ${packageSha}`);
  }

  const entries = parseZip(zipBuffer);
  const names = entries.map(entry => entry.filename);
  if (JSON.stringify(names) !== JSON.stringify(RUNTIME_FILES)) {
    throw new Error('Published ZIP entries do not match the runtime allowlist');
  }
  const entryMap = new Map(entries.map(entry => [entry.filename, entry.data]));
  const manifest = JSON.parse(entryMap.get('manifest.json').toString('utf8'));
  if (manifest.version !== '2.0.1') throw new Error(`Unexpected packaged version ${manifest.version}`);
  const iconPath = manifest.icons?.['128'];
  if (!entryMap.has(iconPath)) throw new Error(`Packaged Store icon is missing: ${iconPath}`);

  const icon = entryMap.get(iconPath);
  const image = sharp(icon);
  const metadata = await image.metadata();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const background = dominantEdgeColour(data, info);
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const index = (y * info.width + x) * info.channels;
      const delta = Math.max(
        Math.abs(data[index] - background[0]),
        Math.abs(data[index + 1] - background[1]),
        Math.abs(data[index + 2] - background[2])
      );
      if (delta > 5) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }

  fs.mkdirSync(reviewRoot, { recursive: true });
  await Promise.all([
    sharp({ create: { width: 256, height: 256, channels: 3, background: '#ffffff' } })
      .composite([{ input: icon, left: 64, top: 64 }])
      .png().toFile(path.join(reviewRoot, 'icon-on-light.png')),
    sharp({ create: { width: 256, height: 256, channels: 3, background: '#202124' } })
      .composite([{ input: icon, left: 64, top: 64 }])
      .png().toFile(path.join(reviewRoot, 'icon-on-dark.png'))
  ]);

  const result = {
    packageSha256: packageSha,
    packageVersion: manifest.version,
    manifestIconPath: iconPath,
    icon: {
      sha256: sha256(icon),
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      channels: metadata.channels,
      hasAlpha: metadata.hasAlpha,
      approximateArtworkBounds: right < 0 ? null : {
        left,
        top,
        right,
        bottom,
        width: right - left + 1,
        height: bottom - top + 1
      },
      finding: 'Valid 128x128 PNG; opaque padding is retained for v2.0.1 and documented as a future improvement.'
    }
  };
  fs.mkdirSync(resultRoot, { recursive: true });
  fs.writeFileSync(path.join(resultRoot, 'icon-audit.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function verifyPromo() {
  validateSvg();
  const result = await inspectPng(promoPngPath, 440, 280, { requireOpaque: true });
  fs.mkdirSync(reviewRoot, { recursive: true });
  await sharp(promoPngPath)
    .resize(220, 140, { fit: 'fill' })
    .png()
    .toFile(path.join(reviewRoot, 'promo-220x140.png'));
  return result;
}

async function verifyScreenshots() {
  const previewDirectory = path.join(reviewRoot, 'screenshots-640x400');
  fs.mkdirSync(previewDirectory, { recursive: true });
  const results = [];
  for (const name of screenshotNames) {
    const filename = path.join(screenshotDirectory, name);
    results.push(await inspectPng(filename, 1280, 800, { requireOpaque: true }));
    await sharp(filename)
      .resize(640, 400, { fit: 'fill' })
      .png()
      .toFile(path.join(previewDirectory, name.replace('1280x800', '640x400')));
  }
  return results;
}

async function main() {
  const zipPath = argumentValue('--zip');
  const iconOnly = process.argv.includes('--icon-only');
  const promoOnly = process.argv.includes('--promo-only');
  if (iconOnly && promoOnly) throw new Error('--icon-only and --promo-only cannot be combined');

  const result = {};
  if (zipPath) result.iconAudit = await inspectPackagedIcon(path.resolve(zipPath));
  if (iconOnly) {
    if (!zipPath) throw new Error('--icon-only requires --zip');
  } else if (promoOnly) {
    result.promo = await verifyPromo();
  } else {
    result.screenshots = await verifyScreenshots();
    result.promo = await verifyPromo();
  }

  fs.mkdirSync(resultRoot, { recursive: true });
  fs.writeFileSync(path.join(resultRoot, 'asset-validation.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log('Chrome Web Store asset validation passed.');
}

main().catch(error => {
  console.error(`Chrome Web Store asset validation failed: ${error.message}`);
  process.exitCode = 1;
});

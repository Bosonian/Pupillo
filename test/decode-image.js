#!/usr/bin/env node
/**
 * Decode a BMP barcode from an image file.
 *
 * Usage:
 *   node test/decode-image.js <image-path>
 *
 * Example:
 *   node test/decode-image.js ~/Downloads/barcode-photo.jpg
 *
 * Runs the image through our full preprocessing pipeline and
 * attempts to parse any BMP (Medikationsplan) data found.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { processForDecode, assessQuality } = require('../server/image-decode');
const { isBMP, parseBMP } = require('../server/bmp-parser');

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error('Usage: node test/decode-image.js <image-path>');
    process.exit(1);
  }

  const absPath = path.resolve(imagePath);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  console.log(`\nLoading: ${absPath}`);
  const imageBuffer = fs.readFileSync(absPath);
  const meta = await sharp(imageBuffer).metadata();
  console.log(`Image: ${meta.width}x${meta.height} ${meta.format}\n`);

  // Assess quality
  const quality = await assessQuality(imageBuffer);
  console.log(`Quality: sharpness=${quality.sharpness} resolution=${quality.resolution} overall=${quality.overall}\n`);

  // Generate preprocessing variants
  console.log('Generating preprocessing variants...');
  const variants = await processForDecode(imageBuffer);
  console.log(`Generated ${variants.length} variants: ${variants.map(v => v.name).join(', ')}\n`);

  // Save variants as files for inspection
  const outDir = path.join(path.dirname(absPath), 'variants');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  for (const variant of variants) {
    const base64 = variant.dataUrl.replace(/^data:image\/png;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    const outPath = path.join(outDir, `${variant.name}.png`);
    fs.writeFileSync(outPath, buf);
  }
  console.log(`Saved variant images to: ${outDir}/`);
  console.log('You can inspect these visually or feed them to a barcode scanner.\n');

  // Also save a binarized version optimized for scanning
  const optimized = await sharp(imageBuffer)
    .grayscale()
    .normalize()
    .sharpen({ sigma: 2 })
    .threshold(128)
    .png()
    .toBuffer();
  const optimizedPath = path.join(outDir, '_optimized.png');
  fs.writeFileSync(optimizedPath, optimized);
  console.log(`Optimized binarized image: ${optimizedPath}`);

  // Try to analyze what we can about the barcode without zxing-wasm
  console.log('\n─── Image Analysis ───');

  // Check center region for barcode-like patterns
  const gray = await sharp(imageBuffer)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = gray.info.width;
  const h = gray.info.height;
  const pixels = gray.data;

  // Estimate black/white ratio in center (barcode region)
  const cx = Math.floor(w * 0.25), ex = Math.floor(w * 0.75);
  const cy = Math.floor(h * 0.2), ey = Math.floor(h * 0.8);
  let black = 0, white = 0;
  for (let y = cy; y < ey; y += 2) {
    for (let x = cx; x < ex; x += 2) {
      pixels[y * w + x] < 128 ? black++ : white++;
    }
  }
  const total = black + white;
  console.log(`Center region B/W ratio: ${(black/total*100).toFixed(1)}% black, ${(white/total*100).toFixed(1)}% white`);
  console.log(`(Data Matrix should be roughly 50/50 — got ${Math.abs(50 - black/total*100).toFixed(1)}% deviation)`);

  // Estimate module size by looking at run lengths
  const midY = Math.floor(h / 2);
  let runs = [];
  let currentVal = pixels[midY * w + cx] < 128 ? 0 : 1;
  let runLen = 0;
  for (let x = cx; x < ex; x++) {
    const val = pixels[midY * w + x] < 128 ? 0 : 1;
    if (val === currentVal) {
      runLen++;
    } else {
      runs.push(runLen);
      currentVal = val;
      runLen = 1;
    }
  }
  if (runs.length > 10) {
    // Remove outliers (very long runs are quiet zones)
    runs.sort((a, b) => a - b);
    const p25 = runs[Math.floor(runs.length * 0.25)];
    const p75 = runs[Math.floor(runs.length * 0.75)];
    const moduleEst = Math.round((p25 + p75) / 2);
    const barcodeWidthPx = ex - cx;
    const modulesEst = Math.round(barcodeWidthPx / moduleEst);
    console.log(`Estimated module size: ~${moduleEst}px`);
    console.log(`Estimated barcode modules: ~${modulesEst}x${modulesEst}`);

    if (modulesEst >= 60 && modulesEst <= 160) {
      console.log(`→ This looks like a large Data Matrix (consistent with BMP)`);
    }
  }

  console.log('\n─── Next Steps ───');
  console.log('1. Open one of the variant images in a Data Matrix scanner app');
  console.log('2. Or use our Pupillo web app and point phone at a variant image on screen');
  console.log('3. If decoded, the raw bytes should start with "MP" (BMP medication plan)\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

/**
 * Adversarial Barcode Test Harness
 *
 * Generates synthetic BMP Data Matrix barcodes with known content,
 * applies realistic camera degradations, and tests whether our
 * preprocessing pipeline can recover them.
 *
 * The goal: find which degradations break our decoder, then improve
 * the preprocessing to handle them.
 *
 * Usage: node test/adversarial.js
 */

const bwipjs = require('bwip-js');
const sharp = require('sharp');
const zlib = require('zlib');
const path = require('path');
const { processForDecode, assessQuality } = require('../server/image-decode');
const { isBMP, parseBMP } = require('../server/bmp-parser');

// ═══════════════════════════════════════════════════════════════
// TEST DATA — simulate real BMP medication plans
// ═══════════════════════════════════════════════════════════════

const TEST_PLANS = [
  {
    name: 'simple-3-meds',
    xml: `<MP v="022" U="test-1"><P g="Max" f="Muster" b="19500315" /><A n="Dr. Schmidt" t="20240101" /><S t="Blutdruck"><M a="Ramipril 5mg" f="TAB" p="1" m="0" d="0" h="0" r="Bluthochdruck" /><M a="Bisoprolol 5mg" f="TAB" p="1" m="0" d="0" h="0" r="Bluthochdruck" /></S><S t="Schmerzen"><M a="Ibuprofen 400mg" f="TAB" i="bei Bedarf" r="Schmerzen" /></S></MP>`,
  },
  {
    name: 'medium-6-meds',
    xml: `<MP v="022" U="test-2"><P g="Anna" f="Schmidt" b="19401201" /><A n="Beispiel-Apotheke" s="Hauptstr. 1" z="01662" c="Meissen" t="20160501" /><S t="Diabetes"><M a="ACTRAPID PENFILL" f="Amp" p="10" m="6" d="8" h="0" du="IE" r="Diabetes mellitus" /><M a="METFORMIN 1000" f="TAB" p="1" m="0" d="1" h="0" r="Diabetes mellitus" /></S><S t="Herz"><M a="TORASEMID 10MG" f="TAB" p="1" m="0" d="0" h="0" r="Wassereinlagerung" /><M a="RAMIPRIL 5/25MG" f="TAB" p="1" m="0" d="0" h="0" r="Bluthochdruck" /><M a="BISOPROLOL 5MG" f="TAB" p="1" m="0" d="0" h="0" r="Bluthochdruck" /></S><S t="Bedarfsmedikation"><M a="NOVAMINSULFON 500" f="Tropfen" p="30" m="30" d="30" h="0" r="Schmerzen" /></S></MP>`,
  },
  {
    name: 'full-9-meds',
    xml: `<MP v="022" U="test-3"><P g="Anton" f="Beispiel" b="19400101" /><A n="Beispiel-Apotheke" s="Musterweg 1" z="01662" c="Meissen" p="03521-1234567" e="apotheke@meissen.de" t="20160501" /><S t="Diabetes mellitus"><M a="ACTRAPID PENFILL ZAM" f="Amp" p="10" m="6" d="8" h="0" du="IE" r="Diabetes mellitus" /><M a="LANTUS 100E/ML SOLOSTAR FS" f="Spritze" r="Diabetes mellitus" i="Abends 18-30 IE nach Messergebnis" /><M a="METFORMIN LICH 1000 MG" f="TAB" p="1" m="0" d="1" h="0" r="Diabetes mellitus" i="zu den Mahlzeiten" /></S><S t="Schilddruese"><M a="L THYROX HEXAL 100" f="TAB" p="0.5" m="0" d="1" h="0" r="Schilddruesenunterfunktion" i="30 min vor Fruehstueck" /></S><S t="Herz/Blutdruck"><M a="TORASEMID AL 10MG" f="TAB" p="1" m="0" d="0" h="0" r="Wassereinlagerung Beine" /><M a="RAMIPRIL COMP ABZ 5/25MG" f="TAB" p="1" m="0" d="0" h="0" r="Bluthochdruck" /><M a="BISOPROLOL ABZ 5MG" f="TAB" p="1" m="0" d="0" h="0" r="Bluthochdruck" /></S><S t="Bedarfsmedikation"><M a="DICLO 50 1A PHARMA" f="TAB" r="Schmerzen" i="bei Bedarf 1 Tabl" /><M a="NOVAMINSULFON 500 MG LICHT" f="Tropfen" p="30" m="30" d="30" h="0" r="Schmerzen" /></S></MP>`,
  },
];

// ═══════════════════════════════════════════════════════════════
// DEGRADATION FUNCTIONS — simulate real-world camera problems
// ═══════════════════════════════════════════════════════════════

const DEGRADATIONS = {
  // Clean baseline — no degradation
  'clean': async (buf) => buf,

  // Gaussian blur (out of focus)
  'blur-light': async (buf) => sharp(buf).blur(1.5).toBuffer(),
  'blur-medium': async (buf) => sharp(buf).blur(2.5).toBuffer(),
  'blur-heavy': async (buf) => sharp(buf).blur(4.0).toBuffer(),

  // Downscale (phone far from barcode)
  'downscale-50pct': async (buf) => {
    const meta = await sharp(buf).metadata();
    return sharp(buf).resize(Math.round(meta.width * 0.5)).jpeg({ quality: 85 }).toBuffer();
  },
  'downscale-33pct': async (buf) => {
    const meta = await sharp(buf).metadata();
    return sharp(buf).resize(Math.round(meta.width * 0.33)).jpeg({ quality: 80 }).toBuffer();
  },
  'downscale-25pct': async (buf) => {
    const meta = await sharp(buf).metadata();
    return sharp(buf).resize(Math.round(meta.width * 0.25)).jpeg({ quality: 75 }).toBuffer();
  },

  // JPEG compression artifacts
  'jpeg-q60': async (buf) => sharp(buf).jpeg({ quality: 60 }).toBuffer(),
  'jpeg-q30': async (buf) => sharp(buf).jpeg({ quality: 30 }).toBuffer(),
  'jpeg-q15': async (buf) => sharp(buf).jpeg({ quality: 15 }).toBuffer(),

  // Rotation (phone not aligned)
  'rotate-5deg': async (buf) => sharp(buf).rotate(5, { background: '#ffffff' }).toBuffer(),
  'rotate-15deg': async (buf) => sharp(buf).rotate(15, { background: '#ffffff' }).toBuffer(),
  'rotate-30deg': async (buf) => sharp(buf).rotate(30, { background: '#ffffff' }).toBuffer(),

  // Low contrast (poor lighting)
  'low-contrast': async (buf) => sharp(buf).linear(0.5, 64).toBuffer(),
  'very-low-contrast': async (buf) => sharp(buf).linear(0.3, 89).toBuffer(),

  // Noise (phone camera sensor noise in low light)
  'noise-light': async (buf) => addNoise(buf, 10),
  'noise-medium': async (buf) => addNoise(buf, 25),
  'noise-heavy': async (buf) => addNoise(buf, 50),

  // Brightness problems
  'overexposed': async (buf) => sharp(buf).modulate({ brightness: 1.6 }).toBuffer(),
  'underexposed': async (buf) => sharp(buf).modulate({ brightness: 0.4 }).toBuffer(),

  // Combined degradations (realistic phone capture)
  'phone-typical': async (buf) => {
    const meta = await sharp(buf).metadata();
    return sharp(buf)
      .resize(Math.round(meta.width * 0.4))
      .blur(1.2)
      .jpeg({ quality: 75 })
      .toBuffer();
  },
  'phone-bad': async (buf) => {
    const meta = await sharp(buf).metadata();
    return sharp(buf)
      .resize(Math.round(meta.width * 0.3))
      .blur(2.0)
      .linear(0.6, 51)
      .jpeg({ quality: 60 })
      .toBuffer();
  },
  'phone-terrible': async (buf) => {
    const meta = await sharp(buf).metadata();
    let degraded = await sharp(buf)
      .resize(Math.round(meta.width * 0.25))
      .blur(3.0)
      .rotate(8, { background: '#ffffff' })
      .linear(0.4, 77)
      .jpeg({ quality: 40 })
      .toBuffer();
    return addNoise(degraded, 20);
  },

  // Moiré pattern (photographing a screen/monitor)
  // Simulate by overlaying a high-frequency grid pattern
  'moire-light': async (buf) => addMoire(buf, 3, 30),
  'moire-heavy': async (buf) => addMoire(buf, 2, 60),

  // Screen capture (monitor photo: moiré + slight blur + brightness)
  'screen-capture': async (buf) => {
    let degraded = await addMoire(buf, 3, 25);
    return sharp(degraded).blur(0.8).modulate({ brightness: 1.1 }).jpeg({ quality: 80 }).toBuffer();
  },

  // Perspective distortion (simulated by affine transform via crop)
  'perspective-mild': async (buf) => {
    const meta = await sharp(buf).metadata();
    // Crop asymmetrically to simulate perspective
    const cropLeft = Math.round(meta.width * 0.05);
    const cropTop = Math.round(meta.height * 0.02);
    const cropW = Math.round(meta.width * 0.88);
    const cropH = Math.round(meta.height * 0.93);
    return sharp(buf)
      .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
      .resize(meta.width, meta.height, { fit: 'fill' }) // stretch back (simulates perspective)
      .toBuffer();
  },

  // Barcode surrounded by other content (not cropped)
  'with-margin': async (buf) => {
    const meta = await sharp(buf).metadata();
    return sharp(buf)
      .extend({ top: meta.height, bottom: meta.height, left: meta.width, right: meta.width, background: '#ffffff' })
      .toBuffer();
  },
};

/**
 * Add moiré pattern to simulate photographing a screen.
 * Overlays a periodic grid at the given frequency.
 */
async function addMoire(buf, frequency, intensity) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const pixels = Buffer.from(data);
  const { width, height, channels } = info;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const moire = Math.sin(x * frequency) * Math.sin(y * frequency) * intensity;
      const idx = (y * width + x) * channels;
      for (let c = 0; c < Math.min(channels, 3); c++) {
        pixels[idx + c] = Math.max(0, Math.min(255, pixels[idx + c] + moire));
      }
    }
  }
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
}

/**
 * Add salt-and-pepper noise to an image buffer.
 */
async function addNoise(buf, intensity) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const pixels = Buffer.from(data);
  for (let i = 0; i < pixels.length; i++) {
    const noise = (Math.random() - 0.5) * intensity * 2;
    pixels[i] = Math.max(0, Math.min(255, pixels[i] + noise));
  }
  return sharp(pixels, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toBuffer();
}

// ═══════════════════════════════════════════════════════════════
// BARCODE GENERATION
// ═══════════════════════════════════════════════════════════════

/**
 * Create a BMP binary payload from XML.
 */
function createBMPPayload(xml) {
  const compressed = zlib.deflateSync(Buffer.from(xml, 'utf-8'));
  return Buffer.concat([Buffer.from('MP'), Buffer.from([2, 2]), compressed]);
}

/**
 * Generate a Data Matrix barcode image (PNG buffer) from binary data.
 */
async function generateDataMatrixImage(binaryPayload, scale = 4) {
  // bwip-js needs the data as a string; for binary, use Base256 encoding
  const png = await bwipjs.toBuffer({
    bcid: 'datamatrix',
    text: binaryPayload.toString('latin1'),
    scale: scale,
    padding: 4,
    backgroundcolor: 'ffffff',
  });
  return png;
}

// ═══════════════════════════════════════════════════════════════
// DECODE TESTING — use our actual preprocessing pipeline
// ═══════════════════════════════════════════════════════════════

/**
 * Attempt to decode a degraded barcode image using our server-side
 * preprocessing pipeline + simulated client decode.
 *
 * Since we can't run zxing-wasm in Node.js easily, we test whether
 * our preprocessing variants produce images that are "decodable"
 * by measuring quality metrics and comparing against the original.
 *
 * Returns { decoded, method, quality, variants_tried }
 */
async function attemptDecode(imageBuffer, expectedPayload) {
  const quality = await assessQuality(imageBuffer);

  // Try direct decode first (check if the image is clean enough)
  const directResult = await tryDirectDecode(imageBuffer, expectedPayload);
  if (directResult) {
    return { decoded: true, method: 'direct', quality, variants_tried: 0 };
  }

  // Try each preprocessing variant
  const variants = await processForDecode(imageBuffer);
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    // Convert data URL back to buffer
    const base64 = variant.dataUrl.replace(/^data:image\/png;base64,/, '');
    const variantBuf = Buffer.from(base64, 'base64');

    const result = await tryDirectDecode(variantBuf, expectedPayload);
    if (result) {
      return { decoded: true, method: variant.name, quality, variants_tried: i + 1 };
    }
  }

  return { decoded: false, method: null, quality, variants_tried: variants.length };
}

/**
 * Simple heuristic decode check: verify the image has sufficient
 * contrast and sharpness in the barcode region to be decodable.
 *
 * Since we can't run zxing-wasm in Node, we use image analysis as a proxy.
 * A real test would use the WASM decoder, but this catches preprocessing
 * issues (too much blur, lost contrast, etc).
 */
async function tryDirectDecode(imageBuffer, expectedPayload) {
  try {
    const quality = await assessQuality(imageBuffer);

    // Heuristic: image needs minimum sharpness and resolution
    // These thresholds were empirically determined from known-good decodes
    if (quality.sharpness >= 15 && quality.resolution >= 5) {
      // Also check contrast in center region
      const gray = await sharp(imageBuffer)
        .grayscale().raw().toBuffer({ resolveWithObject: true });

      const pixels = gray.data;
      const w = gray.info.width;
      const h = gray.info.height;

      // Sample center region
      const cx = Math.floor(w * 0.3), ex = Math.floor(w * 0.7);
      const cy = Math.floor(h * 0.3), ey = Math.floor(h * 0.7);

      let min = 255, max = 0;
      for (let y = cy; y < ey; y += 2) {
        for (let x = cx; x < ex; x += 2) {
          const v = pixels[y * w + x];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }

      const contrast = max - min;
      // Data Matrix needs clear black/white distinction
      return contrast >= 80;
    }
    return false;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN TEST RUNNER
// ═══════════════════════════════════════════════════════════════

async function runTests() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' ADVERSARIAL BARCODE TEST HARNESS');
  console.log(' Testing preprocessing pipeline against degradations');
  console.log('═══════════════════════════════════════════════════════\n');

  const results = [];
  const degradationNames = Object.keys(DEGRADATIONS);

  for (const plan of TEST_PLANS) {
    console.log(`\n▶ Test Plan: ${plan.name}`);
    console.log('─'.repeat(60));

    // Generate the BMP payload and Data Matrix image
    const payload = createBMPPayload(plan.xml);
    console.log(`  Payload: ${payload.length} bytes compressed`);

    let baseImage;
    try {
      baseImage = await generateDataMatrixImage(payload, 6);
      const meta = await sharp(baseImage).metadata();
      console.log(`  Image: ${meta.width}x${meta.height}px\n`);
    } catch (err) {
      console.log(`  ✗ Failed to generate barcode: ${err.message}\n`);
      continue;
    }

    for (const degName of degradationNames) {
      const degradeFn = DEGRADATIONS[degName];

      try {
        // Apply degradation
        const degraded = await degradeFn(baseImage);

        // Attempt decode through our pipeline
        const result = await attemptDecode(degraded, payload);

        const status = result.decoded ? '✓' : '✗';
        const method = result.decoded ? ` → ${result.method}` : '';
        const qStr = `sharp=${result.quality.sharpness} res=${result.quality.resolution}`;

        console.log(`  ${status} ${degName.padEnd(22)} ${qStr.padEnd(20)}${method}`);

        results.push({
          plan: plan.name,
          degradation: degName,
          decoded: result.decoded,
          method: result.method,
          quality: result.quality,
          variants_tried: result.variants_tried,
        });
      } catch (err) {
        console.log(`  ✗ ${degName.padEnd(22)} ERROR: ${err.message}`);
        results.push({
          plan: plan.name,
          degradation: degName,
          decoded: false,
          method: null,
          quality: null,
          error: err.message,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════
  console.log('\n\n═══════════════════════════════════════════════════════');
  console.log(' RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════════\n');

  const total = results.length;
  const passed = results.filter(r => r.decoded).length;
  const failed = results.filter(r => !r.decoded);
  const passRate = ((passed / total) * 100).toFixed(1);

  console.log(`Overall: ${passed}/${total} (${passRate}%)\n`);

  // Group by degradation type
  const byDeg = {};
  for (const r of results) {
    if (!byDeg[r.degradation]) byDeg[r.degradation] = { pass: 0, fail: 0 };
    r.decoded ? byDeg[r.degradation].pass++ : byDeg[r.degradation].fail++;
  }

  console.log('By degradation:');
  for (const [deg, counts] of Object.entries(byDeg)) {
    const rate = ((counts.pass / (counts.pass + counts.fail)) * 100).toFixed(0);
    const bar = counts.fail > 0 ? ' ← WEAK' : '';
    console.log(`  ${deg.padEnd(24)} ${rate}% (${counts.pass}/${counts.pass + counts.fail})${bar}`);
  }

  // Identify weaknesses
  const weaknesses = Object.entries(byDeg)
    .filter(([_, c]) => c.fail > 0)
    .sort((a, b) => b[1].fail - a[1].fail);

  if (weaknesses.length > 0) {
    console.log('\n─── WEAKNESSES (prioritized) ───');
    for (const [deg, counts] of weaknesses) {
      const failRate = ((counts.fail / (counts.pass + counts.fail)) * 100).toFixed(0);
      console.log(`  ${failRate}% failure: ${deg}`);

      // Suggest fixes
      if (deg.includes('blur')) {
        console.log(`    → Add stronger deconvolution/sharpening variant`);
      } else if (deg.includes('downscale') || deg.includes('phone')) {
        console.log(`    → Add more aggressive upscale variant (4x+)`);
      } else if (deg.includes('contrast') || deg.includes('exposed')) {
        console.log(`    → Add CLAHE-style local contrast enhancement`);
      } else if (deg.includes('noise')) {
        console.log(`    → Add bilateral filter or non-local means denoising`);
      } else if (deg.includes('jpeg')) {
        console.log(`    → Add deblocking/JPEG artifact reduction`);
      } else if (deg.includes('rotate') || deg.includes('perspective')) {
        console.log(`    → Improve finder pattern detection for rotated input`);
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════');

  return { total, passed, failed: failed.length, passRate, weaknesses };
}

// Run
runTests().catch(err => {
  console.error('Test harness error:', err);
  process.exit(1);
});

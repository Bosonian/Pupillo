/**
 * Server-side barcode image processing pipeline.
 *
 * Optimized for large Data Matrix ECC 200 symbols (like BMP medication plans)
 * which are ~100-144 modules and contain internal data region subdivisions
 * that look like a grid but are a single symbol.
 */

const sharp = require('sharp');

const MAX_DIMENSION = 4096;
const MAX_UPSCALE_DIM = 3000; // Higher for large Data Matrix

async function validateAndNormalize(imageBuffer) {
  const metadata = await sharp(imageBuffer).metadata();
  const { width, height, format } = metadata;

  if (!width || !height) throw new Error('Cannot read image dimensions');
  if (!['jpeg', 'png', 'webp'].includes(format)) throw new Error(`Unsupported format: ${format}`);

  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    const resized = await sharp(imageBuffer)
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
    return { buffer: resized.data, width: resized.info.width, height: resized.info.height };
  }

  return { buffer: imageBuffer, width, height };
}

/**
 * Generate preprocessing variants. Ordered from most to least likely to help
 * with large dense Data Matrix barcodes captured from phone cameras.
 */
async function generateVariants(imageBuffer) {
  const { buffer, width, height } = await validateAndNormalize(imageBuffer);
  const variants = [];

  // === Priority variants for large Data Matrix (BMP) ===

  // V1: Grayscale + normalize + sharpen — best general-purpose for clean captures
  variants.push({
    name: 'normalize-sharpen',
    buffer: await sharp(buffer).grayscale().normalize().sharpen({ sigma: 2 }).toBuffer()
  });

  // V2: Center crop (60%) + upscale — user likely centered the barcode
  // Critical for large DM: need enough pixels per module
  if (width > 400 && height > 400) {
    const cropW = Math.round(width * 0.6);
    const cropH = Math.round(height * 0.6);
    const left = Math.round((width - cropW) / 2);
    const top = Math.round((height - cropH) / 2);
    const scale = Math.min(3, MAX_UPSCALE_DIM / Math.max(cropW, cropH));
    variants.push({
      name: 'center-crop-60',
      buffer: await sharp(buffer)
        .extract({ left, top, width: cropW, height: cropH })
        .resize(Math.round(cropW * scale), Math.round(cropH * scale), { kernel: 'lanczos3' })
        .grayscale().normalize().sharpen({ sigma: 1.5 })
        .toBuffer()
    });
  }

  // V3: Tighter center crop (40%) + higher upscale — barcode fills more of frame
  if (width > 400 && height > 400) {
    const cropW = Math.round(width * 0.4);
    const cropH = Math.round(height * 0.4);
    const left = Math.round((width - cropW) / 2);
    const top = Math.round((height - cropH) / 2);
    const scale = Math.min(4, MAX_UPSCALE_DIM / Math.max(cropW, cropH));
    variants.push({
      name: 'center-crop-40',
      buffer: await sharp(buffer)
        .extract({ left, top, width: cropW, height: cropH })
        .resize(Math.round(cropW * scale), Math.round(cropH * scale), { kernel: 'lanczos3' })
        .grayscale().normalize().sharpen({ sigma: 2 })
        .toBuffer()
    });
  }

  // V4: Global threshold at 128 — standard binarization
  variants.push({
    name: 'threshold-128',
    buffer: await sharp(buffer).grayscale().normalize().threshold(128).toBuffer()
  });

  // V4b: Full-image upscale for low-res captures (phone far away or heavy downscale)
  // Data Matrix needs ~3+ pixels per module; at 100 modules, that's 300px minimum
  if (width < 600 || height < 600) {
    const scale = Math.min(5, MAX_UPSCALE_DIM / Math.max(width, height));
    if (scale > 1.5) {
      variants.push({
        name: 'full-upscale',
        buffer: await sharp(buffer)
          .resize(Math.round(width * scale), Math.round(height * scale), { kernel: 'lanczos3' })
          .grayscale().normalize().sharpen({ sigma: 2 })
          .toBuffer()
      });
      // Also upscale + threshold
      variants.push({
        name: 'full-upscale-threshold',
        buffer: await sharp(buffer)
          .resize(Math.round(width * scale), Math.round(height * scale), { kernel: 'lanczos3' })
          .grayscale().normalize().threshold(128)
          .toBuffer()
      });
    }
  }

  // V5: Sharpen aggressively + contrast boost — for blurry captures
  variants.push({
    name: 'sharpen-heavy',
    buffer: await sharp(buffer)
      .sharpen({ sigma: 3, m1: 2, m2: 1 })
      .linear(1.8, -(128 * 0.8)) // heavy contrast
      .grayscale()
      .toBuffer()
  });

  // V6: Median filter (denoise) + threshold — for noisy phone cameras
  variants.push({
    name: 'denoise-threshold',
    buffer: await sharp(buffer)
      .grayscale()
      .median(3) // 3x3 median filter removes salt-and-pepper noise
      .normalize()
      .threshold(128)
      .toBuffer()
  });

  // V7: Low threshold — for faded/light printed barcodes
  variants.push({
    name: 'threshold-90',
    buffer: await sharp(buffer).grayscale().normalize().threshold(90).toBuffer()
  });

  // V8: High threshold — for noisy/dirty paper
  variants.push({
    name: 'threshold-170',
    buffer: await sharp(buffer).grayscale().normalize().threshold(170).toBuffer()
  });

  // V9: Center crop + threshold — combined
  if (width > 400 && height > 400) {
    const cropW = Math.round(width * 0.5);
    const cropH = Math.round(height * 0.5);
    const left = Math.round((width - cropW) / 2);
    const top = Math.round((height - cropH) / 2);
    const scale = Math.min(3, MAX_UPSCALE_DIM / Math.max(cropW, cropH));
    variants.push({
      name: 'crop-threshold',
      buffer: await sharp(buffer)
        .extract({ left, top, width: cropW, height: cropH })
        .resize(Math.round(cropW * scale), Math.round(cropH * scale), { kernel: 'lanczos3' })
        .grayscale().normalize().threshold(128)
        .toBuffer()
    });
  }

  // V10: Anti-moiré — for photos taken of screens/monitors
  // Moiré patterns from screen pixel grid interfere with Data Matrix modules.
  // A slight Gaussian blur + resize breaks the moiré frequency, then
  // re-sharpen + threshold recovers the binary pattern.
  variants.push({
    name: 'anti-moire',
    buffer: await sharp(buffer)
      .grayscale()
      .blur(2.0)       // break moiré frequency
      .resize(Math.round(width * 0.8), Math.round(height * 0.8)) // resample
      .resize(width, height, { kernel: 'lanczos3' })             // scale back
      .normalize()
      .threshold(128)
      .toBuffer()
  });

  // V10b: Anti-moiré + median (stronger variant for heavy moiré)
  variants.push({
    name: 'anti-moire-median',
    buffer: await sharp(buffer)
      .grayscale()
      .median(3)        // median filter kills periodic noise
      .blur(1.5)
      .normalize()
      .sharpen({ sigma: 2 })
      .threshold(128)
      .toBuffer()
  });

  // V11: Invert (dark backgrounds)
  variants.push({
    name: 'invert',
    buffer: await sharp(buffer).grayscale().negate().normalize().threshold(128).toBuffer()
  });

  // V11-13: Rotations (in case phone orientation metadata is wrong)
  for (const angle of [90, 180, 270]) {
    variants.push({
      name: `rotate-${angle}`,
      buffer: await sharp(buffer).rotate(angle).grayscale().normalize().threshold(128).toBuffer()
    });
  }

  return variants;
}

async function toPngDataUrl(buffer) {
  const png = await sharp(buffer).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

async function processForDecode(imageBuffer) {
  const variants = await generateVariants(imageBuffer);
  const results = await Promise.all(
    variants.map(async (v) => ({
      name: v.name,
      dataUrl: await toPngDataUrl(v.buffer)
    }))
  );
  return results;
}

async function assessQuality(imageBuffer) {
  const { buffer, width, height } = await validateAndNormalize(imageBuffer);

  const gray = await sharp(buffer)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = gray.data;
  const w = gray.info.width;
  const h = gray.info.height;

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  const startX = Math.floor(w * 0.3);
  const endX = Math.floor(w * 0.7);
  const startY = Math.floor(h * 0.3);
  const endY = Math.floor(h * 0.7);

  for (let y = startY + 1; y < endY - 1; y++) {
    for (let x = startX + 1; x < endX - 1; x++) {
      const idx = y * w + x;
      const lap = 4 * pixels[idx] - pixels[idx - w] - pixels[idx + w] - pixels[idx - 1] - pixels[idx + 1];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }

  if (count === 0) {
    return { sharpness: 0, resolution: 0, overall: 0, width, height };
  }

  const mean = sum / count;
  const variance = Math.max(0, (sumSq / count) - (mean * mean));
  const sharpness = Math.min(100, Math.round(variance / 10));
  const resolution = Math.min(100, Math.round((width * height) / 20000));

  return {
    sharpness,
    resolution,
    overall: Math.round((sharpness * 0.7) + (resolution * 0.3)),
    width,
    height
  };
}

module.exports = { processForDecode, assessQuality, generateVariants };

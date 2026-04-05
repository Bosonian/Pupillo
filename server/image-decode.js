/**
 * Server-side barcode image processing pipeline.
 *
 * When the client-side ZXing decoder fails (bad angle, poor lighting, small code),
 * the phone sends a high-res still frame to the server. The server applies multiple
 * image preprocessing strategies and attempts to decode with each one.
 *
 * Why this works better than client-side alone:
 * - Sharp (libvips) is 10-50x faster than Canvas for image manipulation
 * - We can try many more preprocessing variants in the same time budget
 * - Server has more memory for high-res processing
 * - We can integrate native barcode libs (libdmtx) via child_process if needed
 */

const sharp = require('sharp');

/**
 * Preprocessing pipeline — generates multiple enhanced versions of the input image.
 * Each variant targets a different failure mode:
 *   - Variant 1: Sharpen + high contrast (blurry/out-of-focus captures)
 *   - Variant 2: Adaptive threshold simulation (poor/uneven lighting)
 *   - Variant 3: Grayscale + normalize (washed out / overexposed)
 *   - Variant 4: Invert (dark background barcodes, e.g. on dark packaging)
 *   - Variant 5: Crop center + upscale (small code far from camera)
 *   - Variant 6: Rotate 90/180/270 (orientation issues)
 */
async function generateVariants(imageBuffer) {
  const variants = [];

  const base = sharp(imageBuffer);
  const metadata = await base.metadata();
  const { width, height } = metadata;

  // Variant 1: Sharpen + contrast boost
  variants.push({
    name: 'sharpen-contrast',
    buffer: await sharp(imageBuffer)
      .sharpen({ sigma: 2, m1: 1.5, m2: 0.7 })
      .modulate({ brightness: 1.1 })
      .linear(1.5, -(128 * 0.5)) // contrast boost
      .grayscale()
      .toBuffer()
  });

  // Variant 2: Hard threshold (simulate adaptive binarization)
  variants.push({
    name: 'threshold',
    buffer: await sharp(imageBuffer)
      .grayscale()
      .normalize()
      .threshold(128)
      .toBuffer()
  });

  // Variant 3: Normalize (auto levels)
  variants.push({
    name: 'normalize',
    buffer: await sharp(imageBuffer)
      .grayscale()
      .normalize()
      .sharpen({ sigma: 1.5 })
      .toBuffer()
  });

  // Variant 4: Invert (for codes on dark backgrounds)
  variants.push({
    name: 'invert',
    buffer: await sharp(imageBuffer)
      .grayscale()
      .negate()
      .normalize()
      .threshold(128)
      .toBuffer()
  });

  // Variant 5: Center crop + upscale (user likely centered the barcode)
  if (width > 400 && height > 400) {
    const cropW = Math.round(width * 0.4);
    const cropH = Math.round(height * 0.4);
    const left = Math.round((width - cropW) / 2);
    const top = Math.round((height - cropH) / 2);
    variants.push({
      name: 'center-crop-upscale',
      buffer: await sharp(imageBuffer)
        .extract({ left, top, width: cropW, height: cropH })
        .resize(cropW * 3, cropH * 3, { kernel: 'lanczos3' })
        .grayscale()
        .normalize()
        .sharpen({ sigma: 1.5 })
        .toBuffer()
    });
  }

  // Variant 6: Low threshold (for faint/low-contrast codes)
  variants.push({
    name: 'low-threshold',
    buffer: await sharp(imageBuffer)
      .grayscale()
      .normalize()
      .threshold(90)
      .toBuffer()
  });

  // Variant 7: High threshold (for noisy images)
  variants.push({
    name: 'high-threshold',
    buffer: await sharp(imageBuffer)
      .grayscale()
      .normalize()
      .threshold(170)
      .toBuffer()
  });

  // Rotated variants of the best preprocessing (threshold)
  for (const angle of [90, 180, 270]) {
    variants.push({
      name: `rotate-${angle}`,
      buffer: await sharp(imageBuffer)
        .rotate(angle)
        .grayscale()
        .normalize()
        .threshold(128)
        .toBuffer()
    });
  }

  return variants;
}

/**
 * Convert processed image buffer to a base64 PNG data URL
 * that can be fed back to a client-side ZXing decoder.
 */
async function toPngDataUrl(buffer) {
  const png = await sharp(buffer).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * Main server-side decode pipeline.
 * Returns { variants: [...] } with preprocessed images as base64 PNGs
 * that the client can attempt to decode with ZXing.
 *
 * This hybrid approach (server preprocesses, client decodes) avoids
 * needing a native barcode lib on the server while still getting
 * the benefit of server-side image processing.
 */
async function processForDecode(imageBuffer) {
  const variants = await generateVariants(imageBuffer);

  // Convert all to PNG data URLs for client-side decode attempts
  const results = await Promise.all(
    variants.map(async (v) => ({
      name: v.name,
      dataUrl: await toPngDataUrl(v.buffer)
    }))
  );

  return results;
}

/**
 * Quick quality assessment of a frame.
 * Returns a score 0-100 estimating how decodable the image likely is.
 */
async function assessQuality(imageBuffer) {
  const { width, height } = await sharp(imageBuffer).metadata();

  // Check sharpness via Laplacian variance approximation
  // High variance = sharp image, low = blurry
  const gray = await sharp(imageBuffer)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = gray.data;
  const w = gray.info.width;
  const h = gray.info.height;

  // Laplacian variance (simplified — sample center region)
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
      // Laplacian kernel: center*4 - top - bottom - left - right
      const lap = 4 * pixels[idx] - pixels[idx - w] - pixels[idx + w] - pixels[idx - 1] - pixels[idx + 1];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }

  const mean = sum / count;
  const variance = (sumSq / count) - (mean * mean);

  // Normalize to 0-100 score (empirically, variance > 500 is sharp)
  const sharpness = Math.min(100, Math.round(variance / 10));

  // Resolution score
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

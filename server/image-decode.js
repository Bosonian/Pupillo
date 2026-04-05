/**
 * Server-side barcode image processing pipeline.
 *
 * When the client-side ZXing decoder fails (bad angle, poor lighting, small code),
 * the phone sends a high-res still frame to the server. The server applies multiple
 * image preprocessing strategies and attempts to decode with each one.
 */

const sharp = require('sharp');

const MAX_DIMENSION = 4096;   // Reject images larger than this
const MAX_UPSCALE_DIM = 2048; // Cap upscaled variants

/**
 * Validate and normalize input image. Rejects oversized/corrupt images.
 * Returns { buffer, width, height } or throws.
 */
async function validateAndNormalize(imageBuffer) {
  const metadata = await sharp(imageBuffer).metadata();
  const { width, height, format } = metadata;

  if (!width || !height) throw new Error('Cannot read image dimensions');
  if (!['jpeg', 'png', 'webp'].includes(format)) throw new Error(`Unsupported format: ${format}`);

  // Downscale if too large
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    const resized = await sharp(imageBuffer)
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
    return { buffer: resized.data, width: resized.info.width, height: resized.info.height };
  }

  return { buffer: imageBuffer, width, height };
}

/**
 * Preprocessing pipeline — generates multiple enhanced versions of the input image.
 * Each variant targets a different failure mode.
 */
async function generateVariants(imageBuffer) {
  const { buffer, width, height } = await validateAndNormalize(imageBuffer);
  const variants = [];

  // Variant 1: Sharpen + contrast boost (blurry/out-of-focus)
  variants.push({
    name: 'sharpen-contrast',
    buffer: await sharp(buffer)
      .sharpen({ sigma: 2, m1: 1.5, m2: 0.7 })
      .modulate({ brightness: 1.1 })
      .linear(1.5, -(128 * 0.5))
      .grayscale()
      .toBuffer()
  });

  // Variant 2: Hard threshold (poor/uneven lighting)
  variants.push({
    name: 'threshold',
    buffer: await sharp(buffer).grayscale().normalize().threshold(128).toBuffer()
  });

  // Variant 3: Normalize + sharpen (washed out / overexposed)
  variants.push({
    name: 'normalize',
    buffer: await sharp(buffer).grayscale().normalize().sharpen({ sigma: 1.5 }).toBuffer()
  });

  // Variant 4: Invert (codes on dark backgrounds)
  variants.push({
    name: 'invert',
    buffer: await sharp(buffer).grayscale().negate().normalize().threshold(128).toBuffer()
  });

  // Variant 5: Center crop + upscale (small code far from camera)
  if (width > 400 && height > 400) {
    const cropW = Math.round(width * 0.4);
    const cropH = Math.round(height * 0.4);
    const left = Math.round((width - cropW) / 2);
    const top = Math.round((height - cropH) / 2);
    // Cap upscale to prevent memory blowup
    const scale = Math.min(3, MAX_UPSCALE_DIM / Math.max(cropW, cropH));
    const targetW = Math.round(cropW * scale);
    const targetH = Math.round(cropH * scale);
    variants.push({
      name: 'center-crop-upscale',
      buffer: await sharp(buffer)
        .extract({ left, top, width: cropW, height: cropH })
        .resize(targetW, targetH, { kernel: 'lanczos3' })
        .grayscale().normalize().sharpen({ sigma: 1.5 })
        .toBuffer()
    });
  }

  // Variant 6: Low threshold (faint/low-contrast codes)
  variants.push({
    name: 'low-threshold',
    buffer: await sharp(buffer).grayscale().normalize().threshold(90).toBuffer()
  });

  // Variant 7: High threshold (noisy images)
  variants.push({
    name: 'high-threshold',
    buffer: await sharp(buffer).grayscale().normalize().threshold(170).toBuffer()
  });

  // Rotated variants
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

/**
 * Quick quality assessment of a frame.
 * Returns a score 0-100 estimating how decodable the image likely is.
 */
async function assessQuality(imageBuffer) {
  const { buffer, width, height } = await validateAndNormalize(imageBuffer);

  const gray = await sharp(buffer)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = gray.data;
  const w = gray.info.width;
  const h = gray.info.height;

  // Laplacian variance on center region
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

  // Guard against division by zero (tiny images)
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

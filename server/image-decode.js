/**
 * Server-side barcode image processing pipeline.
 * Optimized for Render free tier (512MB RAM, 0.1 CPU).
 */

const sharp = require('sharp');

const MAX_DIMENSION = 2000;  // Downscale inputs to max 2000px (saves RAM/CPU)
const MAX_UPSCALE_DIM = 2000;

async function validateAndNormalize(imageBuffer) {
  const metadata = await sharp(imageBuffer).metadata();
  const { width, height, format } = metadata;

  if (!width || !height) throw new Error('Cannot read image dimensions');
  if (!['jpeg', 'png', 'webp'].includes(format)) throw new Error(`Unsupported format: ${format}`);

  // Always downscale to save processing time on constrained servers
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    const resized = await sharp(imageBuffer)
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
    return { buffer: resized.data, width: resized.info.width, height: resized.info.height };
  }

  return { buffer: imageBuffer, width, height };
}

/**
 * Generate preprocessing variants — limited to 5 most effective.
 * Ordered by priority: what's most likely to help decode.
 */
async function generateVariants(imageBuffer) {
  const { buffer, width, height } = await validateAndNormalize(imageBuffer);
  const variants = [];

  // V1: Normalize + sharpen — best general-purpose
  variants.push({
    name: 'normalize-sharpen',
    buffer: await sharp(buffer).grayscale().normalize().sharpen({ sigma: 2 }).toBuffer()
  });

  // V2: Threshold — standard binarization
  variants.push({
    name: 'threshold',
    buffer: await sharp(buffer).grayscale().normalize().threshold(128).toBuffer()
  });

  // V3: Center crop (50%) + upscale — barcode likely centered
  if (width > 300 && height > 300) {
    const cropW = Math.round(width * 0.5);
    const cropH = Math.round(height * 0.5);
    const left = Math.round((width - cropW) / 2);
    const top = Math.round((height - cropH) / 2);
    const scale = Math.min(3, MAX_UPSCALE_DIM / Math.max(cropW, cropH));
    variants.push({
      name: 'center-crop',
      buffer: await sharp(buffer)
        .extract({ left, top, width: cropW, height: cropH })
        .resize(Math.round(cropW * scale), Math.round(cropH * scale), { kernel: 'lanczos3' })
        .grayscale().normalize().threshold(128)
        .toBuffer()
    });
  }

  // V4: Denoise + threshold — for noisy phone cameras / moiré
  variants.push({
    name: 'denoise',
    buffer: await sharp(buffer).grayscale().median(3).normalize().threshold(128).toBuffer()
  });

  // V5: Full upscale (for low-res captures only)
  if (width < 600 || height < 600) {
    const scale = Math.min(4, MAX_UPSCALE_DIM / Math.max(width, height));
    if (scale > 1.5) {
      variants.push({
        name: 'upscale',
        buffer: await sharp(buffer)
          .resize(Math.round(width * scale), Math.round(height * scale), { kernel: 'lanczos3' })
          .grayscale().normalize().threshold(128)
          .toBuffer()
      });
    }
  }

  return variants;
}

async function toPngDataUrl(buffer) {
  const png = await sharp(buffer).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

async function processForDecode(imageBuffer) {
  const variants = await generateVariants(imageBuffer);
  // Process sequentially to avoid memory spikes on constrained servers
  const results = [];
  for (const v of variants) {
    results.push({ name: v.name, dataUrl: await toPngDataUrl(v.buffer) });
  }
  return results;
}

async function assessQuality(imageBuffer) {
  const { buffer, width, height } = await validateAndNormalize(imageBuffer);

  // Use a small sample for speed
  const sampleSize = Math.min(width, height, 500);
  const gray = await sharp(buffer)
    .resize(sampleSize, sampleSize, { fit: 'inside' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = gray.data;
  const w = gray.info.width;
  const h = gray.info.height;

  let sum = 0, sumSq = 0, count = 0;
  const startX = Math.floor(w * 0.3), endX = Math.floor(w * 0.7);
  const startY = Math.floor(h * 0.3), endY = Math.floor(h * 0.7);

  for (let y = startY + 1; y < endY - 1; y++) {
    for (let x = startX + 1; x < endX - 1; x++) {
      const idx = y * w + x;
      const lap = 4 * pixels[idx] - pixels[idx - w] - pixels[idx + w] - pixels[idx - 1] - pixels[idx + 1];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }

  if (count === 0) return { sharpness: 0, resolution: 0, overall: 0, width, height };

  const mean = sum / count;
  const variance = Math.max(0, (sumSq / count) - (mean * mean));
  const sharpness = Math.min(100, Math.round(variance / 10));
  const resolution = Math.min(100, Math.round((width * height) / 20000));

  return { sharpness, resolution, overall: Math.round((sharpness * 0.7) + (resolution * 0.3)), width, height };
}

module.exports = { processForDecode, assessQuality, generateVariants };

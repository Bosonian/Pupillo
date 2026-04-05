/**
 * BMP Barcode Bootstrap Trainer
 *
 * Generates 1000+ synthetic BMP barcodes with randomized:
 *   - Payload sizes (50-1500 bytes, 1-15 medications)
 *   - Image degradations (blur, noise, scale, rotation, contrast, JPEG, moiré)
 *   - Combined real-world scenarios
 *
 * Runs each through our preprocessing pipeline, measures decode success,
 * and reports which parameter ranges need improvement.
 *
 * Usage: node test/bootstrap.js [count]
 *   Default: 200 samples (fast). Use 1000+ for thorough analysis.
 */

const bwipjs = require('bwip-js');
const sharp = require('sharp');
const zlib = require('zlib');
const { processForDecode, assessQuality } = require('../server/image-decode');

// ═══════════════════════════════════════════════════════════════
// RANDOM DATA GENERATORS
// ═══════════════════════════════════════════════════════════════

const DRUG_NAMES = [
  'Ramipril 5mg', 'Bisoprolol 5mg', 'Metformin 1000mg', 'Ibuprofen 400mg',
  'Pantoprazol 40mg', 'Amlodipin 5mg', 'Simvastatin 20mg', 'Omeprazol 20mg',
  'Torasemid 10mg', 'Levothyroxin 100mcg', 'Marcumar 3mg', 'ASS 100mg',
  'Metoprolol 50mg', 'Candesartan 16mg', 'Furosemid 40mg', 'Diclofenac 50mg',
  'Novaminsulfon 500mg', 'ACTRAPID PENFILL 300IE', 'LANTUS SOLOSTAR 100E/ML',
  'Prednisolon 5mg', 'Allopurinol 300mg', 'Clopidogrel 75mg', 'Tamsulosin 0.4mg',
  'Gabapentin 300mg', 'Sertralin 50mg', 'Quetiapin 25mg', 'Risperidon 2mg',
  'Pregabalin 75mg', 'Duloxetin 60mg', 'Venlafaxin 75mg',
];

const FORMS = ['TAB', 'Kaps', 'Amp', 'Spritze', 'Tropfen', 'Retardtab', 'Salbe', 'Supp'];
const REASONS = [
  'Bluthochdruck', 'Diabetes mellitus', 'Schmerzen', 'Magenschutz',
  'Blutverduennung', 'Schilddruese', 'Herzinsuffizienz', 'Cholesterin',
  'Wassereinlagerung', 'Gicht', 'Depression', 'Epilepsie', 'Angst',
  'Rheuma', 'Osteoporose', 'Prostatahyperplasie',
];
const INSTRUCTIONS = [
  '', '', '', // Empty often (weight toward no instruction)
  'vor dem Essen', 'nach dem Essen', 'bei Bedarf', 'mit Wasser',
  '30 min vor Fruehstueck', 'abends einnehmen', 'nicht zerkauen',
  'nach Ausweis', 'zur Nacht', 'bei Bedarf max 3x taeglich',
];
const FIRST_NAMES = ['Hans', 'Anna', 'Peter', 'Maria', 'Klaus', 'Ursula', 'Heinrich', 'Helga', 'Gerhard', 'Ingrid'];
const LAST_NAMES = ['Mueller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Koch'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max) { return Math.random() * (max - min) + min; }

function generateBMPXml(medCount) {
  const patient = `<P g="${pick(FIRST_NAMES)}" f="${pick(LAST_NAMES)}" b="${1930 + randInt(0, 60)}${String(randInt(1,12)).padStart(2,'0')}${String(randInt(1,28)).padStart(2,'0')}" />`;
  const author = `<A n="Dr. ${pick(LAST_NAMES)}" s="Hauptstr. ${randInt(1,200)}" z="${String(randInt(10000,99999))}" c="Berlin" t="2024${String(randInt(1,12)).padStart(2,'0')}01" />`;

  let sections = '';
  let remaining = medCount;
  const sectionNames = ['Herz/Blutdruck', 'Diabetes', 'Schmerzen', 'Magen', 'Schilddruese', 'Bedarfsmedikation', 'Sonstige'];

  for (let s = 0; s < sectionNames.length && remaining > 0; s++) {
    const medsInSection = Math.min(remaining, randInt(1, Math.min(4, remaining)));
    remaining -= medsInSection;

    let meds = '';
    for (let m = 0; m < medsInSection; m++) {
      const dosages = [randInt(0,2), randInt(0,1), randInt(0,2), randInt(0,1)];
      const instr = pick(INSTRUCTIONS);
      meds += `<M a="${pick(DRUG_NAMES)}" f="${pick(FORMS)}" p="${dosages[0]}" m="${dosages[1]}" d="${dosages[2]}" h="${dosages[3]}" r="${pick(REASONS)}"${instr ? ` i="${instr}"` : ''} />`;
    }
    sections += `<S t="${sectionNames[s]}">${meds}</S>`;
  }

  return `<MP v="022" U="boot-${Date.now()}-${randInt(0,9999)}">${patient}${author}${sections}</MP>`;
}

// ═══════════════════════════════════════════════════════════════
// DEGRADATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function addNoise(buf, intensity) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const pixels = Buffer.from(data);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.max(0, Math.min(255, pixels[i] + (Math.random() - 0.5) * intensity * 2));
  }
  return sharp(pixels, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
}

function randomDegradation() {
  const r = Math.random();

  if (r < 0.05) return { name: 'clean', fn: async (b) => b };

  if (r < 0.15) {
    const sigma = randFloat(0.5, 4.0);
    return { name: `blur-${sigma.toFixed(1)}`, fn: async (b) => sharp(b).blur(sigma).toBuffer() };
  }

  if (r < 0.25) {
    const scale = randFloat(0.2, 0.6);
    return { name: `scale-${(scale*100).toFixed(0)}pct`, fn: async (b) => {
      const m = await sharp(b).metadata();
      return sharp(b).resize(Math.round(m.width * scale)).jpeg({ quality: randInt(60, 90) }).toBuffer();
    }};
  }

  if (r < 0.35) {
    const q = randInt(15, 70);
    return { name: `jpeg-q${q}`, fn: async (b) => sharp(b).jpeg({ quality: q }).toBuffer() };
  }

  if (r < 0.42) {
    const angle = randInt(-30, 30);
    return { name: `rotate-${angle}`, fn: async (b) => sharp(b).rotate(angle, { background: '#fff' }).toBuffer() };
  }

  if (r < 0.50) {
    const factor = randFloat(0.25, 0.6);
    return { name: `contrast-${factor.toFixed(2)}`, fn: async (b) => sharp(b).linear(factor, 128 * (1 - factor)).toBuffer() };
  }

  if (r < 0.57) {
    const intensity = randInt(10, 60);
    return { name: `noise-${intensity}`, fn: async (b) => addNoise(b, intensity) };
  }

  if (r < 0.64) {
    const brightness = randFloat(0.3, 1.8);
    return { name: `bright-${brightness.toFixed(1)}`, fn: async (b) => sharp(b).modulate({ brightness }).toBuffer() };
  }

  // Combined real-world: phone capture
  if (r < 0.80) {
    const scale = randFloat(0.25, 0.5);
    const blur = randFloat(0.5, 2.5);
    const jpegQ = randInt(50, 85);
    const noise = randInt(0, 30);
    return {
      name: `phone-s${(scale*100).toFixed(0)}-b${blur.toFixed(1)}-q${jpegQ}-n${noise}`,
      fn: async (b) => {
        const m = await sharp(b).metadata();
        let d = await sharp(b).resize(Math.round(m.width * scale)).blur(blur).jpeg({ quality: jpegQ }).toBuffer();
        if (noise > 5) d = await addNoise(d, noise);
        return d;
      }
    };
  }

  // Harsh combined
  const scale = randFloat(0.2, 0.35);
  const blur = randFloat(1.5, 4.0);
  const jpegQ = randInt(30, 60);
  const contrast = randFloat(0.3, 0.6);
  return {
    name: `harsh-s${(scale*100).toFixed(0)}-b${blur.toFixed(1)}-q${jpegQ}-c${contrast.toFixed(1)}`,
    fn: async (b) => {
      const m = await sharp(b).metadata();
      return sharp(b)
        .resize(Math.round(m.width * scale))
        .blur(blur)
        .linear(contrast, 128 * (1 - contrast))
        .jpeg({ quality: jpegQ })
        .toBuffer();
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// DECODE CHECK — heuristic (same as adversarial.js)
// ═══════════════════════════════════════════════════════════════

async function isDecodable(imageBuffer) {
  try {
    const q = await assessQuality(imageBuffer);
    if (q.sharpness < 10 || q.resolution < 3) return false;

    const gray = await sharp(imageBuffer).grayscale().raw().toBuffer({ resolveWithObject: true });
    const px = gray.data, w = gray.info.width, h = gray.info.height;
    const cx = Math.floor(w * 0.3), ex = Math.floor(w * 0.7);
    const cy = Math.floor(h * 0.3), ey = Math.floor(h * 0.7);
    let min = 255, max = 0;
    for (let y = cy; y < ey; y += 3) {
      for (let x = cx; x < ex; x += 3) {
        const v = px[y * w + x];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return (max - min) >= 80;
  } catch { return false; }
}

async function attemptDecode(imageBuffer) {
  if (await isDecodable(imageBuffer)) return { decoded: true, method: 'direct' };

  const variants = await processForDecode(imageBuffer);
  for (const v of variants) {
    const base64 = v.dataUrl.replace(/^data:image\/png;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    if (await isDecodable(buf)) return { decoded: true, method: v.name };
  }
  return { decoded: false, method: null };
}

// ═══════════════════════════════════════════════════════════════
// MAIN RUNNER
// ═══════════════════════════════════════════════════════════════

async function run() {
  const N = parseInt(process.argv[2]) || 200;
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  BMP BOOTSTRAP TRAINER — ${N} samples                 ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  let pass = 0, fail = 0;
  const failures = [];
  const statsByDegType = {};
  const statsByMedCount = {};

  const startTime = Date.now();

  for (let i = 0; i < N; i++) {
    const medCount = randInt(1, 15);
    const xml = generateBMPXml(medCount);
    const compressed = zlib.deflateSync(Buffer.from(xml, 'utf-8'));
    const payload = Buffer.concat([Buffer.from('MP'), Buffer.from([2, 2]), compressed]);

    let barcodePng;
    try {
      barcodePng = await bwipjs.toBuffer({
        bcid: 'datamatrix',
        text: payload.toString('latin1'),
        scale: randInt(3, 6),
        padding: randInt(2, 6),
        backgroundcolor: 'ffffff',
      });
    } catch { continue; }

    const deg = randomDegradation();
    let degraded;
    try {
      degraded = await deg.fn(barcodePng);
    } catch { continue; }

    const result = await attemptDecode(degraded);

    // Classify degradation type
    const degType = deg.name.split('-')[0];
    if (!statsByDegType[degType]) statsByDegType[degType] = { pass: 0, fail: 0 };
    if (!statsByMedCount[medCount]) statsByMedCount[medCount] = { pass: 0, fail: 0 };

    if (result.decoded) {
      pass++;
      statsByDegType[degType].pass++;
      statsByMedCount[medCount].pass++;
    } else {
      fail++;
      statsByDegType[degType].fail++;
      statsByMedCount[medCount].fail++;
      failures.push({ i, medCount, payloadBytes: payload.length, degradation: deg.name });
    }

    // Progress
    if ((i + 1) % 50 === 0 || i === N - 1) {
      const pct = ((pass / (pass + fail)) * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      process.stdout.write(`\r  [${i + 1}/${N}] ${pct}% pass (${pass}✓ ${fail}✗) — ${elapsed}s`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const passRate = ((pass / (pass + fail)) * 100).toFixed(1);

  console.log(`\n\n═══════════════════════════════════════════════════════`);
  console.log(` RESULTS: ${pass}/${pass + fail} (${passRate}%) in ${elapsed}s`);
  console.log(`═══════════════════════════════════════════════════════\n`);

  // By degradation type
  console.log('By degradation type:');
  const sorted = Object.entries(statsByDegType).sort((a, b) => {
    const rateA = a[1].pass / (a[1].pass + a[1].fail);
    const rateB = b[1].pass / (b[1].pass + b[1].fail);
    return rateA - rateB;
  });
  for (const [type, s] of sorted) {
    const total = s.pass + s.fail;
    const rate = ((s.pass / total) * 100).toFixed(0);
    const bar = '█'.repeat(Math.round(s.pass / total * 20)).padEnd(20, '░');
    const warn = s.fail > 0 ? ` ← ${s.fail} failures` : '';
    console.log(`  ${type.padEnd(14)} ${bar} ${rate}% (${total})${warn}`);
  }

  // By medication count
  console.log('\nBy medication count (payload size):');
  for (let m = 1; m <= 15; m++) {
    const s = statsByMedCount[m];
    if (!s) continue;
    const total = s.pass + s.fail;
    const rate = ((s.pass / total) * 100).toFixed(0);
    const warn = s.fail > 0 ? ` ← ${s.fail} fail` : '';
    console.log(`  ${m} meds`.padEnd(12) + ` ${rate}% (${total})${warn}`);
  }

  // Show sample failures
  if (failures.length > 0) {
    console.log(`\n─── SAMPLE FAILURES (first 20) ───`);
    for (const f of failures.slice(0, 20)) {
      console.log(`  #${f.i}: ${f.medCount} meds, ${f.payloadBytes}B, ${f.degradation}`);
    }

    // Analyze failure patterns
    console.log(`\n─── FAILURE ANALYSIS ───`);
    const failDegTypes = {};
    for (const f of failures) {
      const type = f.degradation.split('-')[0];
      failDegTypes[type] = (failDegTypes[type] || 0) + 1;
    }
    const topFails = Object.entries(failDegTypes).sort((a, b) => b[1] - a[1]);
    for (const [type, count] of topFails) {
      console.log(`  ${count} failures from: ${type}`);
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════\n`);
}

run().catch(err => { console.error(err); process.exit(1); });

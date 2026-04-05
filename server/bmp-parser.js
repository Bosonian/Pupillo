/**
 * BMP Parser — Bundeseinheitlicher Medikationsplan (German Medication Plan)
 *
 * BMP barcodes are Data Matrix (often structured append / multi-symbol)
 * containing:
 *   Bytes 0-1: "MP" magic header
 *   Bytes 2-3: Version (major, minor)
 *   Bytes 4+:  zlib-compressed UTF-8 XML
 *
 * The XML contains the full medication plan: patient info, prescribing
 * physician, medication sections with dosages, reasons, and instructions.
 */

const zlib = require('zlib');

/**
 * Detect whether a barcode string is a BMP medication plan.
 * BMP data starts with "MP" followed by binary version bytes.
 */
function isBMP(barcodeString) {
  return typeof barcodeString === 'string' &&
    barcodeString.length >= 6 &&
    barcodeString.startsWith('MP');
}

/**
 * Parse a BMP barcode string into structured medication data.
 *
 * @param {string} barcodeString - Raw string from Data Matrix decoder.
 *   Binary data comes through as Latin-1 characters (byte values mapped
 *   to code points), which is how ZXing handles binary Data Matrix content.
 * @returns {object} Parsed medication plan or error
 */
function parseBMP(barcodeString) {
  try {
    // Convert string back to bytes (Latin-1 preserves byte values)
    const raw = Buffer.from(barcodeString, 'latin1');

    if (raw.length < 6) {
      return { error: 'BMP data too short' };
    }

    // Verify magic header
    if (raw[0] !== 0x4D || raw[1] !== 0x50) { // "MP"
      return { error: 'Not a BMP barcode (missing MP header)' };
    }

    const versionMajor = raw[2];
    const versionMinor = raw[3];
    const version = `${versionMajor}.${versionMinor}`;

    // Decompress the XML payload (zlib format, starts at byte 4)
    const compressed = raw.slice(4);
    let xmlString;

    try {
      const decompressed = zlib.inflateSync(compressed);
      xmlString = decompressed.toString('utf-8');
    } catch (zlibErr) {
      // Some implementations use raw deflate instead of zlib
      try {
        const decompressed = zlib.inflateRawSync(compressed);
        xmlString = decompressed.toString('utf-8');
      } catch {
        return { error: `Decompression failed: ${zlibErr.message}` };
      }
    }

    // Parse the XML
    const plan = parseXML(xmlString);
    plan.bmpVersion = version;
    plan.rawXml = xmlString;

    return plan;
  } catch (err) {
    return { error: `BMP parse error: ${err.message}` };
  }
}

/**
 * Simple XML parser for BMP medication plan.
 * Uses regex-based extraction (no external XML dependency needed)
 * because the BMP XML schema is well-defined and flat.
 */
function parseXML(xml) {
  const plan = {
    type: 'bmp',
    found: true,
    source: 'BMP',
    patient: {},
    author: {},
    sections: [],
  };

  // Parse <MP> root attributes
  const mpMatch = xml.match(/<MP\s+([^>]+)>/);
  if (mpMatch) {
    plan.planVersion = getAttr(mpMatch[1], 'v');
    plan.planUUID = getAttr(mpMatch[1], 'U');
    plan.planLanguage = getAttr(mpMatch[1], 'l');
  }

  // Parse <P> (Patient)
  const pMatch = xml.match(/<P\s+([^>]*)\/?>/);
  if (pMatch) {
    const attrs = pMatch[1];
    plan.patient = {
      givenName: getAttr(attrs, 'g'),
      familyName: getAttr(attrs, 'f'),
      birthDate: formatDate(getAttr(attrs, 'b')),
      title: getAttr(attrs, 't'),
      prefix: getAttr(attrs, 'v'),
      insuranceId: getAttr(attrs, 'egk'),
    };
    // Remove empty fields
    plan.patient = removeEmpty(plan.patient);
  }

  // Parse <A> (Author / Physician)
  const aMatch = xml.match(/<A\s+([^>]*)\/?>/);
  if (aMatch) {
    const attrs = aMatch[1];
    plan.author = {
      name: getAttr(attrs, 'n'),
      street: getAttr(attrs, 's'),
      zip: getAttr(attrs, 'z'),
      city: getAttr(attrs, 'c'),
      phone: getAttr(attrs, 'p'),
      email: getAttr(attrs, 'e'),
      date: getAttr(attrs, 't'),
    };
    plan.author = removeEmpty(plan.author);
  }

  // Parse <S> sections with nested <M> medications
  const sectionRegex = /<S\s+([^>]*)>([\s\S]*?)<\/S>/g;
  let sMatch;
  while ((sMatch = sectionRegex.exec(xml)) !== null) {
    const sectionAttrs = sMatch[1];
    const sectionBody = sMatch[2];

    const section = {
      title: getAttr(sectionAttrs, 't') || getAttr(sectionAttrs, 'c'),
      medications: [],
    };

    // Parse <M> (Medication) entries within this section
    const medRegex = /<M\s+([^>]*)\/?>/g;
    let mMatch;
    while ((mMatch = medRegex.exec(sectionBody)) !== null) {
      const attrs = mMatch[1];
      const med = {
        name: getAttr(attrs, 'a'),
        form: getAttr(attrs, 'f'),
        formText: getAttr(attrs, 't'),
        dosageMorning: getAttr(attrs, 'p'),
        dosageMidday: getAttr(attrs, 'm'),
        dosageEvening: getAttr(attrs, 'd'),
        dosageNight: getAttr(attrs, 'h'),
        unit: getAttr(attrs, 'du'),
        instructions: getAttr(attrs, 'i'),
        reason: getAttr(attrs, 'r'),
        pzn: getAttr(attrs, 'pzn'),
      };
      section.medications.push(removeEmpty(med));
    }

    plan.sections.push(section);
  }

  // Also try self-closing sections: <S ... /> with <M> siblings
  // Some BMP generators put <M> elements outside <S> blocks
  const looseMeds = [];
  const looseMedRegex = /<M\s+([^>]*)\/?>/g;
  let lmMatch;
  // Find <M> elements that are NOT inside <S>...</S>
  const outsideSections = xml.replace(/<S\s+[^>]*>[\s\S]*?<\/S>/g, '');
  while ((lmMatch = looseMedRegex.exec(outsideSections)) !== null) {
    const attrs = lmMatch[1];
    looseMeds.push(removeEmpty({
      name: getAttr(attrs, 'a'),
      form: getAttr(attrs, 'f'),
      dosageMorning: getAttr(attrs, 'p'),
      dosageMidday: getAttr(attrs, 'm'),
      dosageEvening: getAttr(attrs, 'd'),
      dosageNight: getAttr(attrs, 'h'),
      instructions: getAttr(attrs, 'i'),
      reason: getAttr(attrs, 'r'),
      pzn: getAttr(attrs, 'pzn'),
    }));
  }
  if (looseMeds.length > 0) {
    plan.sections.push({ title: 'Medications', medications: looseMeds });
  }

  // Parse <O> (Observations / clinical parameters)
  const obsRegex = /<O\s+([^>]*)\/?>/g;
  const observations = [];
  let oMatch;
  while ((oMatch = obsRegex.exec(xml)) !== null) {
    const attrs = oMatch[1];
    observations.push(removeEmpty({
      parameter: getAttr(attrs, 'ak'),
      value: getAttr(attrs, 'av'),
      unit: getAttr(attrs, 'ae'),
    }));
  }
  if (observations.length > 0) {
    plan.observations = observations;
  }

  // Build a human-readable summary
  plan.name = buildSummary(plan);

  return plan;
}

/**
 * Extract XML attribute value by single-char key.
 * Handles both single and double quotes.
 */
function getAttr(attrString, key) {
  // Match: key="value" or key='value'
  const regex = new RegExp(`(?:^|\\s)${key}=["']([^"']*)["']`);
  const match = attrString.match(regex);
  return match ? decodeXMLEntities(match[1]) : null;
}

function decodeXMLEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function formatDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function removeEmpty(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined && v !== '') result[k] = v;
  }
  return result;
}

function buildSummary(plan) {
  const parts = ['Medikationsplan'];
  if (plan.patient.givenName || plan.patient.familyName) {
    parts[0] = `Medikationsplan: ${[plan.patient.givenName, plan.patient.familyName].filter(Boolean).join(' ')}`;
  }
  const medCount = plan.sections.reduce((sum, s) => sum + s.medications.length, 0);
  if (medCount > 0) {
    parts.push(`${medCount} Medikament${medCount !== 1 ? 'e' : ''}`);
  }
  return parts.join(' — ');
}

module.exports = { isBMP, parseBMP };

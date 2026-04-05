const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const { processForDecode, assessQuality } = require('./image-decode');
const { isBMP, parseBMP } = require('./bmp-parser');

const app = express();
const server = http.createServer(app);
// BMP barcodes can be up to ~7KB (3x Data Matrix structured append)
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

// Parse large JSON bodies (base64 images) — only for the decode endpoint
const jsonParser = express.json({ limit: '10mb' });

// Security headers
app.use((_req, res, next) => {
  res.set({
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; wasm-src 'self' https://cdn.jsdelivr.net blob:;",
  });
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Redirect root to desktop view
app.get('/', (_req, res) => res.redirect('/desktop/'));

// ═══════════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════

const MAX_SESSIONS = 1000;
const MAX_PHONES_PER_SESSION = 5;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes

// Sessions: sessionId -> { token, desktop, phones, createdAt, lastActivity }
const sessions = new Map();

// Clean up stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    const idle = !session.desktop && session.phones.size === 0;
    const expired = (now - session.createdAt) > SESSION_TTL_MS;
    if (idle || expired) {
      // Close any lingering connections
      if (session.desktop) safeSend(session.desktop, null, true);
      for (const phone of session.phones) safeSend(phone, null, true);
      sessions.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Rate limiters (simple in-memory per-IP)
const rateLimits = new Map(); // ip -> { sessionCreates: number, imageDecodes: number, resetAt: number }

function getRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { sessionCreates: 0, imageDecodes: 0, resetAt: now + 60000 };
    rateLimits.set(ip, entry);
  }
  return entry;
}

// Clean rate limit entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(ip);
  }
}, 60000);

// ═══════════════════════════════════════════════════════════════
// REST ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Create a new session — returns sessionId + secret token
app.post('/api/session', (req, res) => {
  // Rate limit: max 10 session creates per minute per IP
  const rl = getRateLimit(req.ip);
  if (rl.sessionCreates >= 10) {
    return res.status(429).json({ error: 'Too many sessions — try again later' });
  }
  rl.sessionCreates++;

  if (sessions.size >= MAX_SESSIONS) {
    return res.status(503).json({ error: 'Server at capacity — try again later' });
  }

  const sessionId = uuidv4();
  const token = crypto.randomBytes(24).toString('base64url');

  sessions.set(sessionId, {
    token,
    desktop: null,
    phones: new Set(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    scanCount: 0,
  });

  res.json({ sessionId, token });
});

// Generate QR code image for a session
app.get('/api/qr/:sessionId/:token', async (req, res) => {
  const { sessionId, token } = req.params;
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host');
  const phoneUrl = `${protocol}://${host}/phone/?session=${sessionId}&token=${token}`;

  try {
    const png = await QRCode.toBuffer(phoneUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' },
    });
    res.type('image/png').send(png);
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// Lookup medicine data from barcode
app.get('/api/medicine/:barcode', (req, res) => {
  const barcode = sanitizeBarcode(req.params.barcode);
  if (!barcode) return res.status(400).json({ error: 'Invalid barcode' });
  res.json(lookupMedicine(barcode));
});

// Server-side image processing for hard-to-decode barcodes
// Concurrency limiter: only N simultaneous image decode operations
let activeImageDecodes = 0;
const MAX_CONCURRENT_DECODES = 3;

app.post('/api/decode-image', jsonParser, async (req, res) => {
  // Rate limit: max 10 image decodes per minute per IP
  const rl = getRateLimit(req.ip);
  if (rl.imageDecodes >= 10) {
    return res.status(429).json({ error: 'Too many requests — try again later' });
  }
  rl.imageDecodes++;

  if (activeImageDecodes >= MAX_CONCURRENT_DECODES) {
    return res.status(503).json({ error: 'Server busy — try again shortly' });
  }

  activeImageDecodes++;
  try {
    const { image } = req.body;
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Strip data URL prefix (support all raster MIME types)
    const base64Data = image.replace(/^data:image\/[^;]+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Validate it's a real raster image by checking magic bytes
    if (!isValidImageBuffer(imageBuffer)) {
      return res.status(400).json({ error: 'Invalid image format' });
    }

    const quality = await assessQuality(imageBuffer);
    const variants = await processForDecode(imageBuffer);

    res.json({ quality, variants });
  } catch (err) {
    console.error('Image decode error:', err);
    res.status(500).json({ error: 'Image processing failed' });
  } finally {
    activeImageDecodes--;
  }
});

function isValidImageBuffer(buf) {
  if (buf.length < 4) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // WebP: RIFF....WEBP
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET HANDLING
// ═══════════════════════════════════════════════════════════════

// Ping/pong keepalive — detect dead connections
const PING_INTERVAL_MS = 30000;
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL_MS);
wss.on('close', () => clearInterval(pingInterval));

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session');
  const role = url.searchParams.get('role');
  const token = url.searchParams.get('token');

  // Validate role
  if (role !== 'desktop' && role !== 'phone') {
    ws.close(4003, 'Invalid role');
    return;
  }

  // Validate session exists
  if (!sessionId || !sessions.has(sessionId)) {
    ws.close(4001, 'Invalid session');
    return;
  }

  const session = sessions.get(sessionId);

  // Validate session token
  if (!token || token !== session.token) {
    ws.close(4002, 'Invalid token');
    return;
  }

  session.lastActivity = Date.now();

  if (role === 'desktop') {
    // Close existing desktop connection gracefully before replacing
    if (session.desktop && session.desktop.readyState <= 1) {
      session.desktop.close(4004, 'Replaced by new desktop connection');
    }
    session.desktop = ws;
    safeSend(ws, { type: 'status', message: 'Waiting for phone to connect...' });
  } else if (role === 'phone') {
    // Cap max phones per session
    if (session.phones.size >= MAX_PHONES_PER_SESSION) {
      ws.close(4005, 'Too many phones connected');
      return;
    }
    session.phones.add(ws);
    if (session.desktop && session.desktop.readyState === 1) {
      safeSend(session.desktop, { type: 'phone-connected', count: session.phones.size });
    }
    safeSend(ws, { type: 'status', message: 'Connected! Start scanning.' });
  }

  // Per-connection scan rate limiter
  let scanBudget = 5;   // max scans per second
  let scanBudgetReset = Date.now() + 1000;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'scan' && role === 'phone') {
      // Rate limit scans
      const now = Date.now();
      if (now > scanBudgetReset) {
        scanBudget = 5;
        scanBudgetReset = now + 1000;
      }
      if (scanBudget <= 0) return;
      scanBudget--;

      // Validate barcode input
      const barcode = sanitizeBarcode(msg.barcode);
      if (!barcode) return;

      const format = sanitizeFormat(msg.format);

      session.lastActivity = now;
      session.scanCount++;

      const medicine = lookupMedicine(barcode);
      const payload = {
        type: 'scan-result',
        barcode,
        format,
        medicine,
        timestamp: new Date().toISOString()
      };

      if (session.desktop && session.desktop.readyState === 1) {
        safeSend(session.desktop, payload);
      }
      safeSend(ws, payload);
    }
  });

  ws.on('close', () => {
    if (role === 'desktop') {
      // Only null out if THIS ws is still the current desktop
      if (session.desktop === ws) {
        session.desktop = null;
      }
    } else if (role === 'phone') {
      session.phones.delete(ws);
      if (session.desktop && session.desktop.readyState === 1) {
        safeSend(session.desktop, { type: 'phone-disconnected', count: session.phones.size });
      }
    }
  });
});

// Safe WebSocket send with error handling
function safeSend(ws, data, doClose = false) {
  try {
    if (doClose) {
      ws.terminate();
      return;
    }
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data), (err) => {
        if (err) console.error('WS send error:', err.message);
      });
    }
  } catch (e) {
    // Connection already gone
  }
}

// ═══════════════════════════════════════════════════════════════
// INPUT VALIDATION
// ═══════════════════════════════════════════════════════════════

function sanitizeBarcode(barcode) {
  if (typeof barcode !== 'string') return null;
  // BMP barcodes can be up to ~7KB; regular barcodes max 256
  const maxLen = isBMP(barcode) ? 8192 : 256;
  if (barcode.length === 0 || barcode.length > maxLen) return null;
  return barcode;
}

const VALID_FORMATS = new Set([
  'Aztec', 'Codabar', 'Code 39', 'Code 93', 'Code 128', 'Data Matrix',
  'EAN-8', 'EAN-13', 'ITF', 'MaxiCode', 'PDF417', 'QR Code',
  'RSS-14', 'RSS Expanded', 'UPC-A', 'UPC-E', 'UPC/EAN',
]);

function sanitizeFormat(format) {
  if (typeof format !== 'string') return 'unknown';
  if (VALID_FORMATS.has(format)) return format;
  // Allow "Format N" pattern from client formatName()
  if (/^Format \d{1,3}$/.test(format)) return format;
  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════
// MEDICINE LOOKUP
// ═══════════════════════════════════════════════════════════════

function lookupMedicine(barcode) {
  // Check for BMP (German Medication Plan) first — this is the primary use case
  if (isBMP(barcode)) {
    return parseBMP(barcode);
  }

  const db = {
    '0363024601': { name: 'Ibuprofen 200mg', manufacturer: 'Walgreens', ndc: '0363-0246-01', form: 'Tablet', strength: '200mg' },
    '3614273547': { name: 'Amoxicillin 500mg', manufacturer: 'Generic Pharma', ndc: '3614-2735-47', form: 'Capsule', strength: '500mg' },
    '0069015501': { name: 'Lipitor 10mg', manufacturer: 'Pfizer', ndc: '0069-0155-01', form: 'Tablet', strength: '10mg' },
    '0078043215': { name: 'Diovan 160mg', manufacturer: 'Novartis', ndc: '0078-0432-15', form: 'Tablet', strength: '160mg' },
    '0006027231': { name: 'Metformin 500mg', manufacturer: 'Merck', ndc: '0006-0272-31', form: 'Tablet', strength: '500mg' },
  };

  if (db[barcode]) {
    return { found: true, ...db[barcode] };
  }

  const gs1 = parseGS1(barcode);
  if (gs1) {
    return { found: true, source: 'GS1', ...gs1 };
  }

  return { found: false, message: 'Not found in demo database.' };
}

// ═══════════════════════════════════════════════════════════════
// GS1 PARSER — Sequential AI parsing with FNC1/GS separator support
// ═══════════════════════════════════════════════════════════════

// Fixed-length AIs (AI code -> data length after the AI code)
const FIXED_LENGTH_AIS = {
  '00': 18, '01': 14, '02': 14,
  '03': 14, '04': 16,
  '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6,
  '20': 2,
};

// Known variable-length AI prefixes (2-4 digit AI code)
const VARIABLE_AIS = ['10', '21', '22', '240', '241', '250', '251', '30', '37'];

function parseGS1(barcode) {
  if (typeof barcode !== 'string' || barcode.length < 4) return null;

  // GS1 uses FNC1 (represented as GS char \x1d, or sometimes ] prefix) as separator
  // Normalize: replace common FNC1 representations
  let str = barcode
    .replace(/\x1d/g, '\x1d')         // keep GS chars
    .replace(/\\x1[dD]/g, '\x1d')     // literal \x1d in string
    .replace(/^\]C1/, '')              // AIM symbology identifier for GS1-128
    .replace(/^\]d2/, '')              // AIM symbology identifier for DataMatrix
    .replace(/^\]e0/, '');             // AIM symbology identifier for GS1 DataBar

  const result = {};
  let hasAny = false;
  let pos = 0;

  while (pos < str.length) {
    // Skip GS separators
    if (str[pos] === '\x1d') { pos++; continue; }

    let matched = false;

    // Try fixed-length AIs first (most important for pharma: 01, 17)
    for (const [ai, len] of Object.entries(FIXED_LENGTH_AIS)) {
      if (str.startsWith(ai, pos)) {
        const dataStart = pos + ai.length;
        const data = str.slice(dataStart, dataStart + len);
        if (data.length === len) {
          setGS1Field(result, ai, data);
          hasAny = true;
          pos = dataStart + len;
          matched = true;
        }
        break;
      }
    }
    if (matched) continue;

    // Try variable-length AIs (terminated by GS separator or end of string)
    for (const ai of VARIABLE_AIS) {
      if (str.startsWith(ai, pos)) {
        const dataStart = pos + ai.length;
        const gsPos = str.indexOf('\x1d', dataStart);
        const dataEnd = gsPos !== -1 ? gsPos : str.length;
        const data = str.slice(dataStart, dataEnd);
        if (data.length > 0 && data.length <= 30) {
          setGS1Field(result, ai, data);
          hasAny = true;
          pos = dataEnd;
          matched = true;
        }
        break;
      }
    }
    if (matched) continue;

    // Unknown AI — skip one character to avoid infinite loop
    pos++;
  }

  return hasAny ? result : null;
}

function setGS1Field(result, ai, data) {
  switch (ai) {
    case '01': result.gtin = data; break;
    case '02': result.contentGtin = data; break;
    case '10': result.lot = data; break;
    case '11': result.productionDate = formatGS1Date(data); break;
    case '17': result.expiry = formatGS1Date(data); break;
    case '21': result.serial = data; break;
    case '30': result.quantity = parseInt(data, 10) || data; break;
    case '240': result.additionalId = data; break;
  }
}

function formatGS1Date(yymmdd) {
  const yy = yymmdd.slice(0, 2);
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  // GS1 spec: day "00" means last day of month
  const dayStr = dd === '00' ? '(end)' : dd;
  return `20${yy}-${mm}-${dayStr}`;
}

// ═══════════════════════════════════════════════════════════════
// SERVER START
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Bind to all interfaces (required by Render/Docker)
server.listen(PORT, HOST, () => {
  console.log(`Pupillo server running on http://${HOST}:${PORT}`);
  console.log(`Desktop view: http://localhost:${PORT}/desktop/`);
  console.log(`Phone scanner: connect via QR code from desktop`);
});

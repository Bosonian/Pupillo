const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Sessions: sessionId -> { desktop: ws|null, phones: Set<ws> }
const sessions = new Map();

// Clean up stale sessions every 5 minutes
setInterval(() => {
  for (const [id, session] of sessions) {
    if (!session.desktop && session.phones.size === 0) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

// REST endpoint: create a new session
app.post('/api/session', (_req, res) => {
  const sessionId = uuidv4();
  sessions.set(sessionId, { desktop: null, phones: new Set() });
  res.json({ sessionId });
});

// REST endpoint: lookup medicine data from barcode
app.get('/api/medicine/:barcode', (req, res) => {
  const data = lookupMedicine(req.params.barcode);
  res.json(data);
});

// WebSocket handling
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session');
  const role = url.searchParams.get('role'); // 'desktop' or 'phone'

  if (!sessionId || !sessions.has(sessionId)) {
    ws.close(4001, 'Invalid session');
    return;
  }

  const session = sessions.get(sessionId);

  if (role === 'desktop') {
    session.desktop = ws;
    ws.send(JSON.stringify({ type: 'status', message: 'Waiting for phone to connect...' }));
  } else if (role === 'phone') {
    session.phones.add(ws);
    // Notify desktop that a phone connected
    if (session.desktop && session.desktop.readyState === 1) {
      session.desktop.send(JSON.stringify({
        type: 'phone-connected',
        count: session.phones.size
      }));
    }
    ws.send(JSON.stringify({ type: 'status', message: 'Connected! Start scanning.' }));
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'scan' && role === 'phone') {
      // Phone scanned a barcode — enrich with medicine data and forward to desktop
      const medicine = lookupMedicine(msg.barcode);
      const payload = JSON.stringify({
        type: 'scan-result',
        barcode: msg.barcode,
        format: msg.format,
        medicine,
        timestamp: new Date().toISOString()
      });

      if (session.desktop && session.desktop.readyState === 1) {
        session.desktop.send(payload);
      }
      // Echo back to phone as confirmation
      ws.send(payload);
    }
  });

  ws.on('close', () => {
    if (role === 'desktop') {
      session.desktop = null;
    } else if (role === 'phone') {
      session.phones.delete(ws);
      if (session.desktop && session.desktop.readyState === 1) {
        session.desktop.send(JSON.stringify({
          type: 'phone-disconnected',
          count: session.phones.size
        }));
      }
    }
  });
});

/**
 * Medicine lookup from barcode.
 * In production, this would query a real drug database (FDA NDC, RxNorm, openFDA, etc.)
 * For now, uses a demo dataset + parses GS1 barcode fields.
 */
function lookupMedicine(barcode) {
  // Demo medicine database (keyed by NDC or UPC)
  const db = {
    '0363024601': { name: 'Ibuprofen 200mg', manufacturer: 'Walgreens', ndc: '0363-0246-01', form: 'Tablet', strength: '200mg' },
    '3614273547': { name: 'Amoxicillin 500mg', manufacturer: 'Generic Pharma', ndc: '3614-2735-47', form: 'Capsule', strength: '500mg' },
    '0069015501': { name: 'Lipitor 10mg', manufacturer: 'Pfizer', ndc: '0069-0155-01', form: 'Tablet', strength: '10mg' },
    '0078043215': { name: 'Diovan 160mg', manufacturer: 'Novartis', ndc: '0078-0432-15', form: 'Tablet', strength: '160mg' },
    '0006027231': { name: 'Metformin 500mg', manufacturer: 'Merck', ndc: '0006-0272-31', form: 'Tablet', strength: '500mg' },
  };

  // Direct match
  if (db[barcode]) {
    return { found: true, ...db[barcode] };
  }

  // Try to parse GS1-128 / GS1 DataMatrix Application Identifiers
  const gs1 = parseGS1(barcode);
  if (gs1) {
    return { found: true, source: 'GS1', ...gs1 };
  }

  return { found: false, rawBarcode: barcode, message: 'Medicine not found in demo database. In production, this would query FDA/openFDA.' };
}

/**
 * Parse GS1 Application Identifiers commonly found on medicine packaging.
 * AI (01) = GTIN, AI (17) = Expiry, AI (10) = Batch/Lot, AI (21) = Serial
 */
function parseGS1(barcode) {
  const result = {};
  let hasAny = false;
  const str = barcode.replace(/[^0-9A-Za-z]/g, '');

  // GTIN — AI 01 (14 digits)
  const gtinMatch = str.match(/01(\d{14})/);
  if (gtinMatch) {
    result.gtin = gtinMatch[1];
    hasAny = true;
  }

  // Expiry — AI 17 (6 digits YYMMDD)
  const expiryMatch = str.match(/17(\d{6})/);
  if (expiryMatch) {
    const raw = expiryMatch[1];
    result.expiry = `20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}`;
    hasAny = true;
  }

  // Batch/Lot — AI 10 (variable length alphanumeric)
  const lotMatch = str.match(/10([A-Za-z0-9]{1,20})/);
  if (lotMatch) {
    result.lot = lotMatch[1];
    hasAny = true;
  }

  // Serial — AI 21 (variable length alphanumeric)
  const serialMatch = str.match(/21([A-Za-z0-9]{1,20})/);
  if (serialMatch) {
    result.serial = serialMatch[1];
    hasAny = true;
  }

  return hasAny ? result : null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Pupillo server running on http://localhost:${PORT}`);
  console.log(`Desktop view: http://localhost:${PORT}/desktop/`);
  console.log(`Phone scanner: connect via QR code from desktop`);
});

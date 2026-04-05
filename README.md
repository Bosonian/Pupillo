# Pupillo — Phone-to-Desktop Medicine Barcode Scanner

Scan medicine barcodes with your phone camera and see the results on your desktop instantly. **No login or account required.**

## How It Works

1. Open the desktop page in your browser
2. A QR code appears — scan it with your phone camera
3. Your phone opens a barcode scanner page (no app install needed)
4. Point the phone at any medicine barcode — the data appears on the desktop in real-time

## Supported Barcode Formats

- **1D**: UPC-A, UPC-E, EAN-8, EAN-13, Code 128, Code 39, Codabar, ITF
- **2D**: QR Code, Data Matrix, PDF417, Aztec
- **GS1**: Parses Application Identifiers (GTIN, expiry, lot, serial)

## Quick Start

```bash
npm install
npm start
```

Then open `http://localhost:3000/desktop/` in your browser.

## Architecture

- **Server**: Node.js + Express + WebSocket (ws)
- **Phone UI**: Browser-based camera scanner using ZXing
- **Desktop UI**: Real-time result display with QR code pairing
- **Pairing**: Session-based UUID — no accounts, no login
- **Transport**: WebSocket for instant barcode data relay

## Production Notes

- Replace the demo medicine database with a real API (openFDA, RxNorm, or your pharmacy system)
- Add HTTPS (required for camera access on mobile in production)
- Consider adding rate limiting and session expiry

/**
 * server.mjs
 * Combined HTTP + WebSocket server.
 *
 * - Serves console.html and meshtastic-webserial.js over HTTP
 * - Bridges serial port ↔ WebSocket at ws://host:PORT/ws
 * - Auto-detects CP210x / CH340 / FTDI serial ports if no --serial given
 * - GET /api/status  → { port, connected, available }
 * - Only one WebSocket client at a time
 *
 * Usage:  node server.mjs [--port 8080] [--serial /dev/ttyUSB0]
 */

import { createServer } from 'http';
import { readFile }     from 'fs/promises';
import { extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const { SerialPort }      = require('serialport');

const __dir = fileURLToPath(new URL('.', import.meta.url));

// ── CLI args ───────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const argVal  = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i+1] ? args[i+1] : d; };
const PORT    = parseInt(argVal('--port', '8080'), 10);
const FORCED  = argVal('--serial', '');   // empty = auto-detect
const BAUD    = 115200;

// Vendor/product substrings that indicate a Meshtastic-compatible bridge
const MESHTASTIC_PATTERNS = [
  'cp210', 'cp2102', 'silicon_labs',
  'ch340', 'ch341',
  'ftdi', 'ft232',
  'heltec', 'meshtastic',
  'tbeam', 'tlora',
];

async function findSerialPort() {
  if (FORCED) return FORCED;
  const ports = await SerialPort.list();
  for (const p of ports) {
    const sig = [p.manufacturer, p.vendorId, p.productId, p.pnpId, p.serialNumber]
      .join(' ').toLowerCase();
    if (MESHTASTIC_PATTERNS.some(pat => sig.includes(pat))) return p.path;
  }
  // Fallback: first ttyUSB or ttyACM
  const fallback = ports.find(p => /ttyUSB|ttyACM|cu\.usb/i.test(p.path));
  return fallback?.path ?? null;
}

// ── MIME ───────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css', '.ico': 'image/x-icon',
};

// ── State ──────────────────────────────────────────────────────────────────────
let serial       = null;
let activeClient = null;
let detectedPort = FORCED || null;

// ── HTTP + API ─────────────────────────────────────────────────────────────────
const http = createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];

  // API: port status
  if (pathname === '/api/status') {
    const available = !!(await findSerialPort().catch(() => null));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      port:       detectedPort,
      connected:  !!activeClient,
      available,
    }));
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/console.html' : pathname;
  const safe = resolve(join(__dir, filePath.replace(/\.\./g, '')));
  if (!safe.startsWith(__dir)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(safe);
    res.writeHead(200, { 'Content-Type': MIME[extname(safe)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

// ── Serial management ──────────────────────────────────────────────────────────
function openSerial(portPath, ws) {
  serial = new SerialPort({ path: portPath, baudRate: BAUD, autoOpen: false });

  serial.open(err => {
    if (err) {
      console.error(`[serial] open failed: ${err.message}`);
      ws.send(JSON.stringify({ type: 'error', message: `Cannot open ${portPath}: ${err.message}` }));
      ws.close();
      serial = null;
      return;
    }
    detectedPort = portPath;
    console.log(`[serial] opened ${portPath} @ ${BAUD}`);
    ws.send(JSON.stringify({ type: 'open', port: portPath }));
  });

  serial.on('data', chunk => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });

  serial.on('error', err => {
    console.error(`[serial] error: ${err.message}`);
    if (ws.readyState === ws.OPEN) ws.close();
  });

  serial.on('close', () => {
    console.log('[serial] closed');
    if (ws.readyState === ws.OPEN) ws.close();
    serial = null;
  });
}

function closeSerial() {
  if (serial?.isOpen) serial.close(() => { serial = null; });
  else serial = null;
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: http, path: '/ws' });

wss.on('connection', async (ws, req) => {
  const client = req.socket.remoteAddress;

  if (activeClient) {
    ws.send(JSON.stringify({ type: 'error', message: 'Radio in use by another client' }));
    ws.close();
    return;
  }

  // Auto-detect port at connection time (device might have just been plugged in)
  const portPath = await findSerialPort().catch(() => null);
  if (!portPath) {
    ws.send(JSON.stringify({ type: 'error', message: 'No serial device found. Is the radio plugged in?' }));
    ws.close();
    return;
  }

  activeClient = ws;
  console.log(`[ws] connected: ${client}  →  ${portPath}`);
  openSerial(portPath, ws);

  ws.on('message', data => {
    if (typeof data === 'string') {
      try { if (JSON.parse(data).type === 'close') ws.close(); } catch {}
    } else if (serial?.isOpen) {
      serial.write(Buffer.from(data), err => {
        if (err) console.error(`[serial] write: ${err.message}`);
      });
    }
  });

  ws.on('close', () => {
    console.log(`[ws] disconnected: ${client}`);
    closeSerial();
    activeClient = null;
  });

  ws.on('error', err => console.error(`[ws] ${client}: ${err.message}`));
});

// ── Start ──────────────────────────────────────────────────────────────────────
http.listen(PORT, '0.0.0.0', async () => {
  const { networkInterfaces } = await import('os');
  const ips = Object.values(networkInterfaces()).flat()
    .filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address);

  detectedPort = await findSerialPort().catch(() => null);

  console.log(`\n⬡  Meshtastic Console`);
  console.log(`   Serial:  ${detectedPort ?? '(not found — will retry on connect)'}`);
  console.log(`   Serving: http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`            http://${ip}:${PORT}`));
  console.log(`   WebSocket: ws://<host>:${PORT}/ws\n`);
});

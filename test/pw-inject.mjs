import { chromium } from 'playwright';
import { _proto, nodeNumToId } from '../meshtastic-webserial.js';

const { fVarint, fLen, fFixed32, concat, encodeVarint, buildFrame } = _proto;

const enc = new TextEncoder();

function fFloat(fieldNum, v) {
  const b = new ArrayBuffer(4);
  new DataView(b).setFloat32(0, v, true);
  return concat(encodeVarint((fieldNum << 3) | 5), new Uint8Array(b));
}
function fFixed32U(fieldNum, v) {
  const b = new ArrayBuffer(4);
  new DataView(b).setUint32(0, v >>> 0, true);
  return concat(encodeVarint((fieldNum << 3) | 5), new Uint8Array(b));
}
function fSFixed32(fieldNum, v) {
  const b = new ArrayBuffer(4);
  new DataView(b).setInt32(0, v, true);
  return concat(encodeVarint((fieldNum << 3) | 5), new Uint8Array(b));
}
function makeUser(id, longName, shortName, hwModel) {
  return concat(
    fLen(1, enc.encode(id)), fLen(2, enc.encode(longName)),
    fLen(3, enc.encode(shortName)), fVarint(5, hwModel),
  );
}
function makePosBytes(latI, lonI, alt) {
  const parts = [fSFixed32(1, latI), fSFixed32(2, lonI)];
  if (alt != null) parts.push(fVarint(3, alt));
  return concat(...parts);
}
function makeDM(batt, voltage, chUtil, airTx, uptime) {
  return concat(
    fVarint(1, batt), fFloat(2, voltage), fFloat(3, chUtil),
    fFloat(4, airTx), fVarint(5, uptime),
  );
}
function nodeInfoFrame(num, user, position, dm, snr, lastHeard, hopsAway, isFavorite) {
  const parts = [fVarint(1, num), fLen(2, user)];
  if (position)         parts.push(fLen(3, position));
  if (snr != null)      parts.push(fFloat(4, snr));
  if (lastHeard)        parts.push(fFixed32U(5, lastHeard));
  if (dm)               parts.push(fLen(6, dm));
  if (hopsAway != null) parts.push(fVarint(9, hopsAway));
  if (isFavorite)       parts.push(fVarint(10, 1));
  return buildFrame(fLen(4, concat(...parts)));
}
function myInfoFrame(num) { return buildFrame(fLen(3, fVarint(1, num))); }
function metaFrame(fw)    { return buildFrame(fLen(13, fLen(1, enc.encode(fw)))); }

const now    = Math.floor(Date.now() / 1000);
const MY_NUM = 0x9ee794e4;

const dataFrames = [
  myInfoFrame(MY_NUM),
  metaFrame('2.7.15.567b8ea'),
  nodeInfoFrame(MY_NUM,
    makeUser('!9ee794e4','Meshtastic 94e4','94e4', 43), null,
    makeDM(101,4.342,2.27,2.34,28265), null, now, undefined, true),
  nodeInfoFrame(0x9ee71364,
    makeUser('!9ee71364','Meshtastic 1364','1364', 43),
    makePosBytes(549715968, -15466496, 0), null, 5.75, now-120, 0, true),
  nodeInfoFrame(0x9e9c0a50,
    makeUser('!9e9c0a50','Longbenton West','r0b', 43),
    makePosBytes(550240256,-15990784,72), makeDM(99,3.9,5.1,1.2,12345),
    -2.0, now-600, 2, true),
  nodeInfoFrame(0xca1e8bd6,
    makeUser('!ca1e8bd6','M1AQY Morpeth','GMCm', 7),
    makePosBytes(551714816,-17137664,78), makeDM(15,3.5,2.6,1.4,23158480),
    5.75, now-3600, 3, false),
  nodeInfoFrame(0xd4814438,
    makeUser('!d4814438','Tesla Low Fell','T3LF', 31),
    makePosBytes(549191680,-15990784,118), null, -14.0, now-7200, 2, false),
  // configComplete delivered AFTER writing, via write-intercept in page
];
const serialised = [...concat(...dataFrames)];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page    = await (await browser.newContext()).newPage();

const jsErrors    = [];
const consoleMsgs = [];
page.on('pageerror', e => jsErrors.push(e.message));
page.on('console',  m => consoleMsgs.push({ t: m.type(), v: m.text() }));

await page.goto('http://localhost:8743/console.html', { waitUntil: 'networkidle' });

await page.evaluate((frameBytes) => {
  const bytes = new Uint8Array(frameBytes);
  const readResolvers = [];
  const readQueue = [];

  function pushChunk(chunk) {
    if (readResolvers.length) readResolvers.shift()({ value: new Uint8Array(chunk), done: false });
    else readQueue.push(new Uint8Array(chunk));
  }

  // Deliver initial data frames in 48-byte chunks
  let offset = 0;
  function drip() {
    if (offset >= bytes.length) return;
    pushChunk(bytes.slice(offset, offset + 48));
    offset += 48;
    setTimeout(drip, 12);
  }

  // Build a configComplete frame in the browser (pure JS, no imports)
  function makeConfigComplete(configId) {
    // field 7, wire type 0: tag = 0x38; then varint(configId)
    const varBytes = [];
    let v = configId >>> 0;
    do {
      let b = v & 0x7F; v >>>= 7;
      if (v) b |= 0x80;
      varBytes.push(b);
    } while (v);
    const payload = [0x38, ...varBytes];
    return new Uint8Array([0x94, 0xC3, (payload.length >> 8) & 0xFF, payload.length & 0xFF, ...payload]);
  }

  const mockPort = {
    async open() { setTimeout(drip, 60); },
    get readable() {
      return { getReader: () => ({
        read: () => readQueue.length
          ? Promise.resolve({ value: readQueue.shift(), done: false })
          : new Promise(r => readResolvers.push(r)),
        releaseLock() {},
        cancel() { readResolvers.forEach(r => r({ value: undefined, done: true })); },
      })};
    },
    get writable() {
      return { getWriter: () => ({
        write: async (data) => {
          // Intercept want_config_id: frame = [0x94,0xC3,0x00,N, 0x18, varint(id)]
          if (data.length >= 6 && data[0] === 0x94 && data[1] === 0xC3 && data[4] === 0x18) {
            let id = 0, shift = 0;
            for (let i = 5; i < data.length; i++) {
              id |= (data[i] & 0x7F) << shift;
              if (!(data[i] & 0x80)) break;
              shift += 7;
            }
            // After all data frames have drained, push configComplete
            setTimeout(() => pushChunk(makeConfigComplete(id >>> 0)), 800);
          }
        },
        close: async () => {},
        releaseLock() {},
      })};
    },
    async close() {},
  };

  Object.defineProperty(navigator, 'serial', {
    value: { requestPort: async () => mockPort }, configurable: true,
  });
}, serialised);

await page.click('#btn');
await page.waitForTimeout(4000);
await page.screenshot({ path: '/tmp/console-populated.png' });

const nodeRows   = await page.$$('tbody tr[id^="r-"]');
const statsTotal = (await page.textContent('#s-total'))?.trim();
const statsGps   = (await page.textContent('#s-gps'))?.trim();
const statsDirect= (await page.textContent('#s-direct'))?.trim();
const btnText    = (await page.textContent('#btn'))?.trim();
const diNid      = (await page.textContent('#di-nid'))?.trim();
const fwText     = (await page.textContent('#di-fw-v'))?.trim();
const logCount   = (await page.$$('.le')).length;
const osmLinks   = (await page.$$('a.poslink')).length;

// Sample all row texts
const rowTexts = [];
for (const row of nodeRows) {
  rowTexts.push((await row.textContent()).replace(/\s+/g,' ').trim().slice(0, 160));
}

// Probe: sort by SNR
await page.click('thead th[data-col="snr"]');
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/console-sorted-snr.png' });
const firstAfterSort = (await (await page.$('tbody tr[id^="r-"]')).textContent())
  .replace(/\s+/g,' ').trim().slice(0,80);

console.log(JSON.stringify({
  nodeRowCount: nodeRows.length,
  statsTotal, statsGps, statsDirect,
  buttonText: btnText,
  deviceNodeId: diNid,
  firmware: fwText,
  logEntryCount: logCount,
  osmLinkCount: osmLinks,
  rows: rowTexts,
  firstAfterSnrSort: firstAfterSort,
  jsErrors,
  consoleErrors: consoleMsgs.filter(l => l.t === 'error'),
}, null, 2));

await browser.close();

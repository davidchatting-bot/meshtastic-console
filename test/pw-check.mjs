import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await page.goto('http://localhost:8080/', { waitUntil: 'networkidle' });

const btnWs  = await page.$('#btn-ws');
const btnUsb = await page.$('#btn');
const btnWsVisible  = await btnWs?.isVisible();
const btnUsbVisible = await btnUsb?.isVisible();
const btnWsText  = await btnWs?.textContent();
const btnUsbText = await btnUsb?.textContent();

// Simulate what a non-Chromium or non-HTTPS user sees
const serialAvail = await page.evaluate(() => 'serial' in navigator);

console.log(JSON.stringify({
  btnWsVisible, btnUsbVisible,
  btnWsText: btnWsText?.trim(),
  btnUsbText: btnUsbText?.trim(),
  serialAvailable: serialAvail,
  errors,
}, null, 2));

// Screenshot of current state
await page.screenshot({ path: '/tmp/console-buttons.png' });
await browser.close();

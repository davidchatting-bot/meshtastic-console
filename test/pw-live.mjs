import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();

const errors = [];
const logs = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => logs.push({ t: m.type(), v: m.text() }));

await page.goto('http://localhost:8080/', { waitUntil: 'networkidle' });

// Click "Connect via Network"
await page.click('#btn-ws');

// Wait up to 15s for the connected state (button becomes "Disconnect")
try {
  await page.waitForFunction(
    () => document.getElementById('btn-ws').textContent === 'Disconnect',
    { timeout: 15000 }
  );
  console.log('CONNECTED OK');
} catch {
  console.log('CONNECT TIMEOUT — button still:', await page.textContent('#btn-ws'));
}

await page.screenshot({ path: '/tmp/console-live.png' });

const rows = await page.$$('tbody tr[id^="r-"]');
const stat = (await page.textContent('#s-total'))?.trim();
const logEntries = (await page.$$('.le')).length;

console.log(JSON.stringify({
  nodeRows: rows.length,
  statTotal: stat,
  logEntries,
  jsErrors: errors,
  consoleErrors: logs.filter(l => l.t === 'error'),
}, null, 2));

await page.waitForTimeout(2000);
await browser.close();

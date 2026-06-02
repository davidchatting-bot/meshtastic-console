import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => errors.push(e.message));

await page.goto('http://localhost:8743/console.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

await page.screenshot({ path: '/tmp/console-initial.png' });

const results = {
  title:              await page.title(),
  h1:                 (await page.textContent('h1'))?.trim(),
  btnText:            (await page.textContent('#btn'))?.trim(),
  statsVisible:       await page.isVisible('#stats'),
  tableVisible:       await page.isVisible('table'),
  logVisible:         await page.isVisible('#log-wrap'),
  emptyNotice:        (await page.textContent('#empty'))?.trim(),
  noWsOverlayHidden:  await page.evaluate(() =>
    getComputedStyle(document.getElementById('no-ws')).display === 'none'
  ),
  connectBtnEnabled:  await page.evaluate(() => !document.getElementById('btn').disabled),
  consoleErrors:      logs.filter(l => l.type === 'error'),
  pageErrors:         errors,
};

console.log(JSON.stringify(results, null, 2));
await browser.close();

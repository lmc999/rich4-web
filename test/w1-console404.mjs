import http from 'node:http';
import { chromium } from '@playwright/test';
const srv = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('content-type','text/html'); res.end('<html><body>hi</body></html>'); return; }
  if (req.url === '/x401') { res.statusCode = 401; res.setHeader('content-type','application/json'); res.end('{"ok":false}'); return; }
  res.statusCode = 404; res.setHeader('content-type','application/json'); res.end('{"ok":false}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const msgs = [];
page.on('console', (m) => msgs.push(`${m.type()}: ${m.text()}`));
await page.goto(`http://127.0.0.1:${port}/`);
await page.evaluate(async () => { await fetch('/pack/manifest.json'); await fetch('/x401'); });
await page.waitForTimeout(300);
console.log(JSON.stringify(msgs, null, 1));
await browser.close();
srv.close();

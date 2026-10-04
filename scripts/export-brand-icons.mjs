import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const browser = await playwright.chromium.launch({ headless:true, channel:'chrome' });
try {
  const page = await browser.newPage();
  const source = await readFile(join(root, 'public/favicon.svg'));
  const icons = await page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const icons = [];
    for (const size of [16,32,180]) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image,0,0,size,size);
      icons.push([size,canvas.toDataURL('image/png').split(',')[1]]);
    }
    return icons;
  }, 'data:image/svg+xml;base64,'+source.toString('base64'));
  for (const [size,base64] of icons) await writeFile(join(root,'public',size===180?'apple-touch-icon.png':`favicon-${size}.png`),Buffer.from(base64,'base64'));
} finally { await browser.close(); }

// Render desktop/build/icon.svg to PNGs at every size electron-builder wants.
//
// Deliberately uses headless Chromium rather than ImageMagick or Pillow: a
// browser is the one renderer guaranteed to agree with how the SVG looks in
// the app itself, and it is one fewer native dependency to install. Run with
// `npm run icons` from desktop/ after editing the SVG.
//
// electron-builder converts the 1024px PNG to .icns and .ico at package time,
// so no platform-specific icon tooling is needed here.
const { chromium } = require(process.env.PLAYWRIGHT_CORE ||
  '/opt/node22/lib/node_modules/playwright/node_modules/playwright-core');
const fs = require('fs'), path = require('path');
const SRC = path.join(__dirname, '..', 'desktop', 'build', 'icon.svg');
const OUT = path.join(__dirname, '..', 'desktop', 'build');
const SIZES = [1024, 512, 256, 128, 64, 48, 32, 16];
(async () => {
  const svg = fs.readFileSync(SRC, 'utf8');
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  for (const size of SIZES) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(
      `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>` +
      svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`),
      { waitUntil: 'load' });
    const file = size === 1024 ? path.join(OUT, 'icon.png') : path.join(OUT, `icons/${size}x${size}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await p.screenshot({ path: file, omitBackground: true });
    await p.close();
    console.log(`${file}  ${fs.statSync(file).size} bytes`);
  }
  await b.close();
})();

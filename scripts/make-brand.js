'use strict';

// Rasterise the brand icon into the full favicon / PNG export set.
//   assets/brand/png/icon-<size>.png   (16 … 1024)
//   assets/brand/favicon.ico           (16/32/48)
//   assets/brand/apple-touch-icon.png  (180, on solid bg for iOS)
// Run with: npm run brand

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const pngToIcoMod = require('png-to-ico');
const pngToIco = pngToIcoMod.default || pngToIcoMod;

const BRAND = path.join(__dirname, '..', 'assets', 'brand');
const PNGDIR = path.join(BRAND, 'png');
fs.mkdirSync(PNGDIR, { recursive: true });

const iconSvg = fs.readFileSync(path.join(BRAND, 'mashhad-icon.svg'));
const faviconSvg = fs.readFileSync(path.join(BRAND, 'mashhad-favicon.svg'));

function render(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
}

async function main() {
  const sizes = [16, 32, 48, 64, 128, 180, 256, 512, 1024];
  for (const s of sizes) {
    fs.writeFileSync(path.join(PNGDIR, `icon-${s}.png`), render(iconSvg, s));
  }

  // Favicon .ico — use the simplified favicon glyph at small sizes for legibility.
  const ico = await pngToIco([16, 32, 48].map((s) => render(faviconSvg, s)));
  fs.writeFileSync(path.join(BRAND, 'favicon.ico'), ico);

  // Apple touch icon (iOS renders on a rounded solid tile).
  fs.writeFileSync(path.join(BRAND, 'apple-touch-icon.png'), render(iconSvg, 180));

  console.log('Wrote assets/brand/png/*.png, favicon.ico, apple-touch-icon.png');
}

main().catch((e) => { console.error(e); process.exit(1); });

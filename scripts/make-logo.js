'use strict';

// Render build/logo.svg to PNGs using the bundled Thmanyah brand fonts.
// resvg can't read woff2, so we decompress to TTF and detect the real family
// names, then rasterise.
//   build/logo.png          — light wordmark (for dark backgrounds, the app theme)
//   build/logo-onlight.png  — dark wordmark (for light backgrounds)
// Run with: npm run logo

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { decompress } = require('wawoff2');
const fontkit = require('fontkit');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const FONTS = path.join(ROOT, 'assets', 'fonts');

async function loadTtf(woff2Name) {
  const ttf = Buffer.from(await decompress(fs.readFileSync(path.join(FONTS, woff2Name))));
  return { buffer: ttf, family: fontkit.create(ttf).familyName };
}

async function main() {
  const black = await loadTtf('thmanyahsans-Black.woff2');
  console.log('Family:', black.family);

  const base = fs.readFileSync(path.join(BUILD, 'logo.svg'), 'utf8')
    .replaceAll('__SANS_BLACK__', black.family);

  const fontBuffers = [black.buffer];

  function render(svg, outName) {
    const r = new Resvg(svg, {
      fitTo: { mode: 'width', value: 1480 },
      font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: black.family },
    });
    fs.writeFileSync(path.join(BUILD, outName), r.render().asPng());
    console.log('Wrote build/' + outName);
  }

  render(base, 'logo.png');

  const onLight = base
    .replace('fill="#F8FAFC"', 'fill="#0B0F14"')
    .replace('fill="#94A3B8"', 'fill="#475569"');
  render(onLight, 'logo-onlight.png');
}

main().catch((e) => { console.error(e); process.exit(1); });

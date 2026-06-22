'use strict';

// Rasterise build/icon.svg into the assets electron-builder needs:
//   build/icon.png  (1024² — used for Linux, and electron-builder derives .icns)
//   build/icon.ico  (multi-size — Windows)
// Run with: npm run icons

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const pngToIcoMod = require('png-to-ico');
const pngToIco = pngToIcoMod.default || pngToIcoMod;

const BUILD = path.join(__dirname, '..', 'build');
const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'));

function render(size) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return r.render().asPng();
}

async function main() {
  fs.writeFileSync(path.join(BUILD, 'icon.png'), render(1024));

  // .ico from a set of standard sizes.
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const ico = await pngToIco(icoSizes.map((s) => render(s)));
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico);

  console.log('Wrote build/icon.png (1024) and build/icon.ico');
}

main().catch((e) => { console.error(e); process.exit(1); });

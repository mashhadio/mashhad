'use strict';

// Render the social-share card used by og:image / twitter:image.
//   site/og.png   1200×630
// Run with: npm run og
//
// The Thmanyah brand faces only ship as .woff2, which resvg can't read, so they're
// decompressed to TTF in a temp dir first (wawoff2 is already a devDependency for
// the same reason elsewhere). Arabic shaping is handled by resvg's rustybuzz.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const wawoff = require('wawoff2');

const ROOT = path.join(__dirname, '..');
const FONTS = path.join(ROOT, 'site', 'fonts');
const OUT = path.join(ROOT, 'site', 'og.png');

const FACES = [
  'thmanyahsans-Regular',
  'thmanyahsans-Medium',
  'thmanyahsans-Bold',
  'thmanyahsans-Black',
  'thmanyahserifdisplay-Bold',
  'thmanyahserifdisplay-Black'
];

// Palette lifted from site/site.css so the card can't drift from the site.
const PAPER = '#F5F7F9';
const CARD = '#FFFFFF';
const INK = '#1A2530';
const INK_SOFT = '#556575';
const LINE = '#D6DEE6';
const GOLD = '#2C3E50';
const RED = '#E23B2E';
const PANEL = '#E7ECF1';

function svg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${PAPER}"/>
      <stop offset="1" stop-color="${PANEL}"/>
    </linearGradient>
    <clipPath id="stageClip"><rect x="96" y="188" width="360" height="254" rx="18"/></clipPath>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="10" fill="${GOLD}"/>

  <!-- ================= right column (RTL primary) ================= -->

  <!-- brand mark -->
  <g transform="translate(1032,64)">
    <rect x="0" y="0" width="104" height="104" rx="26" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>
    <rect x="18" y="26" width="68" height="58" rx="17" fill="${INK}"/>
    <path d="M44 42 L44 68 L68 55 Z" fill="#A9B6C4"/>
    <circle cx="76" cy="34" r="10" fill="${RED}"/>
  </g>

  <text x="1010" y="146" text-anchor="end" direction="rtl"
        font-family="Thmanyah Serif Display" font-weight="900" font-size="96" fill="${INK}">مشهد</text>

  <text x="1136" y="238" text-anchor="end" direction="rtl"
        font-family="Thmanyah Sans" font-weight="700" font-size="42" fill="${INK}">تسجيل الشاشة بتكبير سلس</text>
  <text x="1136" y="296" text-anchor="end" direction="rtl"
        font-family="Thmanyah Sans" font-weight="700" font-size="42" fill="${GOLD}">يتتبّع المؤشر</text>

  <text x="1136" y="362" text-anchor="end" direction="rtl"
        font-family="Thmanyah Sans" font-weight="400" font-size="27" fill="${INK_SOFT}">تنقية لضوضاء الميكروفون، كاميرا بخلفية</text>
  <!-- No trailing "." on this line: resvg shapes RTL runs but doesn't reorder a
       trailing neutral, so the period lands on the wrong edge of the line. -->
  <text x="1136" y="402" text-anchor="end" direction="rtl"
        font-family="Thmanyah Sans" font-weight="400" font-size="27" fill="${INK_SOFT}">قابلة للتمويه، ومحرّر استوديو عربيّ</text>

  <!-- platform chips -->
  <g>
    <rect x="1016" y="446" width="120" height="46" rx="14" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>
    <text x="1076" y="477" text-anchor="middle" direction="rtl"
          font-family="Thmanyah Sans" font-weight="500" font-size="22" fill="${INK}">ويندوز</text>

    <rect x="922" y="446" width="84" height="46" rx="14" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>
    <text x="964" y="477" text-anchor="middle" direction="rtl"
          font-family="Thmanyah Sans" font-weight="500" font-size="22" fill="${INK}">ماك</text>

    <rect x="812" y="446" width="100" height="46" rx="14" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>
    <text x="862" y="477" text-anchor="middle" direction="rtl"
          font-family="Thmanyah Sans" font-weight="500" font-size="22" fill="${INK}">لينكس</text>

    <rect x="676" y="446" width="126" height="46" rx="14" fill="${GOLD}"/>
    <text x="739" y="477" text-anchor="middle" direction="rtl"
          font-family="Thmanyah Sans" font-weight="700" font-size="22" fill="#FFFFFF">مجّاني</text>
  </g>

  <text x="1136" y="562" text-anchor="end"
        font-family="Thmanyah Sans" font-weight="700" font-size="26" fill="${GOLD}">mashhad.io</text>

  <!-- ================= left column: app window ================= -->

  <g>
    <rect x="72" y="120" width="408" height="350" rx="22" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>
    <rect x="72" y="120" width="408" height="46" rx="22" fill="${PANEL}"/>
    <rect x="72" y="150" width="408" height="16" fill="${PANEL}"/>
    <circle cx="104" cy="143" r="7" fill="${RED}"/>
    <circle cx="128" cy="143" r="7" fill="#E8B93B"/>
    <circle cx="152" cy="143" r="7" fill="#3FAE6B"/>

    <!-- captured stage -->
    <rect x="96" y="188" width="360" height="254" rx="18" fill="#0E131C"/>
    <g clip-path="url(#stageClip)">
      <rect x="126" y="216" width="180" height="12" rx="6" fill="#26324a"/>
      <rect x="126" y="244" width="248" height="12" rx="6" fill="#26324a"/>
      <rect x="126" y="272" width="140" height="12" rx="6" fill="#26324a"/>
      <rect x="126" y="300" width="212" height="12" rx="6" fill="#26324a"/>

      <!-- zoom ring following the cursor -->
      <circle cx="300" cy="330" r="74" fill="none" stroke="${RED}" stroke-width="3" stroke-dasharray="10 8" opacity=".85"/>
      <circle cx="300" cy="330" r="46" fill="none" stroke="#43B8C8" stroke-width="2" opacity=".7"/>
      <path d="M292 306 L292 350 L303 339 L311 356 L318 353 L310 336 L328 336 Z"
            fill="#FFFFFF" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>

      <!-- camera bubble -->
      <circle cx="404" cy="392" r="34" fill="#161D2A" stroke="#43B8C8" stroke-width="2"/>
      <circle cx="404" cy="382" r="11" fill="#8b98ad"/>
      <path d="M386 412c0-10 8-16 18-16s18 6 18 16Z" fill="#8b98ad"/>
    </g>

    <!-- recording pill -->
    <rect x="272" y="196" width="164" height="34" rx="17" fill="rgba(226,59,46,.14)" stroke="${RED}" stroke-width="1.5"/>
    <circle cx="418" cy="213" r="6" fill="${RED}"/>
    <text x="400" y="220" text-anchor="end" direction="rtl"
          font-family="Thmanyah Sans" font-weight="500" font-size="17" fill="#FF6A5E">جارٍ التسجيل</text>
  </g>

  <!-- timeline strip under the window -->
  <g>
    <rect x="72" y="486" width="408" height="58" rx="16" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>
    <rect x="92" y="506" width="72" height="18" rx="6" fill="${PANEL}"/>
    <rect x="170" y="506" width="52" height="18" rx="6" fill="${GOLD}"/>
    <rect x="228" y="506" width="88" height="18" rx="6" fill="${PANEL}"/>
    <rect x="322" y="506" width="48" height="18" rx="6" fill="${GOLD}"/>
    <rect x="376" y="506" width="84" height="18" rx="6" fill="${PANEL}"/>
    <rect x="264" y="496" width="3" height="38" rx="1.5" fill="${RED}"/>
  </g>
</svg>`;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mashhad-og-'));
  const fontFiles = [];
  for (const face of FACES) {
    const woff2 = fs.readFileSync(path.join(FONTS, `${face}.woff2`));
    const ttf = Buffer.from(await wawoff.decompress(woff2));
    const dest = path.join(tmp, `${face}.ttf`);
    fs.writeFileSync(dest, ttf);
    fontFiles.push(dest);
  }

  const png = new Resvg(svg(), {
    fitTo: { mode: 'width', value: 1200 },
    font: { fontFiles, loadSystemFonts: true, defaultFontFamily: 'Thmanyah Sans' }
  }).render().asPng();

  fs.writeFileSync(OUT, png);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Wrote site/og.png (${(png.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

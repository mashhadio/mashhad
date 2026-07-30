'use strict';

// Swap node_modules/ffmpeg-static/ffmpeg to a specific architecture before packaging.
//
// ffmpeg-static downloads a binary for the HOST arch at install time, and its install.js
// skips the download entirely when a binary is already present. So building the arm64
// .dmg on an Intel Mac (or vice versa) would silently ship the wrong ffmpeg — the app
// packages fine and then fails to export on the user's machine.
//
// Passing npm_config_arch through `npm rebuild` does NOT work: npm >= 11 strips unknown
// env configs ("Unknown env config \"arch\""). Running install.js directly does.
//
//   node scripts/ffmpeg-arch.js arm64

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const arch = process.argv[2];
if (!['x64', 'arm64'].includes(arch)) {
  console.error('usage: node scripts/ffmpeg-arch.js <x64|arm64>');
  process.exit(1);
}

const pkgDir = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static');
fs.rmSync(path.join(pkgDir, 'ffmpeg'), { force: true }); // force the re-download
execFileSync(process.execPath, [path.join(pkgDir, 'install.js')], {
  stdio: 'inherit',
  env: { ...process.env, npm_config_arch: arch },
});
console.log(`ffmpeg-static: ${arch} binary in place`);

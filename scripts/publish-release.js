'use strict';

// Publish the built installers + electron-updater metadata to the PUBLIC
// `mashhad-releases` GitLab project's generic Package Registry, so the app's
// auto-updater (and Homebrew) can fetch them without any credential.
//
// It uploads every update-relevant file in dist/ to TWO slots:
//   - `latest`   : the fixed feed the app points at (package.json build.publish url).
//                  electron-updater reads  .../generic/mashhad/latest/latest.yml
//                  (or latest-linux.yml) and pulls the installer next to it.
//   - `<version>`: a version-pinned copy (used by the Homebrew cask's url + sha256).
//
// Run locally for Windows (no Windows CI runner):  npm run dist:win && npm run publish:win
// Run in CI for Linux (see .gitlab-ci.yml) after:  npm run dist:linux
//
// Requires env RELEASES_TOKEN — a GitLab token (Project/Group Access Token or PAT)
// with `api` scope and write access to the releases project. Optional env
// RELEASES_PROJECT overrides the default `abdu.medhat94/mashhad-releases`.

const https = require('https');
const fs = require('fs');
const path = require('path');

const version = require('../package.json').version;
const token = process.env.RELEASES_TOKEN;
const projectPath = process.env.RELEASES_PROJECT || 'abdu.medhat94/mashhad-releases';

if (!token) {
  console.error('RELEASES_TOKEN is required (a GitLab token with api scope + write to the releases project).');
  process.exit(1);
}

const base = `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectPath)}/packages/generic/mashhad`;
const distDir = path.join(__dirname, '..', 'dist');

// The installers and blockmaps to serve, plus the electron-updater channel files.
const INSTALLER = /\.(exe|AppImage|deb|dmg|zip)$/i;
const BLOCKMAP = /\.blockmap$/i;
const CHANNEL = /^latest(-linux|-mac)?\.yml$/i;

function putFile(uploadUrl, filePath) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    const u = new URL(uploadUrl);
    const req = https.request(
      {
        method: 'PUT',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/octet-stream', 'Content-Length': size },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
          else reject(new Error(`HTTP ${res.statusCode} — ${body.slice(0, 300)}`));
        });
      }
    );
    req.on('error', reject);
    fs.createReadStream(filePath).pipe(req);
  });
}

(async () => {
  if (!fs.existsSync(distDir)) { console.error('dist/ not found — build an installer first.'); process.exit(1); }
  const files = fs.readdirSync(distDir).filter((f) => INSTALLER.test(f) || BLOCKMAP.test(f) || CHANNEL.test(f));
  if (!files.length) { console.error('No publishable artifacts in dist/ (need an installer + latest*.yml).'); process.exit(1); }

  console.log(`Publishing ${files.length} file(s) for v${version} to ${projectPath}:`);
  for (const f of files) {
    const fp = path.join(distDir, f);
    for (const slot of ['latest', version]) {
      const url = `${base}/${slot}/${encodeURIComponent(f)}?status=default`;
      process.stdout.write(`  ↑ ${f}  →  ${slot}  ... `);
      // eslint-disable-next-line no-await-in-loop
      await putFile(url, fp);
      console.log('ok');
    }
  }
  console.log(`\nDone. Update feed: ${base}/latest/latest.yml`);
  console.log(`Version-pinned (for Homebrew): ${base}/${version}/<file>`);
})().catch((e) => {
  console.error('\nPublish failed:', e.message);
  process.exit(1);
});

/**
 * Verifies electron/acquire.cjs actually fetches and extracts a working
 * SkyRoads install, independent of Electron's UI.
 *
 *   node tools/verify-acquire.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadOfficialRelease } = require('../electron/acquire.cjs');

async function main() {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyroads-acquire-'));
  console.log(`Extracting to ${destDir}\n`);

  try {
    await downloadOfficialRelease(destDir, (status) => console.log(status));
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exit(1);
  }

  const entries = fs.readdirSync(destDir);
  const roadsPath = path.join(destDir, entries.find((n) => n.toLowerCase() === 'roads.lzs'));
  const roadsSize = fs.statSync(roadsPath).size;

  console.log(`\nExtracted ${entries.length} files.`);
  console.log(`ROADS.LZS: ${roadsSize} bytes ${roadsSize === 17102 ? '(matches known-good size)' : '(!!)'}`);

  fs.rmSync(destDir, { recursive: true, force: true });
  process.exit(roadsSize === 17102 ? 0 : 1);
}

main();

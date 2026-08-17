/**
 * Verifies electron/server.cjs's routing without needing to click through
 * Electron's native folder-picker dialog, which nothing here can automate.
 *
 *   node tools/verify-electron-server.cjs
 *
 * Builds a throwaway dist/ and a throwaway "tester's SkyRoads folder"
 * containing a real ROADS.LZS, starts the server, and checks:
 *   - /assets/original/ROADS.LZS resolves to the tester's folder, byte-exact
 *   - /assets/original/NOPE.TXT 404s for real (not the SPA index.html
 *     fallback vite preview's default server gives every unmatched path --
 *     see the note in main.ts about that)
 *   - an unrelated unknown path still gets the SPA fallback, so a direct
 *     load of any in-game route still boots the game
 *   - before a data folder is chosen (dataDir: null), every
 *     /assets/original/* request 404s cleanly instead of throwing
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../electron/server.cjs');

const ROADS_SRC = path.join(__dirname, '..', 'assets', 'original', 'ROADS.LZS');

function makeTempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `skyroads-${name}-`));
}

async function main() {
  if (!fs.existsSync(ROADS_SRC)) {
    console.log('SKIP: assets/original/ROADS.LZS not present locally -- nothing to copy for the test.');
    return;
  }

  const distDir = makeTempDir('dist');
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>fake app</title>');

  const dataDir = makeTempDir('data');
  fs.copyFileSync(ROADS_SRC, path.join(dataDir, 'ROADS.LZS'));
  const expectedBytes = fs.readFileSync(ROADS_SRC);

  let failures = 0;
  const check = (label, cond) => {
    console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
    if (!cond) failures++;
  };

  // --- Before any data folder is chosen ---------------------------------
  const { server: unconfigured } = createServer({ distDir, dataDir: null });
  await new Promise((resolve) => unconfigured.listen(0, resolve));
  const unconfiguredPort = unconfigured.address().port;

  const preSelectRes = await fetch(`http://localhost:${unconfiguredPort}/assets/original/ROADS.LZS`);
  check('404s before a data folder is chosen', preSelectRes.status === 404);
  await new Promise((resolve) => unconfigured.close(resolve));

  // --- With a data folder configured -------------------------------------
  const { server } = createServer({ distDir, dataDir });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  const roadsRes = await fetch(`${base}/assets/original/ROADS.LZS`);
  const roadsBytes = Buffer.from(await roadsRes.arrayBuffer());
  check('ROADS.LZS resolves with 200', roadsRes.status === 200);
  check('ROADS.LZS bytes match the real file exactly', roadsBytes.equals(expectedBytes));

  const missingRes = await fetch(`${base}/assets/original/NOPE.TXT`);
  check('a genuinely missing data file 404s for real', missingRes.status === 404);
  const missingBody = await missingRes.text();
  check(
    'the 404 is a real one, not the SPA index.html fallback',
    !missingBody.includes('<title>fake app</title>'),
  );

  const spaRes = await fetch(`${base}/some/unknown/game/route`);
  const spaBody = await spaRes.text();
  check('an unrelated unknown path still gets the SPA fallback', spaBody.includes('<title>fake app</title>'));

  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

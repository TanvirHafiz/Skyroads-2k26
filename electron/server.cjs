/**
 * The local HTTP server the Electron shell serves the game from.
 *
 * Split into its own module, independent of any Electron API, so it can be
 * exercised with a plain Node script -- there is no way to drive Electron's
 * native folder-picker dialog from an automated test, but the server's
 * routing (does /assets/original/* really resolve to the tester's own
 * folder? does a missing file 404 for real, rather than falling through to
 * the SPA's index.html the way `vite preview`'s default behaviour does?) is
 * exactly the part worth being sure of.
 *
 * Routes:
 *   /assets/original/*   -> the tester's own SkyRoads folder (chosen at
 *                            first run, never bundled into the app -- see
 *                            docs/RESEARCH.md on the licence's redistribution
 *                            restriction)
 *   everything else       -> the built dist/ (game code, bundled music/,
 *                            bundled assets/custom/), with SPA fallback so
 *                            a direct load of any path still boots the game
 *
 * CommonJS (.cjs) rather than the project's usual ESM, because this runs in
 * Electron's main process outside Vite's module pipeline.
 */

const http = require('node:http');
const sirv = require('sirv');

const ORIGINAL_PREFIX = '/assets/original';

/**
 * @param {object} opts
 * @param {string} opts.distDir - the built game (npm run build output)
 * @param {string|null} opts.dataDir - the tester's own SkyRoads folder, or
 *   null if not yet chosen -- every /assets/original/* request 404s until it is
 */
function createServer({ distDir, dataDir }) {
  const appServe = sirv(distDir, { single: true });
  let dataServe = dataDir ? sirv(dataDir, { single: false }) : null;

  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith(ORIGINAL_PREFIX)) {
      if (!dataServe) {
        res.statusCode = 404;
        res.end('No SkyRoads data folder selected yet');
        return;
      }
      // sirv roots requests at its own base dir, so the prefix has to come off
      // before handing the request to it -- otherwise it looks for a literal
      // "assets/original" subfolder inside the tester's chosen directory.
      req.url = req.url.slice(ORIGINAL_PREFIX.length) || '/';
      dataServe(req, res, () => {
        res.statusCode = 404;
        res.end('Not found in the selected SkyRoads folder');
      });
      return;
    }
    appServe(req, res);
  });

  return {
    server,
    /** Repoints /assets/original/* at a newly chosen folder, no restart needed. */
    setDataDir(newDataDir) {
      dataServe = newDataDir ? sirv(newDataDir, { single: false }) : null;
    },
  };
}

module.exports = { createServer, ORIGINAL_PREFIX };

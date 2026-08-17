/**
 * Electron shell for SkyRoads HD.
 *
 * Ships the game's own code and bundled content (dist/, music/,
 * assets/custom/) inside the app. Never ships BlueMoon's original SkyRoads
 * data -- the licence's "single unit, intact, original form" redistribution
 * clause forbids repackaging it (see docs/RESEARCH.md). On first run, the
 * tester picks one of:
 *   - Download & Play: fetches the complete, untouched official freeware
 *     zip from archive.org and extracts it whole (electron/acquire.cjs) --
 *     this is redistribution of the release exactly as the licence permits,
 *     just automated instead of manual.
 *   - I already have a copy: the original manual folder picker.
 * Either way the chosen/downloaded path is remembered, and the local server
 * (electron/server.cjs) maps /assets/original/* to wherever that data
 * actually lives on disk -- nothing is ever copied into the app itself.
 */

const { app, BrowserWindow, dialog, Menu, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('./server.cjs');
const { downloadOfficialRelease } = require('./acquire.cjs');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const DOWNLOADED_DATA_DIR = () => path.join(app.getPath('userData'), 'skyroads-data');
const LOG_PATH = () => path.join(app.getPath('userData'), 'main.log');

/**
 * File-based logging, not just console.log: a packaged portable exe's
 * launcher self-extracts and re-execs a detached child process, so the
 * child's stdout/stderr isn't reachable through the launcher we ran --
 * console output alone leaves no trace to debug a crash from. This is also
 * the only diagnostic a real tester could ever hand back to us.
 */
function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH()), { recursive: true });
    fs.appendFileSync(LOG_PATH(), stamped + '\n');
  } catch {
    // Logging must never be the thing that crashes the app.
  }
}

process.on('uncaughtException', (err) => {
  log(`FATAL uncaughtException: ${err.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  log(`FATAL unhandledRejection: ${reason instanceof Error ? reason.stack : reason}`);
});

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2));
}

/** True when `dir` looks like a real SkyRoads install, case-insensitively. */
function looksLikeSkyRoadsFolder(dir) {
  try {
    const names = fs.readdirSync(dir).map((n) => n.toLowerCase());
    return names.includes('roads.lzs');
  } catch {
    return false;
  }
}

let serverHandle = null;
let mainWindow = null;

function promptForOwnFolder(parentWindow) {
  const result = dialog.showOpenDialogSync(parentWindow, {
    title: 'Select your SkyRoads folder (must contain ROADS.LZS)',
    properties: ['openDirectory'],
  });
  if (!result || result.length === 0) return null;

  const chosen = result[0];
  if (!looksLikeSkyRoadsFolder(chosen)) {
    dialog.showErrorBox(
      'Not a SkyRoads folder',
      `"${chosen}" doesn't contain ROADS.LZS. Point this at the folder holding your copy of the original game.`,
    );
    return promptForOwnFolder(parentWindow);
  }
  return chosen;
}

const PROGRESS_HTML = (status) => `<!doctype html><meta charset="utf-8">
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#05070d;
  color:#cfe3ff;font-family:ui-monospace,Menlo,monospace;font-size:14px;letter-spacing:.05em">
  <div id="status">${status}</div>
</body>`;

function setProgress(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void mainWindow.webContents
    .executeJavaScript(`document.getElementById('status').textContent = ${JSON.stringify(status)};`)
    .catch(() => {}); // window may already have navigated on
}

/**
 * Resolves which SkyRoads folder to serve, prompting the tester if nothing
 * usable is already known. Returns null only if they cancelled outright.
 */
async function resolveDataDir(parentWindow) {
  const envOverride = process.env.SKYROADS_DATA_DIR;
  if (envOverride && looksLikeSkyRoadsFolder(envOverride)) return envOverride; // test/automation only

  const configured = readConfig().dataDir;
  if (configured && looksLikeSkyRoadsFolder(configured)) return configured;

  if (process.env.SKYROADS_AUTO_DOWNLOAD === '1') {
    const dest = DOWNLOADED_DATA_DIR();
    log(`auto-download: extracting to ${dest}`);
    await downloadOfficialRelease(dest, (s) => log(`auto-download: ${s}`));
    writeConfig({ ...readConfig(), dataDir: dest });
    log('auto-download: done');
    return dest;
  }

  const choice = dialog.showMessageBoxSync(parentWindow, {
    type: 'question',
    title: 'SkyRoads HD needs the original game data',
    message: 'How would you like to set up your SkyRoads data?',
    detail:
      'SkyRoads HD reads its levels, music and art from the original 1993 freeware release. ' +
      'This app never ships that data itself -- pick one:',
    buttons: ['Download & Play (recommended)', 'I already have a copy...', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  });

  if (choice === 2) return null;

  if (choice === 0) {
    const dest = DOWNLOADED_DATA_DIR();
    await mainWindow.loadURL(`data:text/html,${encodeURIComponent(PROGRESS_HTML('Starting download...'))}`);
    try {
      await downloadOfficialRelease(dest, setProgress);
    } catch (err) {
      dialog.showErrorBox(
        'Download failed',
        `Could not fetch the official release from archive.org: ${err.message}\n\n` +
          `Check your internet connection and try again, or choose "I already have a copy" instead.`,
      );
      return resolveDataDir(parentWindow);
    }
    writeConfig({ ...readConfig(), dataDir: dest });
    return dest;
  }

  // choice === 1: browse for an existing copy
  const chosen = promptForOwnFolder(parentWindow);
  if (!chosen) return resolveDataDir(parentWindow); // they cancelled the sub-dialog; ask again
  writeConfig({ ...readConfig(), dataDir: chosen });
  return chosen;
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Change SkyRoads Data Folder...',
          click: async () => {
            const chosen = promptForOwnFolder(mainWindow);
            if (chosen) {
              writeConfig({ ...readConfig(), dataDir: chosen });
              serverHandle?.setDataDir(chosen);
              mainWindow?.webContents.reload();
            }
          },
        },
        {
          label: 'Re-download Official Release...',
          click: async () => {
            const dest = DOWNLOADED_DATA_DIR();
            await mainWindow.loadURL(
              `data:text/html,${encodeURIComponent(PROGRESS_HTML('Re-downloading...'))}`,
            );
            try {
              await downloadOfficialRelease(dest, setProgress);
              writeConfig({ ...readConfig(), dataDir: dest });
              serverHandle?.setDataDir(dest);
            } catch (err) {
              dialog.showErrorBox('Download failed', err.message);
            }
            mainWindow?.webContents.reload();
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function main() {
  log(`starting, version ${app.getVersion()}, log at ${LOG_PATH()}`);
  await app.whenReady();
  log('app ready');

  if (!fs.existsSync(DIST_DIR)) {
    dialog.showErrorBox(
      'Build missing',
      `dist/ was not found next to the app. Run "npm run build" before packaging or launching Electron.`,
    );
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'SkyRoads HD',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  log('window created');
  buildMenu();

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`FATAL renderer process gone: ${JSON.stringify(details)}`);
  });

  // External links (e.g. anything opened via target=_blank) go to the
  // system browser rather than spawning inside the game's own window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const dataDir = await resolveDataDir(mainWindow);
  log(`dataDir resolved: ${dataDir ?? '(none)'}`);

  const { server, setDataDir } = createServer({ distDir: DIST_DIR, dataDir });
  serverHandle = { setDataDir };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  log(`serving on 127.0.0.1:${port}`);

  app.on('before-quit', () => server.close());

  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  log('initial page load complete');
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

main().catch((err) => {
  log(`FATAL main() failed: ${err.stack || err}`);
});

/**
 * Fetches the ORIGINAL, UNMODIFIED SkyRoads freeware release and extracts it
 * locally -- this is what "Download & Play" does on first launch, as an
 * alternative to the tester manually pointing at a copy they already have.
 *
 * Why this is legally distinct from bundling the data in our own installer:
 * BlueMoon's licence explicitly permits distributing SkyRoads "freely, as
 * long as ... this program must be distributed as a single unit, with all
 * accompanying files included and intact in their original form." That's
 * exactly what this does -- it fetches the complete, untouched zip from
 * archive.org (the same freeware release this project's own README already
 * points testers at) and extracts it whole. Nothing here modifies, splits,
 * or repackages the release; we never embed BlueMoon's files in the app we
 * ship, we just automate the "go get your own copy" step. See
 * docs/RESEARCH.md section 1 for the full licence text and analysis.
 */

const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

const RELEASE_URL = 'https://archive.org/download/SkyRoads/skyroads.zip';
/** From the archive.org item's own metadata; a sanity check against a corrupt/short download. */
const EXPECTED_MIN_BYTES = 500_000;

/**
 * @param {string} destDir - where to extract the release; created if missing
 * @param {(status: string) => void} [onProgress] - UI feedback hook
 * @returns {Promise<string>} destDir, once ROADS.LZS is confirmed present
 */
async function downloadOfficialRelease(destDir, onProgress = () => {}) {
  onProgress(`Downloading the official freeware release from archive.org...`);
  const res = await fetch(RELEASE_URL);
  if (!res.ok) {
    throw new Error(`archive.org returned ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < EXPECTED_MIN_BYTES) {
    throw new Error(
      `Downloaded file is only ${buffer.length} bytes -- expected at least ${EXPECTED_MIN_BYTES}. ` +
        `The download may have been interrupted or archive.org's response changed.`,
    );
  }

  onProgress('Extracting...');
  fs.mkdirSync(destDir, { recursive: true });
  const zip = new AdmZip(buffer);
  zip.extractAllTo(destDir, true);

  const entries = fs.readdirSync(destDir);
  const hasRoads = entries.some((n) => n.toLowerCase() === 'roads.lzs');
  if (!hasRoads) {
    throw new Error(
      `Extracted files don't include ROADS.LZS. Found: ${entries.join(', ') || '(nothing)'}`,
    );
  }

  onProgress('Ready.');
  return destDir;
}

module.exports = { downloadOfficialRelease, RELEASE_URL, EXPECTED_MIN_BYTES };

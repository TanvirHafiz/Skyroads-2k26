/**
 * Decodes a SkyRoads image to PNG so it can be eyeballed.
 *
 *   npx tsx tools/dump-image.ts WORLD0            -- one file
 *   npx tsx tools/dump-image.ts                   -- every WORLD file
 *
 * PNGs are written next to the tool's output directory. This is the
 * verification instrument for the image parser: a wrong palette offset or a
 * broken decompress shows up instantly as noise.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { parseImage, toRgba, type SkyImage } from '../src/data/image.js';

const OUT_DIR = 'assets/decoded';

// --- Minimal PNG encoder -----------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  // Each scanline is prefixed with filter type 0 (none).
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }

  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr.set([0, 0, 0], 10);

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// --- Main --------------------------------------------------------------------
function decode(name: string): SkyImage {
  const file = new Uint8Array(readFileSync(`assets/original/${name}.LZS`));
  const image = parseImage(file);
  const png = encodePng(image.width, image.height, toRgba(image));
  writeFileSync(`${OUT_DIR}/${name}.png`, png);
  console.log(
    `${name.padEnd(10)} ${image.width}x${image.height}  ` +
      `${image.paletteCount} colours  -> ${OUT_DIR}/${name}.png`,
  );
  return image;
}

mkdirSync(OUT_DIR, { recursive: true });
const arg = process.argv[2];
if (arg) {
  decode(arg.toUpperCase());
} else {
  for (let i = 0; i < 10; i++) decode(`WORLD${i}`);
}

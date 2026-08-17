/**
 * Diagnostic: measure how bits are actually used in the road cell words,
 * so the bitfield layout is derived from the data rather than assumed.
 */

import { readFileSync } from 'node:fs';
import { decompressLzs } from '../src/data/lzs.js';

const file = new Uint8Array(readFileSync('assets/original/ROADS.LZS'));
const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
const entryCount = view.getUint16(0, true) / 4;

const bitCounts = new Array(16).fill(0);
const valueHist = new Map<number, number>();
let total = 0;

for (let i = 0; i < entryCount; i++) {
  const offset = view.getUint16(i * 4, true);
  const size = view.getUint16(i * 4 + 2, true);
  const { data } = decompressLzs(file.subarray(offset + 222), size);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let c = 0; c + 1 < data.length; c += 2) {
    const raw = dv.getUint16(c, true);
    total++;
    valueHist.set(raw, (valueHist.get(raw) ?? 0) + 1);
    for (let b = 0; b < 16; b++) if (raw & (1 << b)) bitCounts[b]++;
  }
}

console.log(`Total cells: ${total}\n`);
console.log('bit   set count   % of cells');
for (let b = 15; b >= 0; b--) {
  console.log(
    String(b).padStart(3) + String(bitCounts[b]).padStart(12) +
      ((bitCounts[b] / total) * 100).toFixed(2).padStart(11) + '%',
  );
}

console.log('\nMost common raw values:');
const top = [...valueHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
for (const [v, n] of top) {
  console.log(
    `  0x${v.toString(16).padStart(4, '0')}  ${v.toString(2).padStart(16, '0')}  ` +
      `${String(n).padStart(6)}  (${((n / total) * 100).toFixed(2)}%)`,
  );
}
console.log(`\nDistinct values: ${valueHist.size}`);

/**
 * Diagnostic for DEMO.REC's structure.
 *
 * If bytes are per-tick input, runs of equal bytes should be long (a held key
 * lasts many ticks at 36 Hz) and the run-length histogram should look like
 * human input. If it is run-length encoded or sampled, the shape will differ.
 */

import { readFileSync } from 'node:fs';

const file = new Uint8Array(readFileSync('assets/original/DEMO.REC'));
console.log(`DEMO.REC: ${file.length} bytes, first byte 0x${file[0]!.toString(16)}\n`);

const body = file.subarray(1);

// --- Run-length structure ----------------------------------------------------
interface Run {
  value: number;
  length: number;
  start: number;
}
const runs: Run[] = [];
let start = 0;
for (let i = 1; i <= body.length; i++) {
  if (i === body.length || body[i] !== body[start]) {
    runs.push({ value: body[start]!, length: i - start, start });
    start = i;
  }
}

console.log(`Runs: ${runs.length} (mean length ${(body.length / runs.length).toFixed(2)})`);

const lenHist = new Map<number, number>();
for (const r of runs) lenHist.set(r.length, (lenHist.get(r.length) ?? 0) + 1);
console.log('\nRun-length histogram (length: count):');
[...lenHist.entries()]
  .sort((a, b) => a[0] - b[0])
  .slice(0, 20)
  .forEach(([len, n]) => console.log(`  ${String(len).padStart(4)}: ${n}`));
const maxRun = Math.max(...runs.map((r) => r.length));
console.log(`  longest run: ${maxRun}`);

console.log('\nFirst 30 runs (value, length, startTick):');
for (const r of runs.slice(0, 30)) {
  console.log(
    `  0x${r.value.toString(16).padStart(2, '0')} (${r.value.toString(2).padStart(5, '0')})` +
      ` x${String(r.length).padStart(4)}  @${r.start}`,
  );
}

// --- Does the jump bit look like a key hold? --------------------------------
let jumpRuns = 0;
let inJump = false;
let jumpTicks = 0;
for (const b of body) {
  const j = (b & 0x10) !== 0;
  if (j) jumpTicks++;
  if (j && !inJump) jumpRuns++;
  inJump = j;
}
console.log(`\nJump bit: ${jumpTicks} ticks across ${jumpRuns} presses`);
console.log(`  mean hold ${(jumpTicks / jumpRuns).toFixed(1)} ticks`);

// --- Axis activity -----------------------------------------------------------
for (const [name, shift] of [
  ['bits 0-1 (axis A)', 0],
  ['bits 2-3 (axis B)', 2],
] as const) {
  const counts = [0, 0, 0, 0];
  let presses = 0;
  let prev = 1;
  for (const b of body) {
    const v = (b >> shift) & 3;
    counts[v]!++;
    if (v !== 1 && prev === 1) presses++;
    prev = v;
  }
  console.log(
    `\n${name}: 0=${counts[0]} 1=${counts[1]} 2=${counts[2]} 3=${counts[3]}` +
      `  (${presses} distinct presses, mean hold ` +
      `${((counts[0]! + counts[2]!) / presses).toFixed(1)} ticks)`,
  );
}

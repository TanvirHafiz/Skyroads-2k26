/**
 * Dumps the structure of MUZAX.LZS so the parser can be verified without audio.
 *
 *   npx tsx tools/dump-music.ts
 */

import { readFileSync } from 'node:fs';
import { parseMuzax, MUSIC_TICK_HZ, WaveType, noteToFrequency } from '../src/data/muzax.js';

const songs = parseMuzax(new Uint8Array(readFileSync('assets/original/MUZAX.LZS')));

console.log(`MUZAX.LZS: ${songs.length} songs\n`);
console.log('idx  instr  commands  notes  duration   loops');

for (const song of songs) {
  let ticks = 0;
  let notes = 0;
  let loops = 0;
  for (const c of song.commands) {
    if (c.type === 0) ticks += c.value;
    if (c.type === 2) notes++;
    if (c.type === 5) loops++;
  }
  const seconds = ticks / MUSIC_TICK_HZ;
  console.log(
    String(song.index).padStart(3) +
      String(song.instruments.length).padStart(7) +
      String(song.commands.length).padStart(10) +
      String(notes).padStart(7) +
      `${seconds.toFixed(1)}s`.padStart(10) +
      String(loops).padStart(8),
  );
}

// Spot-check song 1's instruments and opening notes.
const song = songs[1] ?? songs[0]!;
console.log(`\nSong ${song.index} instruments:`);
song.instruments.slice(0, 6).forEach((ins, i) => {
  console.log(
    `  ${i}: ${ins.additive ? 'AM' : 'FM'} fb=${ins.feedback}` +
      `  A[wave=${WaveType[ins.a.waveForm]} mul=${ins.a.multiplication} ` +
      `lvl=${ins.a.outputLevel.toFixed(1)}dB adsr=${ins.a.attackRate}/${ins.a.decayRate}/` +
      `${ins.a.sustainLevel.toFixed(0)}/${ins.a.releaseRate}]` +
      `  B[wave=${WaveType[ins.b.waveForm]} mul=${ins.b.multiplication} ` +
      `lvl=${ins.b.outputLevel.toFixed(1)}dB]`,
  );
});

console.log(`\nSong ${song.index} first 18 commands:`);
const NAMES = ['pause', 'setInstr', 'playNote', 'stopNote', 'volume', 'jump', 'mark', 'nop'];
for (const c of song.commands.slice(0, 18)) {
  const extra =
    c.type === 2 ? `  (${noteToFrequency(c.value).toFixed(1)} Hz)` : c.type === 0 ? '  ticks' : '';
  console.log(`  ch${c.channel} ${NAMES[c.type]!.padEnd(9)} ${String(c.value).padStart(4)}${extra}`);
}

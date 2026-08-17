/**
 * One-off check that a supplied MIDI file parses cleanly and reports
 * sane structure -- run before wiring any file up as default game audio.
 *
 *   npx tsx tools/check-midi.ts music/96653.mid
 */

import { readFileSync } from 'node:fs';
import { parseMidi } from '../src/data/midi.js';

const path = process.argv[2];
if (!path) throw new Error('usage: check-midi.ts <path>');

const bytes = new Uint8Array(readFileSync(path));
const song = parseMidi(bytes);

const onEvents = song.events.filter((e) => e.type === 'on');
const offEvents = song.events.filter((e) => e.type === 'off');
const programEvents = song.events.filter((e) => e.type === 'program');
const channels = new Set(song.events.map((e) => e.channel));
const programs = new Set(programEvents.map((e) => e.program));
const noteRange = onEvents.reduce(
  (r, e) => ({ min: Math.min(r.min, e.note!), max: Math.max(r.max, e.note!) }),
  { min: 127, max: 0 },
);

console.log(
  JSON.stringify(
    {
      totalEvents: song.events.length,
      noteOn: onEvents.length,
      noteOff: offEvents.length,
      programChanges: programEvents.length,
      channelsUsed: [...channels].sort((a, b) => a - b),
      gmProgramsUsed: [...programs].sort((a, b) => (a ?? 0) - (b ?? 0)),
      noteRange,
      durationSec: song.durationSec,
      durationMinSec: `${Math.floor(song.durationSec / 60)}:${String(Math.round(song.durationSec % 60)).padStart(2, '0')}`,
    },
    null,
    1,
  ),
);

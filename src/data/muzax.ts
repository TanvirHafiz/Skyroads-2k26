/**
 * MUZAX.LZS -- the game's music.
 *
 * Not a raw OPL register dump. It is a compact command stream driving an
 * OPL2-style 2-operator FM synth, with the instrument definitions stored
 * inline at the head of each song.
 *
 * Song table at the top of the file, 6 bytes per song:
 *   u16 dataOffset          byte offset of this song's compressed block
 *   u16 instrumentCount     instruments stored at the head of the block
 *   u16 decompressedLength
 *
 * The table runs until the first song's dataOffset, giving 20 slots -- but
 * only the first 14 are populated; the rest are zero padding, so entries are
 * read until a zero offset.
 *
 * Decompressed block:
 *   instrumentCount * 16 bytes of instrument definitions, then the command
 *   stream, which is a sequence of (low, high) byte pairs:
 *
 *     functionType = low & 7
 *     channel      = low >> 4
 *
 *     0  pause for `high` ticks (ticks run at 200 Hz)
 *     1  stop note, then configure channel with instrument `high`
 *     2  play note `high` on channel  (note = high % 12, octave = high/12 + 2)
 *     3  stop note on channel
 *     4  set channel volume from `high & 0x3F`
 *     5  jump to the saved position
 *     6  save the current position
 *     7  no-op
 *
 * Ported from the MIT-licensed OpenRoads reference (Src/Music/MusicPlayer.ts).
 */

import { decompressLzs } from './lzs.js';

/** The command stream advances at 200 Hz (a 5 ms tick in the original). */
export const MUSIC_TICK_HZ = 200;

export enum WaveType {
  Sine,
  HalfSine,
  AbsSine,
  PulseSine,
  SineEven,
  AbsSineEven,
  Square,
  DerivedSquare,
}

/** One FM operator's settings. Levels are in dB, rates are 0-15. */
export interface Operator {
  tremolo: boolean;
  vibrato: boolean;
  soundSustaining: boolean;
  keyScaling: boolean;
  multiplication: number;
  keyScaleLevel: number;
  /** 0 dB (loudest) down to -47.25 dB. */
  outputLevel: number;
  attackRate: number;
  decayRate: number;
  /** 0 dB down to -45 dB. */
  sustainLevel: number;
  releaseRate: number;
  waveForm: WaveType;
}

export interface Instrument {
  a: Operator;
  b: Operator;
  /** True for additive (AM) output, false for FM. */
  additive: boolean;
  feedback: number;
}

export interface Command {
  type: number;
  channel: number;
  value: number;
}

export interface Song {
  index: number;
  instruments: Instrument[];
  commands: Command[];
}

function readOperator(data: Uint8Array, offset: number): Operator {
  const tremolo = data[offset] ?? 0;
  const keyScaleLevel = data[offset + 1] ?? 0;
  const attack = data[offset + 2] ?? 0;
  const sustain = data[offset + 3] ?? 0;
  const wave = data[offset + 4] ?? 0;

  return {
    tremolo: (tremolo & 0x80) > 0,
    vibrato: (tremolo & 0x40) > 0,
    soundSustaining: (tremolo & 0x20) > 0,
    keyScaling: (tremolo & 0x10) > 0,
    multiplication: tremolo & 0x0f,
    keyScaleLevel: keyScaleLevel >> 6,
    outputLevel: ((keyScaleLevel & 0x3f) / 0x3f) * -47.25,
    attackRate: attack >> 4,
    decayRate: attack & 0x0f,
    sustainLevel: (-45.0 * (sustain >> 4)) / 0x0f,
    releaseRate: sustain & 0x0f,
    waveForm: (wave & 7) as WaveType,
  };
}

export function parseMuzax(file: Uint8Array): Song[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const firstOffset = view.getUint16(0, true);
  const songCount = Math.floor(firstOffset / 6);
  if (songCount < 1 || songCount > 64) {
    throw new Error(`MUZAX: implausible song count ${songCount}`);
  }

  const songs: Song[] = [];
  for (let i = 0; i < songCount; i++) {
    const dataOffset = view.getUint16(i * 6, true);
    const instrumentCount = view.getUint16(i * 6 + 2, true);
    const length = view.getUint16(i * 6 + 4, true);

    // The table has 20 slots but the game ships 14 songs; the tail is zeroed.
    if (dataOffset === 0 || length === 0) break;

    const { data } = decompressLzs(file.subarray(dataOffset), length);

    const instruments: Instrument[] = [];
    for (let n = 0; n < instrumentCount; n++) {
      const o = n * 16;
      const channelConfig = data[o + 10] ?? 0;
      instruments.push({
        a: readOperator(data, o),
        b: readOperator(data, o + 5),
        additive: (channelConfig & 1) > 0,
        feedback: (channelConfig & 14) >> 1,
      });
    }

    const commands: Command[] = [];
    for (let p = instrumentCount * 16; p + 1 < data.length; p += 2) {
      const low = data[p]!;
      commands.push({ type: low & 7, channel: low >> 4, value: data[p + 1]! });
    }

    songs.push({ index: i, instruments, commands });
  }

  return songs;
}

/**
 * OPL2 F-numbers for the twelve semitones, and the block (octave) they pair
 * with. Frequency = fnum * 49716 / 2^(20 - block).
 */
const F_NUMBERS = [0xac, 0xb6, 0xc1, 0xcd, 0xd9, 0xe6, 0xf3, 0x102, 0x111, 0x122, 0x133, 0x145];

export function noteToFrequency(note: number): number {
  const semitone = note % 12;
  const block = Math.floor(note / 12) + 2;
  const fnum = F_NUMBERS[semitone]!;
  return (fnum * 49716) / Math.pow(2, 20 - block);
}

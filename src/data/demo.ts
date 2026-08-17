/**
 * DEMO.REC -- the recorded input for the original's attract-mode demo.
 *
 * The key insight, from the original's own disassembly notes (reproduced in
 * OpenRoads/Notes/DEMO.REC.txt): the recording is indexed by the ship's
 * POSITION ALONG THE ROAD, not by time. Each byte is the input to apply while
 * the ship occupies that slice of road:
 *
 *     byteIndex = floor(zPosition_fixed16 / 0x666)
 *
 * Since z is stored as 0x10000 units per block, that works out to
 * 0x10000 / 0x666 = 40.01 samples per block. The demo road is 160 rows, and
 * 160 * 40 = 6400 against a 6398-byte file -- which is what confirms the
 * reading. Treating the file as one-byte-per-tick instead implies the demo
 * crawls the road at 0.9 blocks/sec against a top speed of 6.
 *
 * Position indexing also means playback is self-correcting: if the ship is
 * slower or faster than the original recording, it still receives the input
 * that belongs to the piece of road it is actually on.
 *
 * Byte layout:
 *   bits 0-1   accelerate:  value - 1  ->  -1 brake / 0 coast / +1 throttle
 *   bits 2-3   left-right:  value - 1  ->  -1 left  / 0 straight / +1 right
 *   bit  4     jump
 */

import type { Controls } from '../sim/ship.js';

/** Fixed-point z units consumed by one demo sample. */
export const DEMO_UNITS_PER_SAMPLE = 0x666;
/** Fixed-point z units per road block. */
export const Z_FIXED_PER_BLOCK = 0x10000;
/** ~40.01 samples per block. */
export const SAMPLES_PER_BLOCK = Z_FIXED_PER_BLOCK / DEMO_UNITS_PER_SAMPLE;

/** The attract demo always plays the intro road, stored first in ROADS.LZS. */
export const DEMO_LEVEL_INDEX = 0;

export interface DemoRecording {
  /** One input byte per slice of road. */
  samples: Uint8Array;
  /** How many blocks of road the recording covers. */
  blocks: number;
}

export function parseDemo(file: Uint8Array): DemoRecording {
  return { samples: file, blocks: file.length / SAMPLES_PER_BLOCK };
}

export function decodeDemoByte(byte: number): Controls {
  return {
    accel: (byte & 3) - 1,
    turn: ((byte >> 2) & 3) - 1,
    jump: (byte & 0x10) !== 0,
  };
}

/**
 * The input the recording specifies for a ship at road position `z` (blocks).
 * Past the end of the recording the ship simply coasts.
 */
export function demoInputAt(demo: DemoRecording, z: number): Controls {
  const index = Math.floor((z * Z_FIXED_PER_BLOCK) / DEMO_UNITS_PER_SAMPLE);
  const byte = demo.samples[index];
  if (byte === undefined) return { accel: 0, turn: 0, jump: false };
  return decodeDemoByte(byte);
}

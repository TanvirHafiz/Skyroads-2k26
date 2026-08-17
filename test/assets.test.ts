/**
 * Tests for the image and music asset parsers.
 * Skipped when the original data files are absent (see README).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseImage, toRgba } from '../src/data/image.js';
import { parseMuzax, noteToFrequency, MUSIC_TICK_HZ } from '../src/data/muzax.js';
import { worldIndexForLevel } from '../src/render/backdrop.js';
import { songForLevel } from '../src/audio/music.js';

const has = (p: string) => existsSync(p);
const WORLD0 = 'assets/original/WORLD0.LZS';
const MUZAX = 'assets/original/MUZAX.LZS';

describe('note frequencies', () => {
  it('lands on real musical pitches', () => {
    // These come out of the OPL F-number table plus the octave formula; if
    // either is wrong the tuning drifts audibly.
    expect(noteToFrequency(33)).toBeCloseTo(220.0, 1); // A3
    expect(noteToFrequency(28)).toBeCloseTo(164.6, 1); // E3
    expect(noteToFrequency(40)).toBeCloseTo(329.2, 1); // E4
  });

  it('doubles frequency every twelve notes', () => {
    expect(noteToFrequency(45) / noteToFrequency(33)).toBeCloseTo(2, 3);
  });

  it('ticks the command stream at 200 Hz', () => {
    expect(MUSIC_TICK_HZ).toBe(200);
  });
});

describe('planet and song assignment', () => {
  it('groups roads three to a planet', () => {
    expect(worldIndexForLevel(1)).toBe(0);
    expect(worldIndexForLevel(3)).toBe(0);
    expect(worldIndexForLevel(4)).toBe(1);
    expect(worldIndexForLevel(30)).toBe(9);
    expect(worldIndexForLevel(0)).toBe(0); // intro demo road
  });

  it('never picks a world outside the ten shipped backdrops', () => {
    for (let i = 0; i <= 30; i++) {
      expect(worldIndexForLevel(i)).toBeGreaterThanOrEqual(0);
      expect(worldIndexForLevel(i)).toBeLessThanOrEqual(9);
    }
  });

  it('keeps song 0 for the intro and cycles the rest in game', () => {
    for (let i = 1; i <= 30; i++) {
      const s = songForLevel(i, 14);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThan(14);
    }
  });
});

describe.skipIf(!has(WORLD0))('WORLD backdrops', () => {
  it('decodes every planet backdrop at 320x138', () => {
    for (let i = 0; i < 10; i++) {
      const path = `assets/original/WORLD${i}.LZS`;
      if (!has(path)) continue;
      const image = parseImage(new Uint8Array(readFileSync(path)));
      expect(image.width).toBe(320);
      expect(image.height).toBe(138);
      expect(image.pixels).toHaveLength(320 * 138);
      // Every pixel must index a real palette entry.
      const maxIndex = Math.max(...image.pixels);
      expect(maxIndex).toBeLessThan(image.paletteCount);
    }
  });

  it('produces opaque RGBA of the right size', () => {
    const image = parseImage(new Uint8Array(readFileSync(WORLD0)));
    const rgba = toRgba(image);
    expect(rgba).toHaveLength(320 * 138 * 4);
    expect(rgba[3]).toBe(255);
  });

  it('is not a flat image -- real artwork uses many colours', () => {
    const image = parseImage(new Uint8Array(readFileSync(WORLD0)));
    expect(new Set(image.pixels).size).toBeGreaterThan(30);
  });
});

describe.skipIf(!has(MUZAX))('MUZAX music', () => {
  const songs = parseMuzax(new Uint8Array(readFileSync(MUZAX)));

  it('decodes the 14 shipped songs, ignoring the zero-padded table tail', () => {
    expect(songs).toHaveLength(14);
  });

  it('gives every song instruments and a command stream', () => {
    for (const song of songs) {
      expect(song.instruments.length).toBeGreaterThan(0);
      expect(song.commands.length).toBeGreaterThan(100);
    }
  });

  it('has plausible song durations', () => {
    for (const song of songs) {
      const ticks = song.commands.filter((c) => c.type === 0).reduce((n, c) => n + c.value, 0);
      const seconds = ticks / MUSIC_TICK_HZ;
      expect(seconds).toBeGreaterThan(20);
      expect(seconds).toBeLessThan(400);
    }
  });

  it('references only instruments that exist', () => {
    for (const song of songs) {
      for (const c of song.commands) {
        if (c.type === 1) expect(c.value).toBeLessThan(song.instruments.length);
      }
    }
  });

  it('every song loops', () => {
    // Type 6 saves a position and type 5 jumps back to it. Without both, a
    // track would play once and leave silence behind.
    for (const song of songs) {
      expect(song.commands.some((c) => c.type === 6)).toBe(true);
      expect(song.commands.some((c) => c.type === 5)).toBe(true);
    }
  });
});

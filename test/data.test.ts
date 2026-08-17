/**
 * Data-pipeline tests. These run against the player's own copy of the original
 * game in assets/original/ (see README) and are skipped when it is absent, so
 * a fresh clone without the data files still has a green test run.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { decompressLzs } from '../src/data/lzs.js';
import { parseRoads, decodeCell, ROAD_WIDTH } from '../src/data/roads.js';
import { TileBehaviour, behaviourForColour } from '../src/data/palette.js';

const ROADS_PATH = 'assets/original/ROADS.LZS';
const hasOriginal = existsSync(ROADS_PATH);
const describeWithData = hasOriginal ? describe : describe.skip;

describe('cell bitfield', () => {
  it('decodes bottom colour from the low nibble', () => {
    expect(decodeCell(0x0001).bottomColour).toBe(1);
    expect(decodeCell(0x000f).bottomColour).toBe(15);
    expect(decodeCell(0x0000).bottomColour).toBe(0); // gap
  });

  it('decodes top colour from bits 7-4', () => {
    expect(decodeCell(0x0260).topColour).toBe(6);
    expect(decodeCell(0x0440).topColour).toBe(4);
  });

  it('decodes the structural flags', () => {
    expect(decodeCell(0x0101).isTunnel).toBe(true);
    expect(decodeCell(0x0101).bottomColour).toBe(1);
    expect(decodeCell(0x0200).hasHalfTopBlock).toBe(true);
    expect(decodeCell(0x0400).hasFullTopBlock).toBe(true);
    expect(decodeCell(0x0001).isTunnel).toBe(false);
  });

  it('maps colour indices to the documented behaviours', () => {
    expect(behaviourForColour(2)).toBe(TileBehaviour.Sticky);
    expect(behaviourForColour(8)).toBe(TileBehaviour.Slippery);
    expect(behaviourForColour(9)).toBe(TileBehaviour.Supplies);
    expect(behaviourForColour(10)).toBe(TileBehaviour.Boost);
    expect(behaviourForColour(12)).toBe(TileBehaviour.Burning);
    expect(behaviourForColour(1)).toBe(TileBehaviour.Normal);
  });
});

describeWithData('ROADS.LZS', () => {
  const file = new Uint8Array(readFileSync(ROADS_PATH));
  const { levels, diagnostics } = parseRoads(file);

  it('contains the intro demo road plus 30 levels', () => {
    expect(levels).toHaveLength(31);
  });

  it('decompresses every level into whole rows of sane size', () => {
    // The decompressor throws if the bitstream runs dry before the declared
    // size is reached, so all 31 levels decoding at all is the real signal here.
    for (const level of levels) {
      expect(level.rows).toBeGreaterThan(0);
      expect(level.cells).toHaveLength(level.rows * ROAD_WIDTH);
    }
  });

  it('never uses the reserved high bits', () => {
    expect([...diagnostics.reservedBitsSeen]).toEqual([]);
  });

  it('yields gravity values on the original 100-1700 scale', () => {
    for (const level of levels) {
      expect(level.gravity % 100).toBe(0);
      expect(level.gravity).toBeGreaterThanOrEqual(100);
      expect(level.gravity).toBeLessThanOrEqual(1700);
    }
  });

  it('has plausible fuel and oxygen budgets', () => {
    for (const level of levels) {
      expect(level.fuel).toBeGreaterThan(0);
      expect(level.oxygen).toBeGreaterThan(0);
    }
  });

  it('level 27 starts with supply blocks, justifying its 2s oxygen budget', () => {
    // A deliberate design: you begin nearly suffocating and must immediately
    // reach the oxygen column. Also cross-checks that fuel/oxygen aren't swapped.
    const level = levels[27]!;
    expect(level.oxygen).toBe(2);
    const earlySupplies = level.cells
      .slice(0, 10 * ROAD_WIDTH)
      .filter((c) => c.behaviour === TileBehaviour.Supplies);
    expect(earlySupplies.length).toBeGreaterThan(0);
  });

  it('level 20 uses the no-jump gravity value', () => {
    expect(levels[20]!.gravity).toBe(1700);
    expect(levels[20]!.gravityRaw).toBe(0x14);
  });
});

describe('LZS decompressor', () => {
  it('rejects an implausible prelude', () => {
    expect(() => decompressLzs(new Uint8Array([0, 0, 0, 0]), 4)).toThrow(/prelude/);
  });

  it('throws rather than silently truncating when input runs out', () => {
    // Widths are plausible but there are no data bits at all.
    expect(() => decompressLzs(new Uint8Array([4, 4, 8]), 16)).toThrow(/exhausted/);
  });
});

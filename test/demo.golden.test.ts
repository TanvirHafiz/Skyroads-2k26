/**
 * Golden test: the original game's own recorded demo must complete the road.
 *
 * This is the strongest fidelity check available to us. DEMO.REC holds the
 * inputs the 1993 game recorded for its attract-mode run of the intro road.
 * If our simulation drifts from the original -- wrong gravity, wrong steering
 * authority, wrong collision response -- the ship falls off long before the
 * end. Reaching row 160 is only possible if the physics genuinely line up.
 *
 * Skipped when the original data files are absent (see README).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseRoads } from '../src/data/roads.js';
import {
  parseDemo,
  decodeDemoByte,
  demoInputAt,
  DEMO_LEVEL_INDEX,
  SAMPLES_PER_BLOCK,
} from '../src/data/demo.js';
import { SimLevel } from '../src/sim/level.js';
import { createSim, stepSim, ShipState } from '../src/sim/ship.js';

const ROADS = 'assets/original/ROADS.LZS';
const DEMO = 'assets/original/DEMO.REC';
const hasData = existsSync(ROADS) && existsSync(DEMO);
const describeWithData = hasData ? describe : describe.skip;

describe('DEMO.REC byte layout', () => {
  it('decodes the three control fields', () => {
    // Neutral on both axes, no jump.
    expect(decodeDemoByte(0x05)).toEqual({ accel: 0, turn: 0, jump: false });
    // bits 0-1 = 2 -> throttle up.
    expect(decodeDemoByte(0x06)).toEqual({ accel: 1, turn: 0, jump: false });
    // bits 0-1 = 0 -> brake.
    expect(decodeDemoByte(0x04)).toEqual({ accel: -1, turn: 0, jump: false });
    // bits 2-3 = 2 -> right.
    expect(decodeDemoByte(0x09)).toEqual({ accel: 0, turn: 1, jump: false });
    // bits 2-3 = 0 -> left.
    expect(decodeDemoByte(0x01)).toEqual({ accel: 0, turn: -1, jump: false });
    // bit 4 -> jump.
    expect(decodeDemoByte(0x15)).toEqual({ accel: 0, turn: 0, jump: true });
  });

  it('samples ~40 times per block of road', () => {
    expect(SAMPLES_PER_BLOCK).toBeCloseTo(40.01, 2);
  });
});

describeWithData('demo replay', () => {
  const roads = parseRoads(new Uint8Array(readFileSync(ROADS))).levels;
  const demo = parseDemo(new Uint8Array(readFileSync(DEMO)));
  const road = roads[DEMO_LEVEL_INDEX]!;

  it('covers the demo road exactly once', () => {
    // 6398 samples / 40.01 = 159.9 blocks against a 160-row road. This near
    // exact match is what identifies the file as position-indexed.
    expect(demo.blocks).toBeGreaterThan(road.rows - 2);
    expect(demo.blocks).toBeLessThanOrEqual(road.rows);
  });

  it('is indexed by position, not by tick', () => {
    // A tick-indexed reading would imply the demo crawls the road far below
    // the game's top speed of 6 blocks/sec, which is not plausible.
    const impliedBlocksPerSecond = road.rows / (demo.samples.length / 36.004);
    expect(impliedBlocksPerSecond).toBeLessThan(1);
  });

  it('flies the whole road, proving the physics match the original', () => {
    const level = new SimLevel(road);
    const sim = createSim(level);
    let ticks = 0;
    for (; ticks < 20000 && sim.ship.state === ShipState.Alive; ticks++) {
      stepSim(sim, level, demoInputAt(demo, sim.ship.z));
    }

    expect(sim.ship.state).toBe(ShipState.Finished);
    expect(sim.ship.z).toBeGreaterThanOrEqual(road.rows);
  });

  it('completes in a plausible time for the road length', () => {
    const level = new SimLevel(road);
    const sim = createSim(level);
    let ticks = 0;
    for (; ticks < 20000 && sim.ship.state === ShipState.Alive; ticks++) {
      stepSim(sim, level, demoInputAt(demo, sim.ship.z));
    }
    const seconds = ticks / 36.004;
    // 160 rows at a realistic average pace; wildly off would mean the speed
    // constants are wrong even though the ship survives.
    expect(seconds).toBeGreaterThan(30);
    expect(seconds).toBeLessThan(75);
  });
});

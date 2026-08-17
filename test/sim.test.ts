/**
 * Simulation characterisation tests.
 *
 * These assert the emergent behaviour the constants are supposed to produce --
 * jump arcs per gravity, time to top speed, resource burn rates -- rather than
 * just re-stating the constants. If a future change to the tick breaks the
 * feel, these fail even though every individual constant still looks right.
 */

import { describe, it, expect } from 'vitest';
import { Palette } from '../src/data/palette.js';
import type { Level as RoadLevel } from '../src/data/roads.js';
import { SimLevel } from '../src/sim/level.js';
import { createSim, stepSim, ShipState, type Controls } from '../src/sim/ship.js';
import {
  MAX_Z_VELOCITY,
  SIM_HZ,
  TANK_FULL,
  Y_BLOCK,
  Y_ROAD_SURFACE,
  ROAD_WIDTH,
} from '../src/sim/constants.js';

/** A flat, featureless road of plain colour-1 blocks, N rows long. */
function flatLevel(opts: { gravityRaw: number; rows?: number; fuel?: number; oxygen?: number }) {
  const rows = opts.rows ?? 400;
  const cells = Array.from({ length: rows * ROAD_WIDTH }, () => ({
    bottomColour: 1,
    topColour: 0,
    hasFullTopBlock: false,
    hasHalfTopBlock: false,
    isTunnel: false,
    behaviour: 'normal' as never,
    raw: 0x0001,
  }));
  const road: RoadLevel = {
    index: 0,
    gravity: (opts.gravityRaw - 3) * 100,
    gravityRaw: opts.gravityRaw,
    fuel: opts.fuel ?? 200,
    oxygen: opts.oxygen ?? 60,
    palette: new Palette(new Uint8Array(216)),
    cells,
    rows,
  };
  return new SimLevel(road);
}

const HOLD = (c: Partial<Controls> = {}): Controls => ({
  accel: 0,
  turn: 0,
  jump: false,
  ...c,
});

/** Runs `ticks` ticks and returns the peak height reached above the deck. */
function jumpApex(gravityRaw: number): { apexBlocks: number; airtimeTicks: number } {
  const level = flatLevel({ gravityRaw });
  const sim = createSim(level);
  const ship = sim.ship;
  let peak = ship.y;
  let airtime = 0;

  stepSim(sim, level, HOLD({ jump: true }));
  for (let i = 0; i < 400; i++) {
    stepSim(sim, level, HOLD());
    peak = Math.max(peak, ship.y);
    if (ship.y > Y_ROAD_SURFACE + 0.01) airtime++;
    else if (i > 2) break;
  }
  return { apexBlocks: (peak - Y_ROAD_SURFACE) / Y_BLOCK, airtimeTicks: airtime };
}

describe('jump arcs scale with gravity', () => {
  it('is floaty at gravity 100', () => {
    const { apexBlocks, airtimeTicks } = jumpApex(4); // 100
    expect(apexBlocks).toBeGreaterThan(4);
    expect(apexBlocks).toBeLessThan(5.2);
    expect(airtimeTicks / SIM_HZ).toBeGreaterThan(0.9); // ~1.1s hang time
  });

  it('is brisk at gravity 500', () => {
    const { apexBlocks, airtimeTicks } = jumpApex(8); // 500
    expect(apexBlocks).toBeGreaterThan(1.9);
    expect(apexBlocks).toBeLessThan(2.7);
    expect(airtimeTicks / SIM_HZ).toBeLessThan(0.8);
  });

  it('is lower at 900 than at 500', () => {
    expect(jumpApex(12).apexBlocks).toBeLessThan(jumpApex(8).apexBlocks);
  });

  it('refuses to jump at all at gravity 1700', () => {
    const level = flatLevel({ gravityRaw: 0x14 }); // 1700
    const sim = createSim(level);
    const ship = sim.ship;
    for (let i = 0; i < 20; i++) stepSim(sim, level, HOLD({ jump: true }));
    expect(ship.y).toBeCloseTo(Y_ROAD_SURFACE, 5);
  });
});

describe('forward motion', () => {
  it('reaches top speed in about four seconds of held throttle', () => {
    const level = flatLevel({ gravityRaw: 8, rows: 5000 });
    const sim = createSim(level);
    const ship = sim.ship;
    let ticks = 0;
    while (ship.zVelocity < MAX_Z_VELOCITY - 1e-9 && ticks < 1000) {
      stepSim(sim, level, HOLD({ accel: 1 }));
      ticks++;
    }
    const seconds = ticks / SIM_HZ;
    expect(seconds).toBeGreaterThan(3.5);
    expect(seconds).toBeLessThan(4.5);
  });

  it('tops out at 6.0 blocks per second', () => {
    expect(MAX_Z_VELOCITY * SIM_HZ).toBeCloseTo(6.0, 2);
  });

  it('never exceeds the speed clamp however long throttle is held', () => {
    const level = flatLevel({ gravityRaw: 8, rows: 5000 });
    const sim = createSim(level);
    const ship = sim.ship;
    for (let i = 0; i < 600; i++) stepSim(sim, level, HOLD({ accel: 1 }));
    expect(ship.zVelocity).toBeLessThanOrEqual(MAX_Z_VELOCITY);
  });
});

describe('resources', () => {
  it('drains oxygen as a pure timer matching the level field in seconds', () => {
    // A 10-second level should empty in ~10 seconds regardless of speed.
    const level = flatLevel({ gravityRaw: 8, oxygen: 10, rows: 5000 });
    const sim = createSim(level);
    const ship = sim.ship;
    let ticks = 0;
    while (ship.state === ShipState.Alive && ticks < 2000) {
      stepSim(sim, level, HOLD());
      ticks++;
    }
    expect(ship.state).toBe(ShipState.OutOfOxygen);
    expect(ticks / SIM_HZ).toBeGreaterThan(9);
    expect(ticks / SIM_HZ).toBeLessThan(11);
  });

  it('drains oxygen at the same rate whether stationary or at full speed', () => {
    const run = (accel: number) => {
      const level = flatLevel({ gravityRaw: 8, oxygen: 30, rows: 20000 });
      const sim = createSim(level);
      const ship = sim.ship;
      for (let i = 0; i < 200; i++) stepSim(sim, level, HOLD({ accel }));
      return ship.oxygen;
    };
    expect(run(0)).toBeCloseTo(run(1), 6);
  });

  it('drains fuel by distance, not time', () => {
    // Standing still must cost no fuel at all.
    const level = flatLevel({ gravityRaw: 8, rows: 5000 });
    const sim = createSim(level);
    const ship = sim.ship;
    for (let i = 0; i < 200; i++) stepSim(sim, level, HOLD());
    expect(ship.fuel).toBe(TANK_FULL);
    expect(ship.zVelocity).toBe(0);
  });

  it('spends fuel per block travelled independent of speed', () => {
    // Cover the same distance slowly and quickly; fuel used should match.
    const distanceFuel = (accelTicks: number) => {
      const level = flatLevel({ gravityRaw: 8, rows: 20000, fuel: 200 });
      const sim = createSim(level);
      const ship = sim.ship;
      for (let i = 0; i < accelTicks; i++) stepSim(sim, level, HOLD({ accel: 1 }));
      while (ship.z < 50 && ship.state === ShipState.Alive) {
        stepSim(sim, level, HOLD());
      }
      return TANK_FULL - ship.fuel;
    };
    const slow = distanceFuel(30);
    const fast = distanceFuel(200);
    // Same 50 blocks covered, so fuel spent should agree closely.
    expect(Math.abs(slow - fast) / slow).toBeLessThan(0.05);
  });
});

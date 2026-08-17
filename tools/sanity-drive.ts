/**
 * Sanity check: can the simulation drive a road at all under known-good input?
 *
 * This separates two very different failure modes. If the ship cannot travel a
 * straight, wide lane on held throttle, the geometry or collision model is
 * broken. If it can, then a failing DEMO.REC replay points at the input
 * decoding instead.
 */

import { readFileSync } from 'node:fs';
import { parseRoads } from '../src/data/roads.js';
import { SimLevel } from '../src/sim/level.js';
import { createSim, stepSim, ShipState } from '../src/sim/ship.js';
import { SIM_HZ } from '../src/sim/constants.js';

const roads = parseRoads(new Uint8Array(readFileSync('assets/original/ROADS.LZS'))).levels;

function drive(levelIndex: number, label: string, throttle: number): void {
  const road = roads[levelIndex]!;
  const level = new SimLevel(road);
  const sim = createSim(level);
  const ship = sim.ship;

  let ticks = 0;
  const maxTicks = 8000;
  for (; ticks < maxTicks && ship.state === ShipState.Alive; ticks++) {
    stepSim(sim, level, { accel: throttle, turn: 0, jump: false });
  }

  console.log(
    `${label.padEnd(28)} rows ${String(Math.floor(ship.z)).padStart(4)}/${String(road.rows).padEnd(4)} ` +
      `ticks ${String(ticks).padStart(5)} (${(ticks / SIM_HZ).toFixed(1)}s)  ` +
      `x ${ship.x.toFixed(1)}  y ${ship.y.toFixed(1)}  zVel ${ship.zVelocity.toFixed(5)}  ` +
      `${ShipState[ship.state]}`,
  );
}

console.log('Straight-line drive, no steering, held throttle:\n');
drive(1, 'level 1 (3-wide lane)', 1);
drive(1, 'level 1, no throttle', 0);
drive(0, 'level 0 (demo road)', 1);

// Level 1 is a clean 3-wide lane for its first ~20 rows, so a ship holding
// throttle and going straight should comfortably clear that stretch.
const level = new SimLevel(roads[1]!);
const sim = createSim(level);
console.log(`\nlevel 1 start: x=${sim.ship.x} row=${sim.ship.z}`);
console.log(`isOnNothing at start: ${level.isOnNothing(sim.ship.x, sim.ship.z)}`);
console.log(`isInsideTile at start: ${level.isInsideTile(sim.ship.x, sim.ship.y, sim.ship.z)}`);

// Trace the first ticks so a stall or immediate death is visible.
console.log('\ntick  x        y       z       zVel      yVel     state');
const s2 = createSim(level);
for (let i = 0; i < 12; i++) {
  stepSim(s2, level, { accel: 1, turn: 0, jump: false });
  const s = s2.ship;
  console.log(
    String(i).padStart(4) +
      s.x.toFixed(2).padStart(9) +
      s.y.toFixed(2).padStart(8) +
      s.z.toFixed(3).padStart(8) +
      s.zVelocity.toFixed(5).padStart(10) +
      s.yVelocity.toFixed(3).padStart(9) +
      '  ' +
      ShipState[s.state],
  );
}

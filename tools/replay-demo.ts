/**
 * Replays DEMO.REC through the simulation.
 *
 * This is the gold-standard fidelity check: the recording holds the original
 * game's own inputs for the intro road, indexed by position. If our physics
 * match the original, feeding it those inputs should carry the ship the whole
 * way down the road. Divergence shows up as an early death.
 *
 *   npm run replay
 */

import { readFileSync } from 'node:fs';
import { parseRoads } from '../src/data/roads.js';
import { parseDemo, demoInputAt, DEMO_LEVEL_INDEX, SAMPLES_PER_BLOCK } from '../src/data/demo.js';
import { SimLevel } from '../src/sim/level.js';
import { createSim, stepSim, ShipState } from '../src/sim/ship.js';
import { SIM_HZ } from '../src/sim/constants.js';

const roads = parseRoads(new Uint8Array(readFileSync('assets/original/ROADS.LZS'))).levels;
const demo = parseDemo(new Uint8Array(readFileSync('assets/original/DEMO.REC')));

const road = roads[DEMO_LEVEL_INDEX];
if (!road) throw new Error(`No level ${DEMO_LEVEL_INDEX}`);

console.log(
  `DEMO.REC: ${demo.samples.length} samples at ${SAMPLES_PER_BLOCK.toFixed(2)}/block ` +
    `= ${demo.blocks.toFixed(1)} blocks of road\n` +
    `Level ${DEMO_LEVEL_INDEX}: ${road.rows} rows, gravity ${road.gravity}, ` +
    `fuel ${road.fuel}, oxygen ${road.oxygen}s\n`,
);

const level = new SimLevel(road);
const sim = createSim(level);
const ship = sim.ship;

let ticks = 0;
let maxZ = 0;
let refills = 0;
let bounces = 0;
let bumps = 0;
const MAX_TICKS = 20000;

for (; ticks < MAX_TICKS && ship.state === ShipState.Alive; ticks++) {
  stepSim(sim, level, demoInputAt(demo, ship.z));
  maxZ = Math.max(maxZ, ship.z);
  if (sim.events.refilled) refills++;
  if (sim.events.bounced) bounces++;
  if (sim.events.bumpedWall) bumps++;
}

const pct = ((maxZ / road.rows) * 100).toFixed(1);
console.log(
  `Result: ${ShipState[ship.state]} after ${ticks} ticks (${(ticks / SIM_HZ).toFixed(1)}s)\n` +
    `  reached row ${Math.floor(maxZ)}/${road.rows}  (${pct}%)\n` +
    `  oxygen refills ${refills}, bounces ${bounces}, wall bumps ${bumps}\n` +
    `  final x ${ship.x.toFixed(1)}  y ${ship.y.toFixed(1)}  ` +
    `zVel ${ship.zVelocity.toFixed(5)}`,
);

if (ship.state === ShipState.Finished) {
  console.log('\nThe demo completed the road. Physics match the original.');
} else {
  console.log('\nDid not finish -- the simulation still diverges from the original.');
  process.exitCode = 1;
}

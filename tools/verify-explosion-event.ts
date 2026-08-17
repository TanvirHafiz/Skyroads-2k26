/**
 * One-off check: does sim.events.exploded actually fire when the ship hits a
 * burning tile -- the exact flag main.ts's explosion-spawn hook watches for.
 *
 * Drives level 27 straight down the centre lane (where the road data has a
 * burning tile a few rows past the oxygen column) and reports the tick where
 * the event fires.
 */

import { readFileSync } from 'node:fs';
import { parseRoads } from '../src/data/roads.js';
import { SimLevel } from '../src/sim/level.js';
import { createSim, stepSim, ShipState } from '../src/sim/ship.js';

const roads = parseRoads(new Uint8Array(readFileSync('assets/original/ROADS.LZS'))).levels;
const level = new SimLevel(roads[27]!);
const sim = createSim(level);

let firedAt = -1;
for (let tick = 0; tick < 3000 && sim.ship.state === ShipState.Alive; tick++) {
  stepSim(sim, level, { accel: 1, turn: 0, jump: false });
  if (sim.events.exploded) {
    firedAt = tick;
    break;
  }
}

console.log(
  JSON.stringify({
    firedAt,
    finalState: ShipState[sim.ship.state],
    row: Math.floor(sim.ship.z),
  }),
);

if (firedAt < 0 || sim.ship.state !== ShipState.Exploded) {
  console.error('FAIL: events.exploded never fired, or state did not end Exploded');
  process.exit(1);
}
console.log('OK: events.exploded fired and ship.state ended Exploded');

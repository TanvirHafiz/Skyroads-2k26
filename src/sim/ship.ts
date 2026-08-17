/**
 * The ship tick -- the heart of the remake.
 *
 * Ported from the MIT-licensed OpenRoads reference physics
 * (github.com/anprogrammer/OpenRoads, OpenRoadsLib/Src/Game/Ship.ts), itself a
 * reconstruction of the DOS original. Constants live in constants.ts with
 * their raw hex so they stay traceable.
 *
 * Motion is NOT a simple position += velocity. The original advances toward a
 * desired position, then walks back along that path in decreasing granularity
 * steps until it finds the last spot not intersecting geometry. That
 * behaviour, plus the edge-slide in handleBounce and the JumpOMaster assist,
 * is what makes the game feel the way it does.
 *
 * The tick is deterministic: fixed-point grids only, no randomness, no clock
 * reads, no rendering dependencies.
 */

import {
  AIR_CONTROL_HEIGHT,
  FATAL_IMPACT_SPEED,
  GRAVITY_ENGAGE_HEIGHT,
  JUMP_IMPULSE,
  MAX_Z_VELOCITY,
  MIN_Y_VELOCITY,
  NO_JUMP_GRAVITY_RAW,
  PAD_ACCEL,
  SIDE_IMPACT_PENALTY,
  STEERING_BASELINE,
  TANK_FULL,
  THROTTLE_ACCEL,
  TURN_RATE,
  XY_GRID,
  Y_ROAD_SURFACE,
  Z_GRID,
  bounceThreshold,
  fuelDrainPerTick,
  gravityAcceleration,
  oxygenDrainPerTick,
  quantiseXY,
  quantiseZ,
  sFloor,
} from './constants.js';
import { SimLevel, TouchEffect, isEmptyCell, ROAD_X_MIN, ROAD_X_SPAN } from './level.js';

export enum ShipState {
  Alive,
  Exploded,
  OutOfOxygen,
  OutOfFuel,
  Finished,
}

/** Player intent for a single tick. Axes are -1, 0 or 1. */
export interface Controls {
  accel: number;
  turn: number;
  jump: boolean;
}

export const NEUTRAL_CONTROLS: Controls = { accel: 0, turn: 0, jump: false };

export interface ShipState_ {
  x: number;
  y: number;
  z: number;
  xMovementBase: number;
  yVelocity: number;
  zVelocity: number;
  slideAmount: number;
  slidingAccel: number;
  offsetAtWhichNotInsideTile: number;
  isOnGround: boolean;
  isGoingUp: boolean;
  jumpedFromY: number;
  hasRunJumpOMaster: boolean;
  jumpOMasterVelocityDelta: number;
  jumpOMasterInUse: boolean;
  fuel: number;
  oxygen: number;
  state: ShipState;
}

export function createShip(start: { x: number; row: number }): ShipState_ {
  return {
    x: start.x,
    y: Y_ROAD_SURFACE,
    z: start.row,
    xMovementBase: 0,
    yVelocity: 0,
    zVelocity: 0,
    slideAmount: 0,
    slidingAccel: 0,
    offsetAtWhichNotInsideTile: 0,
    isOnGround: true,
    isGoingUp: false,
    jumpedFromY: Y_ROAD_SURFACE,
    hasRunJumpOMaster: false,
    jumpOMasterVelocityDelta: 0,
    jumpOMasterInUse: false,
    fuel: TANK_FULL,
    oxygen: TANK_FULL,
    state: ShipState.Alive,
  };
}

export interface TickEvents {
  exploded: boolean;
  bounced: boolean;
  refilled: boolean;
  bumpedWall: boolean;
}

export function createEvents(): TickEvents {
  return { exploded: false, bounced: false, refilled: false, bumpedWall: false };
}

/**
 * Convenience container: the ship plus the persistent `expected` state and a
 * scratch buffer the collision sweeps reuse, so the tick allocates nothing.
 */
export interface ShipSim {
  ship: ShipState_;
  expected: ShipState_;
  scratch: ShipState_;
  events: TickEvents;
}

export function createSim(level: SimLevel): ShipSim {
  const ship = createShip(level.findStart());
  return {
    ship,
    expected: { ...ship },
    scratch: { ...ship },
    events: createEvents(),
  };
}

export function stepSim(sim: ShipSim, level: SimLevel, controls: Controls): void {
  stepShip(sim.ship, sim.expected, level, controls, sim.events, sim.scratch);
}

const copyInto = (src: ShipState_, dst: ShipState_): void => {
  Object.assign(dst, src);
};

const clampZ = (v: number): number => Math.min(Math.max(0, v), MAX_Z_VELOCITY);

function sanitize(s: ShipState_): void {
  s.x = quantiseXY(s.x);
  s.y = quantiseXY(s.y);
  s.z = quantiseZ(s.z);
}

function interpToward(s: ShipState_, dest: ShipState_, percent: number): void {
  s.x = quantiseXY((dest.x - s.x) * percent + s.x);
  s.y = quantiseXY((dest.y - s.y) * percent + s.y);
  s.z = quantiseZ((dest.z - s.z) * percent + s.z);
}

// --- Motion ------------------------------------------------------------------

function attemptMotion(s: ShipState_, onDecelPad: boolean): void {
  // The steering baseline is added to the velocity used for X motion ONLY --
  // never to forward motion. A decel (sticky) pad suppresses it, which is why
  // sticky tiles cost steering authority as well as speed.
  const motionVel = s.zVelocity + (onDecelPad ? 0 : STEERING_BASELINE);
  const xMotion =
    (sFloor(s.xMovementBase * XY_GRID) * sFloor(motionVel * Z_GRID)) / Z_GRID + s.slideAmount;

  if (s.state !== ShipState.Exploded) {
    s.x += xMotion;
    s.y += s.yVelocity;
    s.z += s.zVelocity;
  }
}

/**
 * Advances toward `dest`, stopping at the last position clear of geometry.
 * Coarse interpolation first, then per-axis descending granularity sweeps.
 */
function moveTo(s: ShipState_, dest: ShipState_, level: SimLevel, scratch: ShipState_): void {
  if (s.x === dest.x && s.y === dest.y && s.z === dest.z) return;

  let iter = 1;
  for (; iter <= 5; iter++) {
    copyInto(s, scratch);
    interpToward(scratch, dest, iter / 5);
    if (level.isInsideTile(scratch.x, scratch.y, scratch.z)) break;
  }
  iter--; // the last step we were NOT inside geometry
  interpToward(s, dest, iter / 5);

  let zGran = 0x1000 / Z_GRID;
  while (zGran !== 0) {
    copyInto(s, scratch);
    scratch.z += zGran;
    if (dest.z - s.z >= zGran && !level.isInsideTile(scratch.x, scratch.y, scratch.z)) {
      s.z = scratch.z;
    } else {
      zGran = Math.floor((zGran / 0x10) * Z_GRID) / Z_GRID;
    }
  }
  s.z = quantiseZ(s.z);

  let xGran = dest.x > s.x ? 0x7d / XY_GRID : -0x7d / XY_GRID;
  while (Math.abs(xGran) > 0) {
    copyInto(s, scratch);
    scratch.x += xGran;
    if (
      Math.abs(dest.x - s.x) >= Math.abs(xGran) &&
      !level.isInsideTile(scratch.x, scratch.y, scratch.z)
    ) {
      s.x = scratch.x;
    } else {
      xGran = sFloor((xGran / 5) * XY_GRID) / XY_GRID;
    }
  }
  s.x = quantiseXY(s.x);

  let yGran = dest.y > s.y ? 0x7d / XY_GRID : -0x7d / XY_GRID;
  while (Math.abs(yGran) > 0) {
    copyInto(s, scratch);
    scratch.y += yGran;
    if (
      Math.abs(dest.y - s.y) >= Math.abs(yGran) &&
      !level.isInsideTile(scratch.x, scratch.y, scratch.z)
    ) {
      s.y = scratch.y;
    } else {
      yGran = sFloor((yGran / 5) * XY_GRID) / XY_GRID;
    }
  }
  s.y = quantiseXY(s.y);
}

// --- JumpOMaster -------------------------------------------------------------

/**
 * Simulates the rest of the current jump to see whether it ends on solid
 * ground. Used by the assist below, never to move the ship.
 */
function willLandOnTile(s: ShipState_, level: SimLevel, accelInput: number): boolean {
  let { x: xPos, y: yPos, z: zPos, yVelocity, zVelocity } = s;
  const xVelocity = s.xMovementBase;

  for (let guard = 0; guard < 4096; guard++) {
    const currentX = xPos;
    const currentZ = zPos;

    yVelocity += gravityAcceleration(level.gravityRaw);
    zPos += zVelocity;

    const xRate = zVelocity + STEERING_BASELINE;
    xPos += xVelocity * xRate * XY_GRID + s.slideAmount;
    if (xPos < ROAD_X_MIN || xPos > ROAD_X_MIN + ROAD_X_SPAN) return false;

    yPos += yVelocity;
    zVelocity = clampZ(zVelocity + accelInput * THROTTLE_ACCEL);

    if (yPos <= Y_ROAD_SURFACE) {
      return !level.isOnNothing(currentX, currentZ) && !level.isOnNothing(xPos, zPos);
    }
  }
  return false;
}

/**
 * The original's mid-jump assist: if the current trajectory would land in a
 * gap, nudge steering or speed by up to +/-60% looking for one that lands.
 * The speed change is reverted on touchdown via jumpOMasterVelocityDelta.
 */
function runJumpOMaster(s: ShipState_, level: SimLevel, accelInput: number): void {
  if (willLandOnTile(s, level, accelInput)) return;

  const zVelocity = s.zVelocity;
  const xMov = s.xMovementBase;
  let i = 1;
  for (; i <= 6; i++) {
    s.xMovementBase = quantiseXY(xMov + (xMov * i) / 10);
    if (willLandOnTile(s, level, accelInput)) break;

    s.xMovementBase = quantiseXY(xMov - (xMov * i) / 10);
    if (willLandOnTile(s, level, accelInput)) break;

    s.xMovementBase = xMov;

    let zv2 = quantiseZ(zVelocity + (zVelocity * i) / 10);
    s.zVelocity = clampZ(zv2);
    if (s.zVelocity === zv2 && willLandOnTile(s, level, accelInput)) break;

    zv2 = quantiseZ(zVelocity - (zVelocity * i) / 10);
    s.zVelocity = clampZ(zv2);
    if (s.zVelocity === zv2 && willLandOnTile(s, level, accelInput)) break;

    s.zVelocity = zVelocity;
  }

  s.jumpOMasterVelocityDelta = zVelocity - s.zVelocity;
  if (i <= 6) s.jumpOMasterInUse = true;
}

// --- Tick --------------------------------------------------------------------

/**
 * Advances the ship by exactly one simulation tick.
 *
 * `expected` persists between ticks: it holds where the ship *wanted* to be,
 * and comparing against it is how collisions are detected.
 */
export function stepShip(
  s: ShipState_,
  expected: ShipState_,
  level: SimLevel,
  controls: Controls,
  events: TickEvents,
  scratch: ShipState_,
): void {
  events.exploded = events.bounced = events.refilled = events.bumpedWall = false;
  sanitize(s);

  const canControl = s.state === ShipState.Alive;
  const cell = level.getCell(s.x, s.z);
  const isAboveNothing = isEmptyCell(cell);

  // --- Which surface are we standing on? ------------------------------------
  let touch = TouchEffect.None;
  if (s.isOnGround) {
    const fy = Math.floor(s.y);
    if (fy === Y_ROAD_SURFACE && cell.hasTile) touch = cell.tileEffect;
    else if (fy > Y_ROAD_SURFACE && cell.cubeHeight !== null && cell.cubeHeight === s.y) {
      touch = cell.cubeEffect;
    }
  }
  const isOnSlidingTile = touch === TouchEffect.Slide;
  const isOnDecelPad = touch === TouchEffect.Decelerate;

  switch (touch) {
    case TouchEffect.Accelerate:
      s.zVelocity += PAD_ACCEL;
      break;
    case TouchEffect.Decelerate:
      s.zVelocity -= PAD_ACCEL;
      break;
    case TouchEffect.Kill:
      if (s.state !== ShipState.Exploded) events.exploded = true;
      s.state = ShipState.Exploded;
      break;
    case TouchEffect.RefillOxygen:
      if (s.state === ShipState.Alive) {
        if (s.fuel < TANK_FULL || s.oxygen < TANK_FULL) events.refilled = true;
        s.fuel = TANK_FULL;
        s.oxygen = TANK_FULL;
      }
      break;
  }
  s.zVelocity = clampZ(s.zVelocity);

  // --- Vertical response to last tick's blocked motion ----------------------
  if (Math.abs(expected.y - s.y) > 0.01) {
    if (s.slideAmount === 0 || s.offsetAtWhichNotInsideTile >= 2) {
      if (Math.abs(s.yVelocity) > bounceThreshold(level.gravityRaw)) {
        if (s.yVelocity < 0) events.bounced = true;
        s.yVelocity = -0.5 * s.yVelocity;
      } else {
        s.yVelocity = 0;
      }
    } else {
      s.yVelocity = 0;
    }
  }

  // --- Velocities -----------------------------------------------------------
  s.zVelocity = clampZ(s.zVelocity + (canControl ? controls.accel : 0) * THROTTLE_ACCEL);

  if (!isOnSlidingTile) {
    const airControl =
      (s.isGoingUp || isAboveNothing) &&
      s.xMovementBase === 0 &&
      s.yVelocity > 0 &&
      s.y - s.jumpedFromY < AIR_CONTROL_HEIGHT;
    const groundControl = !s.isGoingUp && !isAboveNothing;
    if (airControl || groundControl) {
      s.xMovementBase = canControl ? controls.turn * TURN_RATE : 0;
    }
  }

  // --- Jump -----------------------------------------------------------------
  if (
    !s.isGoingUp &&
    !isAboveNothing &&
    controls.jump &&
    level.gravityRaw < NO_JUMP_GRAVITY_RAW &&
    canControl
  ) {
    s.yVelocity = JUMP_IMPULSE;
    s.isGoingUp = true;
    s.jumpedFromY = s.y;
  }

  if (s.isGoingUp && !s.hasRunJumpOMaster && s.y >= 110) {
    runJumpOMaster(s, level, canControl ? controls.accel : 0);
    s.hasRunJumpOMaster = true;
  }

  // --- Gravity --------------------------------------------------------------
  if (s.y >= GRAVITY_ENGAGE_HEIGHT) {
    s.yVelocity += gravityAcceleration(level.gravityRaw);
    s.yVelocity = sFloor(s.yVelocity * XY_GRID) / XY_GRID;
  } else if (s.yVelocity > MIN_Y_VELOCITY) {
    s.yVelocity = MIN_Y_VELOCITY;
  }

  // --- Motion with collision resolution -------------------------------------
  copyInto(s, expected);
  attemptMotion(expected, isOnDecelPad);
  sanitize(expected);
  moveTo(s, expected, level, scratch);
  sanitize(s);
  sanitize(expected);

  // Bump: nudge sideways past a corner rather than dead-stopping on it.
  if (s.z !== expected.z && level.isInsideTile(s.x, s.y, expected.z)) {
    const bumpOff = 0x3a0 / XY_GRID;
    if (!level.isInsideTile(s.x - bumpOff, s.y, expected.z)) {
      s.x -= bumpOff;
      expected.z = s.z;
      events.bumpedWall = true;
    } else if (!level.isInsideTile(s.x + bumpOff, s.y, expected.z)) {
      s.x += bumpOff;
      expected.z = s.z;
      events.bumpedWall = true;
    }
  }

  // Head-on impact: fatal above a third of top speed, otherwise a dead stop.
  if (Math.abs(s.z - expected.z) > 0.01) {
    if (s.zVelocity < FATAL_IMPACT_SPEED) {
      s.zVelocity = 0;
      events.bumpedWall = true;
    } else if (s.state !== ShipState.Exploded) {
      s.state = ShipState.Exploded;
      events.exploded = true;
    }
  }

  // Sideways scrape.
  if (Math.abs(s.x - expected.x) > 0.01) {
    s.xMovementBase = 0;
    if (s.slideAmount !== 0) {
      expected.x = s.x;
      s.slideAmount = 0;
    }
    s.zVelocity = clampZ(s.zVelocity - SIDE_IMPACT_PENALTY);
  }

  // --- Landing and edge slide ----------------------------------------------
  s.isOnGround = false;
  if (s.yVelocity < 0 && expected.y !== s.y) {
    s.zVelocity += s.jumpOMasterVelocityDelta;
    s.jumpOMasterVelocityDelta = 0;
    s.hasRunJumpOMaster = false;
    s.jumpOMasterInUse = false;
    s.isGoingUp = false;
    s.isOnGround = true;
    s.slidingAccel = 0;

    // Landing half off an edge pushes the ship the rest of the way off.
    for (let i = 1; i <= 0xe; i++) {
      if (!level.isInsideTile(s.x + i, s.y - 1 / XY_GRID, s.z)) {
        s.slidingAccel++;
        s.offsetAtWhichNotInsideTile = i;
        break;
      }
    }
    for (let i = 1; i <= 0xe; i++) {
      if (!level.isInsideTile(s.x - i, s.y - 1 / XY_GRID, s.z)) {
        s.slidingAccel--;
        s.offsetAtWhichNotInsideTile = i;
        break;
      }
    }
    s.slideAmount = s.slidingAccel !== 0 ? s.slideAmount + (0x11 * s.slidingAccel) / XY_GRID : 0;
  }

  // --- Terminal conditions --------------------------------------------------
  if (s.y < 0 && s.state === ShipState.Alive) {
    s.state = ShipState.Exploded;
    events.exploded = true;
  }
  if (s.z >= level.rows && s.state === ShipState.Alive) {
    s.state = ShipState.Finished;
  }

  // --- Resources ------------------------------------------------------------
  if (s.state === ShipState.Alive) {
    s.oxygen -= oxygenDrainPerTick(level.oxygen);
    if (s.oxygen <= 0) {
      s.oxygen = 0;
      s.state = ShipState.OutOfOxygen;
    }
    s.fuel -= fuelDrainPerTick(s.zVelocity, level.fuel);
    if (s.fuel <= 0) {
      s.fuel = 0;
      s.state = ShipState.OutOfFuel;
    }
  }
}

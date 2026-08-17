/**
 * SkyRoads simulation constants.
 *
 * Every value here is from the original DOS build, cross-checked between the
 * TASVideos mechanics notes and the MIT-licensed OpenRoads reference physics
 * (github.com/anprogrammer/OpenRoads). Raw hex is preserved so each constant
 * can be traced back to the source rather than re-derived from feel.
 *
 * ON REPRESENTATION -- a deliberate departure from the original plan:
 * the plan called for pure integer fixed-point. The reference implementation
 * instead uses doubles quantised onto the original's fixed-point grids after
 * every step (see quantise* below). We mirror that rather than inventing an
 * integer scheme, because every quantity here is a dyadic rational at
 * magnitudes far inside float64's exact-integer range, so the arithmetic is
 * exact and therefore still fully deterministic -- while avoiding the subtle
 * divergence risk of re-deriving all the rounding behaviour ourselves.
 */

/** Simulation rate in Hz. Derived from the DOS timer divisor, not a round 36. */
export const SIM_HZ = 59659 / 1657; // 36.004224502...
export const SIM_DT = 1657 / 59659; // seconds per tick

// --- Spatial scales (raw original units per block) ---------------------------
export const Z_UNITS_PER_BLOCK = 65536;
export const X_UNITS_PER_BLOCK = 5888;
export const Y_UNITS_PER_BLOCK = 2560;
/** Height of the road surface itself. */
export const Y_ROAD_SURFACE_RAW = 10240; // 0x2800

/** Fixed-point grids: X/Y resolve to 1/128, Z to 1/65536. */
export const XY_GRID = 0x80;
export const Z_GRID = 0x10000;

/** The same scales expressed in the sim's working units (raw / grid). */
export const Y_ROAD_SURFACE = Y_ROAD_SURFACE_RAW / XY_GRID; // 80
export const Y_BLOCK = Y_UNITS_PER_BLOCK / XY_GRID; // 20
export const X_BLOCK = X_UNITS_PER_BLOCK / XY_GRID; // 46

export const ROAD_WIDTH = 7;

// --- Forward motion ----------------------------------------------------------
/** Top speed: 0x2AAA/frame => 6.0 blocks/sec. */
export const MAX_Z_VELOCITY = 0x2aaa / Z_GRID;
/** Throttle authority, 0x4B/frame^2. Roughly 4 seconds from rest to top speed. */
export const THROTTLE_ACCEL = 0x4b / Z_GRID;
/** Boost and sticky pads, 0x12F/frame^2 -- about 4x throttle authority. */
export const PAD_ACCEL = 0x12f / Z_GRID;
/**
 * Baseline added to the velocity used for STEERING only -- never to forward
 * motion. This is why the ship still turns at zero throttle, and why a
 * decelerate (sticky) pad, which suppresses this term, robs you of steering
 * as well as speed.
 */
export const STEERING_BASELINE = 0x618 / Z_GRID;

// --- Steering ----------------------------------------------------------------
/** Turn authority per unit of input. Scaled by forward speed at motion time. */
export const TURN_RATE = 0x1d / XY_GRID;
/** Speed penalty for scraping a wall sideways. */
export const SIDE_IMPACT_PENALTY = 0x97 / Z_GRID;
/** Head-on impacts at or above this speed are fatal; below it you simply stop. */
export const FATAL_IMPACT_SPEED = (1 / 3) * (0x2aaa / Z_GRID);

// --- Jumping and gravity -----------------------------------------------------
/** Upward impulse. Constant across all levels -- only gravity shapes the arc. */
export const JUMP_IMPULSE = 0x480 / XY_GRID; // 9 units/frame
/** Above this height gravity applies; below it the ship is pulled down hard. */
export const GRAVITY_ENGAGE_HEIGHT = 0x28; // 40 == 2 block heights
/** Minimum downward velocity when below the engage height. */
export const MIN_Y_VELOCITY = -105 / XY_GRID;
/** Raw gravity at or above which jumping is disabled entirely (1700). */
export const NO_JUMP_GRAVITY_RAW = 0x14;
/** Air-steering is only permitted for this much height gained since take-off. */
export const AIR_CONTROL_HEIGHT = 30;

/**
 * Downward acceleration per tick for a level's RAW gravity value (4..20).
 * gravity 100 -> -0.445 (floaty), 500 -> -0.898, 1700 -> -2.25 (no jumping).
 */
export function gravityAcceleration(gravityRaw: number): number {
  return -Math.floor((gravityRaw * 0x1680) / 0x190) / XY_GRID;
}

/** Landing impacts faster than this bounce; slower ones simply stop. */
export function bounceThreshold(gravityRaw: number): number {
  return (gravityRaw * 0x104) / 8 / XY_GRID;
}

// --- Resources ---------------------------------------------------------------
/** Both tanks start, and refill, at 0x7530 = 30000. */
export const TANK_FULL = 0x7530;
/** Refill feedback fires only if a tank had dropped below this. */
export const REFILL_NOTIFY_BELOW = 0x6978;

/**
 * Oxygen is a pure timer: a level's oxygen field is literally seconds.
 * Speed does not affect it, so dawdling is what kills you.
 */
export function oxygenDrainPerTick(levelOxygen: number): number {
  return TANK_FULL / (0x24 * levelOxygen);
}

/**
 * Fuel is consumed by DISTANCE, not time -- drain is proportional to velocity.
 * Travelling faster therefore costs no extra fuel per block. Together with the
 * oxygen timer this is the game's central tension.
 */
export function fuelDrainPerTick(zVelocity: number, levelFuel: number): number {
  return (zVelocity * TANK_FULL) / levelFuel;
}

// --- Fixed-point quantisation ------------------------------------------------
export const quantiseXY = (v: number): number => Math.round(v * XY_GRID) / XY_GRID;
export const quantiseZ = (v: number): number => Math.round(v * Z_GRID) / Z_GRID;

/** Truncation toward zero, matching the original's signed floor behaviour. */
export const sFloor = (v: number): number => (v < 0 ? -Math.floor(-v) : Math.floor(v));

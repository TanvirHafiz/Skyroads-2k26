/**
 * The simulation's view of a level.
 *
 * This mirrors the original's collision model rather than approximating it.
 * Coordinates are the original's own, which matters -- notably the road does
 * not start at x = 0. It spans x 95..417, i.e. 7 columns of 46 units, and the
 * ship is 28 units wide (+/-14 from centre).
 *
 * Ported from the MIT-licensed OpenRoads reference (Levels/Level.ts).
 */

import { TileBehaviour } from '../data/palette.js';
import type { Level as RoadLevel } from '../data/roads.js';
import { ROAD_WIDTH, X_BLOCK, Y_ROAD_SURFACE } from './constants.js';

export enum TouchEffect {
  None,
  Accelerate,
  Decelerate,
  Kill,
  Slide,
  RefillOxygen,
}

const EFFECT_BY_BEHAVIOUR: Record<TileBehaviour, TouchEffect> = {
  [TileBehaviour.Normal]: TouchEffect.None,
  [TileBehaviour.Sticky]: TouchEffect.Decelerate,
  [TileBehaviour.Slippery]: TouchEffect.Slide,
  [TileBehaviour.Supplies]: TouchEffect.RefillOxygen,
  [TileBehaviour.Boost]: TouchEffect.Accelerate,
  [TileBehaviour.Burning]: TouchEffect.Kill,
};

/** Leftmost x of the road; the ship's x lives in this offset space. */
export const ROAD_X_MIN = 95;
export const ROAD_X_SPAN = ROAD_WIDTH * X_BLOCK; // 322
/** Half the ship's collision width. */
export const SHIP_HALF_WIDTH = 14;

/**
 * Cube heights indexed by `flags & 6`. Index 2 (half block) sits one block
 * above the deck, index 4 (full block) two blocks above. The deck is 80.
 */
const CUBE_HEIGHTS = [80, 100, 100, 100, 120];

/** Tunnel ceiling and floor profiles, by rounded distance from cell centre. */
const TUNNEL_CEILINGS = [
  0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
  0x20, 0x1f, 0x1f, 0x1f, 0x1f, 0x1f, 0x1e, 0x1e, 0x1e, 0x1d, 0x1d, 0x1d, 0x1c, 0x1b, 0x1a, 0x19,
  0x18, 0x16, 0x14, 0x12, 0x11, 0x0e,
];
const TUNNEL_FLOORS = [
  0x10, 0x10, 0x10, 0x10, 0x0f, 0x0e, 0x0d, 0x0b, 0x08, 0x07, 0x06, 0x05, 0x03, 0x03, 0x03, 0x03,
  0x03, 0x03, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

export interface SimCell {
  tunnel: boolean;
  cubeHeight: number | null;
  cubeEffect: TouchEffect;
  hasTile: boolean;
  tileEffect: TouchEffect;
}

const EMPTY_CELL: SimCell = {
  tunnel: false,
  cubeHeight: null,
  cubeEffect: TouchEffect.None,
  hasTile: false,
  tileEffect: TouchEffect.None,
};

export const isEmptyCell = (c: SimCell): boolean =>
  !c.tunnel && c.cubeHeight === null && !c.hasTile;

export class SimLevel {
  readonly gravityRaw: number;
  readonly fuel: number;
  readonly oxygen: number;
  readonly rows: number;
  private readonly cells: SimCell[];

  constructor(road: RoadLevel) {
    this.gravityRaw = road.gravityRaw;
    this.fuel = road.fuel;
    this.oxygen = road.oxygen;
    this.rows = road.rows;

    this.cells = road.cells.map((cell): SimCell => {
      const flags = (cell.raw >> 8) & 7;
      const cubeBits = flags & 6;
      return {
        tunnel: (flags & 1) !== 0,
        cubeHeight: cubeBits !== 0 ? (CUBE_HEIGHTS[cubeBits] ?? null) : null,
        cubeEffect: EFFECT_BY_BEHAVIOUR[
          cell.topColour > 0 ? behaviourOf(cell.topColour) : TileBehaviour.Normal
        ],
        hasTile: cell.bottomColour > 0,
        tileEffect: EFFECT_BY_BEHAVIOUR[cell.behaviour],
      };
    });
  }

  /**
   * Cell lookup in the original's coordinate space. Note z is quantised to
   * eighths before flooring, which is not the same as flooring z directly.
   */
  getCell(xPos: number, zPos: number): SimCell {
    const x = xPos - ROAD_X_MIN;
    if (x > ROAD_X_SPAN || x < 0) return EMPTY_CELL;
    const column = Math.floor(x / X_BLOCK);
    const row = Math.floor(Math.floor(zPos * 8) / 8);
    if (column < 0 || column >= ROAD_WIDTH || row < 0 || row >= this.rows) return EMPTY_CELL;
    return this.cells[row * ROAD_WIDTH + column] ?? EMPTY_CELL;
  }

  private isInsideTileY(yPos: number, distFromCentre: number, cell: SimCell): boolean {
    const d = Math.round(distFromCentre);
    if (d > 37) return false;

    const y2 = yPos - 68;
    const hasTunnel = cell.tunnel;
    const cubeHeight = cell.cubeHeight;

    if (hasTunnel && cubeHeight === null) {
      const lo = TUNNEL_FLOORS[d];
      const hi = TUNNEL_CEILINGS[d];
      return lo !== undefined && hi !== undefined && y2 > lo && y2 < hi;
    }
    if (!hasTunnel && cubeHeight !== null) {
      return yPos < cubeHeight;
    }
    if (hasTunnel && cubeHeight !== null) {
      const lo = TUNNEL_FLOORS[d];
      return lo !== undefined && y2 > lo && yPos < cubeHeight;
    }
    return false;
  }

  /** True when the ship's volume intersects solid geometry at this position. */
  isInsideTile(xPos: number, yPos: number, zPos: number): boolean {
    const left = this.getCell(xPos - SHIP_HALF_WIDTH, zPos);
    const right = this.getCell(xPos + SHIP_HALF_WIDTH, zPos);
    if (isEmptyCell(left) && isEmptyCell(right)) return false;

    // Clipped into the side of the road deck.
    if (yPos < Y_ROAD_SURFACE && yPos > 0x1e80 / 0x80) return true;
    if (yPos < 0x2180 / 0x80) return false;

    let distanceFromCentre = 23 - ((xPos - 49) % X_BLOCK);
    let neighbourOffset = -X_BLOCK;
    if (distanceFromCentre < 0) {
      distanceFromCentre = 1 - distanceFromCentre;
      neighbourOffset = X_BLOCK;
    }

    if (this.isInsideTileY(yPos, distanceFromCentre, this.getCell(xPos, zPos))) return true;
    return this.isInsideTileY(
      yPos,
      47 - distanceFromCentre,
      this.getCell(xPos + neighbourOffset, zPos),
    );
  }

  /** True when there is nothing safe to land on at this spot. */
  isOnNothing(xPos: number, zPos: number): boolean {
    const cell = this.getCell(xPos, zPos);
    return isEmptyCell(cell) || (cell.hasTile && cell.tileEffect === TouchEffect.Kill);
  }

  /**
   * Where the ship starts. Roads do not all begin at row 0 -- the intro demo
   * road and level 27 both open with three empty rows, while level 1 is solid
   * from row 0. Pick the first row with deck under the centre column.
   */
  findStart(): { x: number; row: number } {
    const centre = Math.floor(ROAD_WIDTH / 2);
    const xOf = (col: number) => ROAD_X_MIN + col * X_BLOCK + X_BLOCK / 2;
    for (let row = 0; row < this.rows; row++) {
      if (!this.isOnNothing(xOf(centre), row)) return { x: xOf(centre), row };
      for (let d = 1; d <= centre; d++) {
        if (!this.isOnNothing(xOf(centre - d), row)) return { x: xOf(centre - d), row };
        if (!this.isOnNothing(xOf(centre + d), row)) return { x: xOf(centre + d), row };
      }
    }
    return { x: xOf(centre), row: 0 };
  }
}

function behaviourOf(colour: number): TileBehaviour {
  switch (colour) {
    case 2:
      return TileBehaviour.Sticky;
    case 8:
      return TileBehaviour.Slippery;
    case 9:
      return TileBehaviour.Supplies;
    case 10:
      return TileBehaviour.Boost;
    case 12:
      return TileBehaviour.Burning;
    default:
      return TileBehaviour.Normal;
  }
}

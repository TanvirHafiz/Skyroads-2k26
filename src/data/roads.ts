/**
 * ROADS.LZS parser -- the intro demo road plus the 30 shipped levels.
 *
 * Container layout:
 *   Index: repeating { u16 offset, u16 decompressedSize } until the first
 *          offset is reached. In the shipped file the first offset is 124,
 *          so there are 124/4 = 31 entries: 1 demo road + 30 levels.
 *
 *   Level (at `offset`):
 *     u16   gravity      encoded; see GRAVITY_BASE below
 *     u16   fuel         distance budget
 *     u16   oxygen       seconds budget
 *     byte  palette[216] 72 VGA entries
 *     byte  road[]       LZS-compressed, expands to `decompressedSize`
 *
 *   That header is exactly 2+2+2+216 = 222 bytes, matching the ModdingWiki's
 *   note that "the first 222 bytes of compressed files are unrelated to the
 *   compression".
 *
 * Road data expands to u16 cells, SEVEN per row, rows running away from the
 * player. Cell bitfield:
 *   bits 15-11  unused (never set anywhere in the shipped file)
 *   bit  10     full-height top block
 *   bit  9      half-height top block
 *   bit  8      tunnel / pipe
 *   bits 7-4    top block colour
 *   bits 3-0    bottom block colour (0 = no block, i.e. a gap)
 *
 * NOTE: the ModdingWiki documents this layout four bits higher (full-height at
 * bit 14, bottom colour at bits 7-4). That does not match the shipped data --
 * decoding it that way yields an entirely empty road, and bits 11-15 are never
 * set in any of the 30436 cells. The layout above was derived by measuring bit
 * frequencies across the real file; see tools/analyse-bits.ts. Corroborating
 * samples: 0x0101 is a tunnel over a colour-1 block, 0x0260 is a half-height
 * top block of colour 6 over a gap.
 */

import { decompressLzs } from './lzs.js';
import { Palette, PALETTE_BYTES, TileBehaviour, behaviourForColour } from './palette.js';

export const ROAD_WIDTH = 7;
const LEVEL_HEADER_BYTES = 6 + PALETTE_BYTES; // 222

/**
 * Gravity is stored as a small integer: 4 -> 100, 5 -> 200, ... 20 -> 1700.
 * So gravity = (raw - 3) * 100. Value 20 (0x14) is the "no jumping at all"
 * case the ship code gates on.
 */
const GRAVITY_BASE = 3;
const GRAVITY_STEP = 100;

export interface Cell {
  /** Bottom block colour, 0 when the cell is an empty gap. */
  bottomColour: number;
  /** Top block colour (obstacle above the road surface). */
  topColour: number;
  hasFullTopBlock: boolean;
  hasHalfTopBlock: boolean;
  isTunnel: boolean;
  behaviour: TileBehaviour;
  /** Raw cell word, kept for debugging and for the undocumented low nibble. */
  raw: number;
}

export interface Level {
  index: number;
  /** Real gravity in original units, 100-1700. */
  gravity: number;
  /** Raw encoded gravity; the jump gate compares this against 0x14. */
  gravityRaw: number;
  fuel: number;
  oxygen: number;
  palette: Palette;
  /** Row-major cells, ROAD_WIDTH per row. */
  cells: Cell[];
  rows: number;
}

export function decodeCell(raw: number): Cell {
  const bottomColour = raw & 0x0f;
  const topColour = (raw >> 4) & 0x0f;
  return {
    bottomColour,
    topColour,
    hasFullTopBlock: (raw & 0x0400) !== 0,
    hasHalfTopBlock: (raw & 0x0200) !== 0,
    isTunnel: (raw & 0x0100) !== 0,
    behaviour: behaviourForColour(bottomColour),
    raw,
  };
}

export interface ParseDiagnostics {
  /** Any cell using bits 11-15, which should never happen. Non-empty means the
   *  layout assumption has broken and the decode is suspect. */
  reservedBitsSeen: Set<number>;
}

export interface ParsedRoads {
  levels: Level[];
  diagnostics: ParseDiagnostics;
}

export function parseRoads(file: Uint8Array): ParsedRoads {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);

  const firstOffset = view.getUint16(0, true);
  if (firstOffset % 4 !== 0 || firstOffset < 4 || firstOffset > file.length) {
    throw new Error(`ROADS: implausible index terminator ${firstOffset}`);
  }
  const entryCount = firstOffset / 4;

  const diagnostics: ParseDiagnostics = { reservedBitsSeen: new Set<number>() };
  const levels: Level[] = [];

  for (let i = 0; i < entryCount; i++) {
    const offset = view.getUint16(i * 4, true);
    const decompressedSize = view.getUint16(i * 4 + 2, true);

    const gravityRaw = view.getUint16(offset, true);
    const fuel = view.getUint16(offset + 2, true);
    const oxygen = view.getUint16(offset + 4, true);
    const palette = new Palette(file.subarray(offset + 6, offset + 6 + PALETTE_BYTES));

    const compressed = file.subarray(offset + LEVEL_HEADER_BYTES);
    const { data } = decompressLzs(compressed, decompressedSize);

    const cellCount = Math.floor(data.length / 2);
    const cells: Cell[] = new Array(cellCount);
    const cellView = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let c = 0; c < cellCount; c++) {
      const raw = cellView.getUint16(c * 2, true);
      if ((raw & 0xf800) !== 0) diagnostics.reservedBitsSeen.add(raw >> 11);
      cells[c] = decodeCell(raw);
    }

    levels.push({
      index: i,
      gravity: (gravityRaw - GRAVITY_BASE) * GRAVITY_STEP,
      gravityRaw,
      fuel,
      oxygen,
      palette,
      cells,
      rows: Math.floor(cellCount / ROAD_WIDTH),
    });
  }

  return { levels, diagnostics };
}

/** Cell lookup with bounds handling; out-of-range is an empty gap. */
export function cellAt(level: Level, column: number, row: number): Cell | undefined {
  if (column < 0 || column >= ROAD_WIDTH || row < 0 || row >= level.rows) return undefined;
  return level.cells[row * ROAD_WIDTH + column];
}

/**
 * ASCII dump of a parsed SkyRoads level.
 *
 * This is the verification instrument for the whole data pipeline: if the LZS
 * decompressor or the cell bitfield decode is wrong, the output here is
 * visibly noise rather than a road.
 *
 *   npm run dump            -- summary of every level
 *   npm run dump -- 1       -- ASCII art for level 1
 */

import { readFileSync } from 'node:fs';
import { parseRoads, ROAD_WIDTH, type Level, type Cell } from '../src/data/roads.js';
import { TileBehaviour } from '../src/data/palette.js';

const ROADS_PATH = 'assets/original/ROADS.LZS';

const GLYPH: Record<TileBehaviour, string> = {
  [TileBehaviour.Normal]: '#',
  [TileBehaviour.Sticky]: 'S',
  [TileBehaviour.Slippery]: '~',
  [TileBehaviour.Supplies]: 'O',
  [TileBehaviour.Boost]: '>',
  [TileBehaviour.Burning]: 'X',
};

function glyph(cell: Cell | undefined): string {
  if (!cell) return ' ';
  // Tunnels are checked before the deck: a tunnel can sit over a gap, and
  // showing those as blank hides real geometry from the dump.
  if (cell.isTunnel) return cell.bottomColour === 0 ? 't' : 'T';
  if (cell.bottomColour === 0) return ' ';
  if (cell.hasFullTopBlock) return 'H';
  if (cell.hasHalfTopBlock) return 'h';
  return GLYPH[cell.behaviour];
}

function dumpLevel(level: Level): void {
  console.log(
    `\n=== Level ${level.index} === gravity ${level.gravity} (raw ${level.gravityRaw})  ` +
      `fuel ${level.fuel}  oxygen ${level.oxygen}s  rows ${level.rows}`,
  );
  console.log('    |' + '0123456'.slice(0, ROAD_WIDTH) + '|');
  for (let row = 0; row < level.rows; row++) {
    let line = '';
    for (let col = 0; col < ROAD_WIDTH; col++) {
      line += glyph(level.cells[row * ROAD_WIDTH + col]);
    }
    console.log(String(row).padStart(4) + '|' + line + '|');
  }
}

function main(): void {
  const file = new Uint8Array(readFileSync(ROADS_PATH));
  const { levels, diagnostics } = parseRoads(file);

  console.log(`Parsed ${levels.length} levels from ${ROADS_PATH} (${file.length} bytes)`);
  console.log(
    `Reserved bits 11-15 used: ` +
      (diagnostics.reservedBitsSeen.size ? [...diagnostics.reservedBitsSeen].join(', ') : 'none'),
  );

  const arg = process.argv[2];
  if (arg === undefined) {
    console.log('\nidx  gravity  fuel  oxygen  rows');
    for (const l of levels) {
      console.log(
        String(l.index).padStart(3) +
          String(l.gravity).padStart(9) +
          String(l.fuel).padStart(6) +
          String(l.oxygen).padStart(8) +
          String(l.rows).padStart(6),
      );
    }
    return;
  }

  const level = levels[Number(arg)];
  if (!level) throw new Error(`No such level: ${arg}`);
  dumpLevel(level);
}

main();

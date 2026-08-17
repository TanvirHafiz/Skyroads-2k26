/**
 * SkyRoads palette handling and tile-behaviour mapping.
 *
 * Each level carries a 72-entry VGA palette. Crucially, a block's *behaviour*
 * is not stored in a type field -- it is implied by its colour index. The
 * original game keyed gameplay off the same number that picked the colour,
 * which is why the colour coding is a hard contract with the player rather
 * than a decorative choice.
 *
 * Palette layout (0-based), 15 usable block colours plus black:
 *   0        black
 *   1-15     bottom block, TOP faces      (colour c -> index c)
 *   16-30    bottom block, FRONT faces    (colour c -> index 15 + c)
 *   31-45    bottom block, RIGHT faces    (colour c -> index 30 + c)
 *   46-60    bottom block, LEFT faces     (colour c -> index 45 + c)
 *   61-64    top block: top / front / right / left
 *   65       top block interior (tunnel mode)
 *   66-71    round pipe elements
 */

export const PALETTE_ENTRIES = 72;
export const PALETTE_BYTES = PALETTE_ENTRIES * 3;

/** Gameplay effect of standing on a block. */
export enum TileBehaviour {
  Normal = 'normal',
  /** Dark green: harsh deceleration. */
  Sticky = 'sticky',
  /** Dark grey: no steering authority, momentum is preserved. */
  Slippery = 'slippery',
  /** Blue: refills both oxygen and fuel. Some are hidden off the main line. */
  Supplies = 'supplies',
  /** Light green: harsh acceleration. */
  Boost = 'boost',
  /** Light red: instant death. Note the block EDGES are safe to clip. */
  Burning = 'burning',
}

/**
 * Colour index -> behaviour. Indices not listed here are inert scenery.
 * Verified against the ModdingWiki palette-entry table: e.g. sticky is
 * documented as entries 3/18/33/48 (1-based), which is colour 2 across the
 * four face groups.
 */
const BEHAVIOUR_BY_COLOUR: ReadonlyMap<number, TileBehaviour> = new Map([
  [2, TileBehaviour.Sticky],
  [8, TileBehaviour.Slippery],
  [9, TileBehaviour.Supplies],
  [10, TileBehaviour.Boost],
  [12, TileBehaviour.Burning],
]);

export function behaviourForColour(colour: number): TileBehaviour {
  return BEHAVIOUR_BY_COLOUR.get(colour) ?? TileBehaviour.Normal;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Which face of a block a palette lookup refers to. */
export type Face = 'top' | 'front' | 'right' | 'left';

const FACE_BASE: Record<Face, number> = { top: 0, front: 15, right: 30, left: 45 };

/**
 * A decoded level palette. Stores sRGB 0-255 triples; the renderer converts to
 * linear itself so this layer stays free of rendering concerns.
 */
export class Palette {
  private readonly rgb: Uint8Array; // 72 * 3

  constructor(raw: Uint8Array) {
    if (raw.length < PALETTE_BYTES) {
      throw new Error(`Palette: need ${PALETTE_BYTES} bytes, got ${raw.length}`);
    }
    this.rgb = new Uint8Array(PALETTE_BYTES);
    // VGA DACs are 6-bit. Scale 0-63 to 0-255 rather than shifting left by 2,
    // which would cap white at 252 and leave everything subtly dim.
    for (let i = 0; i < PALETTE_BYTES; i++) {
      this.rgb[i] = Math.round(((raw[i] ?? 0) & 0x3f) * (255 / 63));
    }
  }

  entry(index: number): Rgb {
    const o = index * 3;
    return { r: this.rgb[o] ?? 0, g: this.rgb[o + 1] ?? 0, b: this.rgb[o + 2] ?? 0 };
  }

  /** Colour of one face of a bottom block of the given colour index (1-15). */
  blockFace(colour: number, face: Face): Rgb {
    return this.entry(FACE_BASE[face] + colour);
  }

  /** Colour of one face of a top block. Top blocks share a single colour set. */
  topBlockFace(face: Face): Rgb {
    return this.entry(61 + (['top', 'front', 'right', 'left'] as const).indexOf(face));
  }

  /** Interior shade used when a top block is rendered as a tunnel. */
  tunnelInterior(): Rgb {
    return this.entry(65);
  }
}

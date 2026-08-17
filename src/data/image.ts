/**
 * SkyRoads image format -- used by every .LZS image in the game, including the
 * WORLD0-9.LZS planet backdrops drawn behind each level.
 *
 * Layout (verified against WORLD0.LZS):
 *   "CMAP"                4 bytes
 *   palCount              1 byte      (114 in the world files)
 *   palette               palCount * 3 bytes, 6-bit VGA RGB
 *   unknown               palCount * 2 bytes
 *   "PICT"                4 bytes
 *   unknown               2 bytes     (always 0)
 *   height                2 bytes LE
 *   width                 2 bytes LE
 *   pixels                LZS-compressed, expands to width*height bytes of
 *                         8bpp palette indices
 *
 * The world backdrops are 320x138 -- VGA width, and just the sky band above
 * the horizon rather than a full screen.
 */

import { decompressLzs } from './lzs.js';

export interface SkyImage {
  width: number;
  height: number;
  /** Palette as 8-bit RGB triplets, already scaled up from 6-bit VGA. */
  palette: Uint8Array;
  paletteCount: number;
  /** One palette index per pixel, row-major from the top. */
  pixels: Uint8Array;
}

const ascii = (data: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...data.subarray(offset, offset + length));

export function parseImage(file: Uint8Array): SkyImage {
  if (ascii(file, 0, 4) !== 'CMAP') {
    throw new Error(`Image: expected CMAP signature, got "${ascii(file, 0, 4)}"`);
  }

  const paletteCount = file[4]!;
  const palette = new Uint8Array(paletteCount * 3);
  for (let i = 0; i < palette.length; i++) {
    // VGA DACs are 6-bit; scale to 0-255 rather than shifting, which would cap
    // white at 252 and leave the whole backdrop subtly dim.
    palette[i] = Math.round(((file[5 + i] ?? 0) & 0x3f) * (255 / 63));
  }

  // palette RGB triplets, then an equal count of 2-byte entries of unknown use.
  const pictOffset = 5 + paletteCount * 3 + paletteCount * 2;
  if (ascii(file, pictOffset, 4) !== 'PICT') {
    throw new Error(`Image: expected PICT at ${pictOffset}, got "${ascii(file, pictOffset, 4)}"`);
  }

  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const height = view.getUint16(pictOffset + 6, true);
  const width = view.getUint16(pictOffset + 8, true);
  if (width === 0 || height === 0) throw new Error(`Image: degenerate size ${width}x${height}`);

  const { data } = decompressLzs(file.subarray(pictOffset + 10), width * height);

  return { width, height, palette, paletteCount, pixels: data };
}

/** Expands to RGBA, for uploading as a texture. */
export function toRgba(image: SkyImage): Uint8Array {
  const out = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.pixels.length; i++) {
    const idx = image.pixels[i]! * 3;
    out[i * 4] = image.palette[idx] ?? 0;
    out[i * 4 + 1] = image.palette[idx + 1] ?? 0;
    out[i * 4 + 2] = image.palette[idx + 2] ?? 0;
    out[i * 4 + 3] = 255;
  }
  return out;
}

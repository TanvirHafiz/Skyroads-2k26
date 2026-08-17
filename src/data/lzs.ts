/**
 * SkyRoads `.LZS` decompression.
 *
 * Despite the file extension this is NOT standard LZSS -- stock LZSS decoders
 * produce garbage on it. It is a custom LZ77 variant with the field widths
 * stored in a 3-byte prelude, documented at:
 *   https://moddingwiki.shikadi.net/wiki/SkyRoads_compression
 *
 * Bitstream is big-endian: the first bit read is a byte's most significant bit.
 *
 * Prefix codes:
 *   0   -> short match: distance = read(width2) + 2,                length = read(width1) + 2
 *   10  -> long match:  distance = read(width3) + (1 << width2) + 2, length = read(width1) + 2
 *   11  -> literal:     byte = read(8)
 *
 * Distances count backwards from the current output position; matches may
 * overlap the write head (the classic run-length trick), so bytes must be
 * copied one at a time rather than block-copied.
 */

/** Reads big-endian bit fields (MSB first) out of a byte array. */
class BitReader {
  private bitPos = 0;

  constructor(
    private readonly src: Uint8Array,
    startByte: number,
  ) {
    this.bitPos = startByte * 8;
  }

  /** True once the stream has no whole bits left. */
  get exhausted(): boolean {
    return this.bitPos >= this.src.length * 8;
  }

  /** Reads `count` bits, most significant first. Returns 0 past end of input. */
  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.src[this.bitPos >>> 3] ?? 0;
      const bit = (byte >>> (7 - (this.bitPos & 7))) & 1;
      value = (value << 1) | bit;
      this.bitPos++;
    }
    return value;
  }
}

export interface LzsResult {
  data: Uint8Array;
  /** Bit-field widths from the prelude, useful for diagnostics. */
  widths: { length: number; shortDistance: number; longDistanceExtra: number };
}

/**
 * Decompresses a SkyRoads LZS stream.
 *
 * @param src        Buffer whose first byte is the start of the 3-byte prelude.
 * @param outputSize Expected decompressed size. This comes from the container
 *                   (e.g. the ROADS.LZS index) and doubles as our correctness
 *                   oracle -- a mismatch means the stream was misparsed.
 */
export function decompressLzs(src: Uint8Array, outputSize: number): LzsResult {
  const width1 = src[0] ?? 0; // match length field
  const width2 = src[1] ?? 0; // short-distance field
  const width3 = src[2] ?? 0; // long-distance field (extra bits beyond width2's range)

  if (width1 === 0 || width2 === 0) {
    throw new Error(`LZS: implausible prelude widths ${width1}/${width2}/${width3}`);
  }

  const out = new Uint8Array(outputSize);
  const bits = new BitReader(src, 3);
  let pos = 0;

  while (pos < outputSize) {
    if (bits.exhausted) {
      throw new Error(`LZS: input exhausted after ${pos} of ${outputSize} bytes`);
    }

    let distance: number;

    if (bits.read(1) === 0) {
      // "0" -> short match
      distance = bits.read(width2) + 2;
    } else if (bits.read(1) === 0) {
      // "10" -> long match, distance continues above the short range
      distance = bits.read(width3) + (1 << width2) + 2;
    } else {
      // "11" -> literal byte
      out[pos++] = bits.read(8);
      continue;
    }

    const length = bits.read(width1) + 2;
    let from = pos - distance;
    if (from < 0) {
      throw new Error(`LZS: match distance ${distance} precedes output start at ${pos}`);
    }

    // Copy byte-by-byte: matches are allowed to overlap the write head.
    for (let i = 0; i < length && pos < outputSize; i++) {
      out[pos++] = out[from++]!;
    }
  }

  return {
    data: out,
    widths: { length: width1, shortDistance: width2, longDistanceExtra: width3 },
  };
}

/**
 * Diagnostic for chasing a MIDI timing bug: dumps tempo events and raw tick
 * ranges per track so a runaway delta or a tempo misread is visible directly,
 * rather than only seeing the final (wrong) duration.
 */

import { readFileSync } from 'node:fs';

const path = process.argv[2]!;
const data = new Uint8Array(readFileSync(path));

class ByteReader {
  pos = 0;
  constructor(private readonly data: Uint8Array) {}
  get atEnd() {
    return this.pos >= this.data.length;
  }
  u8() {
    const b = this.data[this.pos] ?? 0;
    this.pos++;
    return b;
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  u32() {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }
  bytes(n: number) {
    const s = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  ascii(n: number) {
    return String.fromCharCode(...this.bytes(n));
  }
  vlq() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    return value >>> 0;
  }
}

const traceTrack = process.argv[3] ? Number(process.argv[3]) : -1;

const r = new ByteReader(data);
console.log('sig', r.ascii(4));
const headerLen = r.u32();
const format = r.u16();
const trackCount = r.u16();
const division = r.u16();
console.log({ headerLen, format, trackCount, division });

for (let t = 0; t < trackCount; t++) {
  const chunkId = r.ascii(4);
  const chunkLen = r.u32();
  const trackEnd = r.pos + chunkLen;
  console.log(`\n-- track ${t}: ${chunkId}, ${chunkLen} bytes --`);

  let tick = 0;
  let runningStatus = 0;
  let maxDelta = 0;
  let eventCount = 0;
  const tempos: Array<{ tick: number; us: number }> = [];

  while (r.pos < trackEnd) {
    const beforePos = r.pos;
    const delta = r.vlq();
    tick += delta;
    maxDelta = Math.max(maxDelta, delta);
    let statusByte = r.u8();
    let wasRunning = false;
    if (statusByte < 0x80) {
      r.pos--;
      statusByte = runningStatus;
      wasRunning = true;
    } else {
      runningStatus = statusByte;
    }
    eventCount++;

    if (t === traceTrack) {
      console.log(
        `  @${beforePos} delta=${delta} tick=${tick} status=0x${statusByte.toString(16)}${wasRunning ? ' (running)' : ''}`,
      );
    }

    if (statusByte === 0xff) {
      const metaType = r.u8();
      const len = r.vlq();
      if (metaType === 0x51 && len === 3) {
        const us = (r.u8() << 16) | (r.u8() << 8) | r.u8();
        tempos.push({ tick, us });
      } else {
        r.pos += len;
      }
    } else if (statusByte === 0xf0 || statusByte === 0xf7) {
      const sysexLen = r.vlq();
      r.pos += sysexLen;
    } else {
      const type = statusByte & 0xf0;
      switch (type) {
        case 0x80:
          r.pos += 2;
          break;
        case 0x90:
          r.pos += 2;
          break;
        case 0xa0:
          r.pos += 2;
          break;
        case 0xb0:
          r.pos += 2;
          break;
        case 0xc0:
          r.pos += 1;
          break;
        case 0xd0:
          r.pos += 1;
          break;
        case 0xe0:
          r.pos += 2;
          break;
        default:
          throw new Error(`bad status 0x${statusByte.toString(16)} at track ${t} pos ${r.pos}`);
      }
    }
  }
  console.log({ eventCount, maxTick: tick, maxDelta, tempos });
  r.pos = trackEnd;
}

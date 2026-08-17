/**
 * Minimal Standard MIDI File (SMF) parser, for user-supplied custom music.
 *
 * Supports format 0 and 1 files with ticks-per-quarter-note timing -- the
 * overwhelming majority of real-world .mid files. SMPTE-based timing and
 * format 2 (independent, non-simultaneous tracks) are not supported and
 * throw a clear error rather than silently producing garbage.
 *
 * All tracks are merged into one time-ordered event list in seconds, with
 * tempo (0xFF 0x51) meta events honoured throughout the file -- not just at
 * time zero -- so tempo changes mid-song still play back correctly. Only
 * note on/off and program change are extracted; controllers, aftertouch,
 * pitch bend and sysex are parsed just enough to skip over correctly.
 */

export interface MidiEvent {
  timeSec: number;
  type: 'on' | 'off' | 'program';
  channel: number; // 0-15
  note: number | undefined; // 0-127, for on/off
  velocity: number | undefined; // 0-127, for on
  program: number | undefined; // 0-127, for program
}

export interface MidiSong {
  events: MidiEvent[];
  durationSec: number;
}

class ByteReader {
  pos = 0;
  constructor(private readonly data: Uint8Array) {}

  get atEnd(): boolean {
    return this.pos >= this.data.length;
  }

  u8(): number {
    const b = this.data[this.pos] ?? 0;
    this.pos++;
    return b;
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }

  bytes(n: number): Uint8Array {
    const s = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  ascii(n: number): string {
    return String.fromCharCode(...this.bytes(n));
  }

  /** Variable-length quantity, MSB-first 7-bit groups, as used throughout SMF. */
  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    return value >>> 0;
  }
}

interface RawEvent {
  tick: number;
  kind: 'on' | 'off' | 'program' | 'tempo';
  channel?: number;
  note?: number;
  velocity?: number;
  program?: number;
  usPerQuarter?: number;
}

export function parseMidi(file: Uint8Array): MidiSong {
  const r = new ByteReader(file);

  if (r.ascii(4) !== 'MThd') throw new Error('MIDI: missing MThd header -- not a MIDI file?');
  const headerLen = r.u32();
  if (headerLen !== 6) throw new Error(`MIDI: unexpected header length ${headerLen}`);
  const format = r.u16();
  const trackCount = r.u16();
  const division = r.u16();
  if (format === 2) throw new Error('MIDI: format 2 (independent tracks) is not supported');
  if ((division & 0x8000) !== 0) throw new Error('MIDI: SMPTE-based timing is not supported');
  const ticksPerQuarter = division;

  const raw: RawEvent[] = [];

  for (let t = 0; t < trackCount; t++) {
    if (r.atEnd) break;
    const chunkId = r.ascii(4);
    const chunkLen = r.u32();
    const trackEnd = r.pos + chunkLen;
    if (chunkId !== 'MTrk') {
      r.pos = trackEnd; // an unknown chunk type; skip it whole
      continue;
    }

    let tick = 0;
    let runningStatus = 0;

    while (r.pos < trackEnd) {
      tick += r.vlq();
      let statusByte = r.u8();
      if (statusByte < 0x80) {
        // Running status: this byte is actually the first data byte of a
        // repeat of the previous channel message.
        r.pos--;
        statusByte = runningStatus;
      } else {
        runningStatus = statusByte;
      }

      if (statusByte === 0xff) {
        const metaType = r.u8();
        const len = r.vlq();
        if (metaType === 0x51 && len === 3) {
          const usPerQuarter = (r.u8() << 16) | (r.u8() << 8) | r.u8();
          raw.push({ tick, kind: 'tempo', usPerQuarter });
        } else {
          r.pos += len;
        }
      } else if (statusByte === 0xf0 || statusByte === 0xf7) {
        // Not `r.pos += r.vlq()`: that reads the pre-call r.pos for the
        // addition before r.vlq()'s own internal r.u8() calls have advanced
        // it, silently dropping the length-VLQ's own byte count from the
        // skip. Split into two statements so r.pos is read fresh afterward.
        const sysexLen = r.vlq();
        r.pos += sysexLen; // sysex payload, not needed for playback
      } else {
        const type = statusByte & 0xf0;
        const channel = statusByte & 0x0f;
        switch (type) {
          case 0x80: {
            const note = r.u8();
            r.u8(); // release velocity, unused
            raw.push({ tick, kind: 'off', channel, note });
            break;
          }
          case 0x90: {
            const note = r.u8();
            const velocity = r.u8();
            raw.push({ tick, kind: velocity === 0 ? 'off' : 'on', channel, note, velocity });
            break;
          }
          case 0xa0: // polyphonic aftertouch
            r.pos += 2;
            break;
          case 0xb0: // control change -- not applied; consumed so parsing stays aligned
            r.pos += 2;
            break;
          case 0xc0: {
            const program = r.u8();
            raw.push({ tick, kind: 'program', channel, program });
            break;
          }
          case 0xd0: // channel aftertouch
            r.pos += 1;
            break;
          case 0xe0: // pitch bend
            r.pos += 2;
            break;
          default:
            throw new Error(`MIDI: unrecognised status byte 0x${statusByte.toString(16)}`);
        }
      }
    }
    r.pos = trackEnd;
  }

  // Stable merge of every track by absolute tick; Array.prototype.sort in every
  // engine we target is stable, which preserves each track's own event order
  // for same-tick events.
  raw.sort((a, b) => a.tick - b.tick);

  const events: MidiEvent[] = [];
  let usPerQuarter = 500_000; // 120 BPM, the spec's default absent a tempo event
  let lastTick = 0;
  let timeSec = 0;

  for (const ev of raw) {
    const deltaTicks = ev.tick - lastTick;
    timeSec += (deltaTicks / ticksPerQuarter) * (usPerQuarter / 1_000_000);
    lastTick = ev.tick;

    if (ev.kind === 'tempo') {
      usPerQuarter = ev.usPerQuarter ?? usPerQuarter;
      continue;
    }
    events.push({
      timeSec,
      type: ev.kind,
      channel: ev.channel ?? 0,
      note: ev.note,
      velocity: ev.velocity,
      program: ev.program,
    });
  }

  return { events, durationSec: timeSec };
}

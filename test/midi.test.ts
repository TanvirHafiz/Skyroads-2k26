/**
 * Tests for the Standard MIDI File parser, built against synthetic byte
 * buffers rather than a real .mid fixture, so the format's tick/tempo math
 * is verified precisely.
 */

import { describe, it, expect } from 'vitest';
import { parseMidi } from '../src/data/midi.js';

/**
 * Builds a minimal format-0, single-track MIDI file: a tempo of exactly
 * 120 BPM (500000 us/quarter), then a note-on, then a note-off exactly one
 * quarter note (480 ticks) later, then end-of-track.
 */
function buildSyntheticMidi(): Uint8Array {
  const track = [
    // delta 0, tempo meta = 500000us (0x07A120)
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    // delta 0, note-on ch0 note60 vel100
    0x00, 0x90, 0x3c, 0x64,
    // delta 480 (VLQ: 0x83 0x60), note-off ch0 note60 vel64
    0x83, 0x60, 0x80, 0x3c, 0x40,
    // delta 0, end of track
    0x00, 0xff, 0x2f, 0x00,
  ];

  const header = [
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0x00, 0x00, 0x00, 0x06, // header length = 6
    0x00, 0x00, // format 0
    0x00, 0x01, // 1 track
    0x01, 0xe0, // division = 480 ticks/quarter
  ];
  const trackHeader = [
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    ...new Uint8Array(new Uint32Array([track.length]).buffer).reverse(),
  ];

  return new Uint8Array([...header, ...trackHeader, ...track]);
}

/** Wraps a single track's event bytes in a minimal format-0 file. */
function wrapSingleTrack(track: number[], division = 480): Uint8Array {
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01,
    (division >> 8) & 0xff, division & 0xff,
  ];
  const trackHeader = [
    0x4d, 0x54, 0x72, 0x6b,
    ...new Uint8Array(new Uint32Array([track.length]).buffer).reverse(),
  ];
  return new Uint8Array([...header, ...trackHeader, ...track]);
}

describe('MIDI parser', () => {
  it('rejects non-MIDI data', () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3, 4]))).toThrow(/MThd/);
  });

  it('parses tempo and converts ticks to seconds correctly', () => {
    const song = parseMidi(buildSyntheticMidi());
    expect(song.events).toHaveLength(2);

    const [on, off] = song.events;
    expect(on).toMatchObject({ type: 'on', channel: 0, note: 60, velocity: 100, timeSec: 0 });
    // 480 ticks at 480 ticks/quarter and 500000us/quarter = exactly one quarter
    // note = 0.5s later.
    expect(off!.type).toBe('off');
    expect(off!.channel).toBe(0);
    expect(off!.note).toBe(60);
    expect(off!.timeSec).toBeCloseTo(0.5, 5);
  });

  it('reports a duration matching the last event', () => {
    const song = parseMidi(buildSyntheticMidi());
    expect(song.durationSec).toBeCloseTo(0.5, 5);
  });

  it('treats a note-on with velocity 0 as a note-off', () => {
    const track = [
      0x00, 0x90, 0x40, 0x64, // note-on ch0 note64 vel100
      0x60, 0x90, 0x40, 0x00, // note-on ch0 note64 vel0 == note-off
      0x00, 0xff, 0x2f, 0x00,
    ];
    const header = [
      0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    ];
    const trackHeader = [
      0x4d, 0x54, 0x72, 0x6b,
      ...new Uint8Array(new Uint32Array([track.length]).buffer).reverse(),
    ];
    const song = parseMidi(new Uint8Array([...header, ...trackHeader, ...track]));
    expect(song.events).toHaveLength(2);
    expect(song.events[1]!.type).toBe('off');
  });

  it('skips a sysex event without losing byte alignment', () => {
    // Regression test: `r.pos += r.vlq()` reads the pre-call r.pos for the
    // addition before r.vlq()'s own r.u8() calls have advanced it, silently
    // dropping the length-VLQ's own byte count from the skip distance. That
    // desynced every event after the first sysex in a real-world file this
    // was caught against (10 tracks, all landing on absurd multi-million-tick
    // deltas past the first sysex). A 1-byte-length VLQ here reproduces it:
    // under the bug, parsing would land one byte early, inside the sysex's
    // own trailing 0xF7 terminator, and misread the note-on that follows.
    // The payload's last byte matters: it must have its high bit clear. If it
    // doesn't (e.g. a trailing 0xF7 terminator), an off-by-one desync can
    // accidentally self-resynchronise -- the stolen byte's own continuation
    // bit happens to absorb exactly the right number of further bytes to land
    // back on the correct status byte, masking the bug. This was verified by
    // hand while writing the fix: a payload ending 0xF7 passed even with the
    // bug present; ending 0x00 (below) does not.
    const track = [
      0x00, 0xf0, 0x03, 0x41, 0x10, 0x00, // sysex, delta 0, 3-byte payload ending 0x00
      0x64, 0x90, 0x3c, 0x64, // delta 100, note-on ch0 note60 vel100
      0x64, 0x80, 0x3c, 0x40, // delta 100, note-off
      0x00, 0xff, 0x2f, 0x00, // end of track
    ];
    const song = parseMidi(wrapSingleTrack(track));

    expect(song.events).toHaveLength(2);
    expect(song.events[0]).toMatchObject({ type: 'on', channel: 0, note: 60, velocity: 100 });
    expect(song.events[1]).toMatchObject({ type: 'off', channel: 0, note: 60 });
    // 100 ticks at 480 ticks/quarter, default 500000us/quarter tempo.
    const expectedGap = (100 / 480) * 0.5;
    expect(song.events[1]!.timeSec - song.events[0]!.timeSec).toBeCloseTo(expectedGap, 6);
  });

  it('rejects format 2 files', () => {
    const header = [
      0x4d,
      0x54,
      0x68,
      0x64,
      0x00,
      0x00,
      0x00,
      0x06,
      0x00,
      0x02, // format 2
      0x00,
      0x01,
      0x01,
      0xe0,
    ];
    expect(() => parseMidi(new Uint8Array(header))).toThrow(/format 2/);
  });

  it('rejects SMPTE-based timing', () => {
    const header = [
      0x4d,
      0x54,
      0x68,
      0x64,
      0x00,
      0x00,
      0x00,
      0x06,
      0x00,
      0x00,
      0x00,
      0x01,
      0xe7,
      0x28, // SMPTE division (high bit set)
    ];
    expect(() => parseMidi(new Uint8Array(header))).toThrow(/SMPTE/);
  });
});

# SkyRoads — Research Brief

Research for a modern HD remake of *SkyRoads* (BlueMoon Software, 1993).
Date: 2026-08-13.

---

## 1. The original

- MS-DOS, 1993, BlueMoon Software (Estonia). Programmers: Ahti Heinla, Priit Kasesalu, Jaan Tallinn (later the Skype/Kazaa core team).
- Remake of their own 1990 game *Kosmonaut*. Sequel: *SkyRoads Xmas Special* (1994) — same engine, harder levels.
- **30 roads across 10 planets**, three roads per planet. Each planet has its own palette, gravity, fuel and oxygen budget.
- **Freeware, but with real strings attached.** Verified against the shipped `readme.txt`, not
  secondary sources — which overstate this badly. The actual terms:

  > "This program is freeware. You can distribute this program freely, as long as you don't
  > reverse engineer, and/or modify this program or any of its accompanying files. This program
  > must be distributed as a single unit, with all accompanying files included and intact in
  > their original form."

  Consequences for us:
  - ✅ Downloading the archive and using it locally for development — fine.
  - ✅ Writing a parser for the formats — we build from **publicly published third-party
    documentation** (ModdingWiki, TASVideos, MIT-licensed OpenRoads), not by reverse engineering
    the binary ourselves. That distinction matters and we should keep it true: don't disassemble
    `SKYROADS.EXE`.
  - ❌ **Redistributing extracted `ROADS.LZS` with our game** — violates "single unit / intact /
    original form". The 30 original roads are *not* shippable content.

  Distribution model is therefore **bring-your-own-data**: the player points the game at their own
  copy of SkyRoads, as OpenRoads and ScummVM-style projects do. Development is unaffected
  (`assets/original/` is gitignored regardless); only bundling is off the table. To ship standalone
  we'd need our own levels — cheap to author later, since Sky High writes the same format.
  Not legal advice, but this is the conservative reading and it costs us very little.

### Core loop
Auto-forward hover-car on a floating 7-column road in space. Throttle up/down, strafe left/right, jump. Run out of road, fuel, or oxygen → restart. Each road ends in a tunnel into space.

---

## 2. Simulation constants (reverse-engineered)

Two independent sources agree: the TASVideos mechanics page and the `OpenRoads` fixed-point reference physics. All original values are fixed-point integers.

### Timing
| Thing | Value |
|---|---|
| Simulation rate | `59659/1657` = **36.00422 Hz** (DOS timer-derived) |
| Everything below | per simulation frame at that rate |

### Space
| Axis | Units per block |
|---|---|
| Longitudinal (Z) | 65536 |
| Horizontal (X) | 5888 |
| Vertical (Y) | 2560 (base road height = 10240 = 4 units) |

Road is **7 columns wide**; the car occupies roughly one column.

### Motion
| Quantity | Raw | Notes |
|---|---|---|
| Max forward speed | 10922 (`0x2AAA`) /frame | = 0.1667 blocks/frame ≈ **6.0 blocks/sec** |
| Throttle accel/decel | 75 (`0x4B`) /frame² | ≈ 1.48 blocks/s²; ~4.0 s from 0 to max |
| Boost / brake pad | 303 (`0x12F`) /frame² | 4× throttle authority |
| Strafe rate | `input × 0x1D / 0x80` | scaled by forward velocity — **fast = wide turns** |
| Glancing side impact | −151 (`0x97`) /frame | speed loss, no death |
| Horizontal ejection | 928 units | knock-back on side hit |
| Fatal Z-impact threshold | zVel ≥ ⅓ × max | slower head-on hits just stop you |
| Landing bounce | yVel → −0.5 × yVel | above an impact threshold |

### Gravity & jumping
- Level stores gravity as a small int `v`; **gravity = (v − 3) × 100**, so `v` = 4..20 → **100..1700**.
- Jump impulse is constant (`0x480` in y-units); gravity alone shapes the arc. 100 = floaty moon-hop, 1700 = **jumping disabled** (engine checks `gravity < 0x14`).
- Strafe authority differs in air vs. grounded vs. on slippery tiles — the airborne window is what makes precise landings hard.
- Speedrun trick: "locked jumps" off tile edges adjacent to burning/empty blocks. Possible up to gravity 700, impossible at 900+.

### Resources (both start at 30000)
- **Oxygen** drain = `30000 / (36 × levelOxygen)` per frame → `levelOxygen` is literally *seconds*. Pure timer, speed-independent.
- **Fuel** drain = `zVelocity × 30000 / levelFuel` per frame → **fuel is distance-based**. Going fast costs no extra fuel per metre.
- The tension is real and non-obvious: oxygen punishes slowness, fuel punishes distance. Blue supply tiles refill both to 30000.

### Update order per tick
1. Sanitize inputs
2. Apply tile-touch effects → update Y, Z, X velocities; jump handling
3. Apply gravity
4. Attempt motion; resolve collision by interpolation against expected state
5. Resolve bumps / slides / bounces
6. Drain oxygen & fuel

---

## 3. Data formats

### `ROADS.LZS` — all 30 levels + intro demo road
Header: repeating `UINT16LE offset`, `UINT16LE decompressed size` until the first level offset.

Per level:
```
UINT16LE gravity        (4=100, 5=200, ... 20=1700)
UINT16LE fuel           (distance budget)
UINT16LE oxygen         (seconds)
BYTE     palette[72×3]  (VGA 6-bit RGB, stored as bytes → ×4 for 8-bit)
BYTE     road[]         (compressed)
```

Decompressed road = `UINT16LE` values, **7 per row**, rows repeating to end of level:

| Bits | Meaning |
|---|---|
> ⚠️ **The ModdingWiki's bitfield table is wrong** — it places every field four bits too high
> (full-height at 14, bottom colour at 7–4). Decoding that way yields a completely empty road.
> Measured across all 30,436 cells of the shipped file, bits 11–15 are **never set**.
> Corrected layout, derived from the data itself via `tools/analyse-bits.ts`:

| Bits | Meaning |
|---|---|
| 15–11 | unused (never set) |
| 10 | full-height top block |
| 9 | half-height top block |
| 8 | tunnel / pipe |
| 7–4 | top block colour |
| 3–0 | bottom block colour (0 = **no block here**, i.e. gap) |

Corroborating samples: `0x0101` = tunnel over a colour-1 block; `0x0260` = half-height top block
of colour 6 over a gap; `0x0000` = gap, and accounts for 49.85% of all cells.

### Palette layout (72 entries) — this is where tile *behaviour* lives
| Entries | Purpose |
|---|---|
| 1 | black |
| 2–16 | bottom block **top** faces (colours 1–15) |
| 17–31 | bottom block **front** faces |
| 32–46 | bottom block **right** faces |
| 47–61 | bottom block **left** faces |
| 62–65 | top block top/front/right/left |
| 66 | top block interior (pipe mode) |
| 67–72 | round pipe elements |

Behaviour is keyed to the **colour index**, not a separate type field:

| Colour idx | Palette entries | Behaviour | Original look |
|---|---|---|---|
| 2 | 3, 18, 33, 48 | **Sticky** — hard deceleration | dark green |
| 8 | 9, 24, 39, 54 | **Slippery** — no steering, keeps momentum | dark grey |
| 9 | 10, 25, 40, 55 | **Supplies** — refill O₂ + fuel (some hidden) | blue |
| 10 | 11, 26, 41, 56 | **Boost** — hard acceleration | light green |
| 12 | 13, 28, 43, 58 | **Burning** — instant death (edges are safe!) | light red |

### `.LZS` compression (custom, *not* standard LZSS)
3-byte header of bit widths: `width1` (length bits), `width2` (short-distance bits), `width3` (extra long-distance bits). Big-endian bitstream, MSB first.

```
bit 0        → short match:  dist = read(width2) + 2,               len = read(width1) + 2
bits 10      → long match:   dist = read(width3) + (1<<width2) + 2, len = read(width1) + 2
bits 11      → literal:      byte = read(8)
```
Min match length 2. Loop until output reaches the declared decompressed size.

### `WORLD0-9.LZS` — planet backdrops (SkyRoads Image Format)

Shared by every image in the game. Verified against the real files:

```
"CMAP"                4 bytes
palCount              1 byte      (114 in the world files)
palette               palCount*3  6-bit VGA RGB
unknown               palCount*2
"PICT"                4 bytes
unknown               2 bytes     (always 0)
height, width         2 bytes LE each
pixels                LZS-compressed -> width*height bytes of palette indices
```

All ten backdrops are **320×138 with 114 colours** — VGA width, and only the sky band above the
horizon rather than a full screen. They are painted artwork (WORLD0 is Red Heat's sun, WORLD4 a
nebula), so they upscale better with linear filtering than nearest.
`npx tsx tools/dump-image.ts` decodes them all to PNG.

### `MUZAX.LZS` — music

**Not a raw OPL register dump** — a compact command stream plus inline instrument definitions.
Song table at the top of the file, 6 bytes per entry:

```
u16 dataOffset        byte offset of the compressed block
u16 instrumentCount   instruments at the head of the block
u16 decompressedLength
```

The table has **20 slots but only 14 are populated**; the tail is zeroed, so read until a zero
offset. Each decompressed block holds `instrumentCount * 16` bytes of instrument data followed by
(low, high) command pairs, where `type = low & 7` and `channel = low >> 4`:

| Type | Meaning |
|---|---|
| 0 | pause `high` ticks (the stream runs at **200 Hz** — a 5 ms tick) |
| 1 | stop note, then load instrument `high` on the channel |
| 2 | play note `high` (`note = high % 12`, `octave = high / 12 + 2`) |
| 3 | stop note |
| 4 | channel volume from `high & 0x3F` |
| 5 / 6 | jump to saved position / save position (every song loops) |

Each instrument is two FM operators (5 bytes each: tremolo/vibrato/multiplier, KSL+level,
attack+decay, sustain+release, waveform) plus a byte of AM-vs-FM and feedback. Pitches come from
the OPL2 F-number table: note 33 → 220.0 Hz, note 40 → 329.2 Hz, exactly on tune.

We re-create the OPL2's *behaviour* rather than emulating the chip — eight waveforms, two
operators in FM or additive mode, feedback, per-operator ADSR. Melody, harmony, instrument
character and timing are faithful; the envelope rate curves are approximations of the hardware
tables. Verified by rendering offline and measuring the spectrum: energy sits on the exact
commanded pitches, ~100× above off-pitch probes.

### Custom MIDI playback (`src/data/midi.ts`)

Not part of the original — a feature allowing a user-supplied `.mid`/`.midi` file to replace the
game's soundtrack, played back through the same FM synth engine as `MUZAX.LZS` rather than a
separate MIDI player. From-scratch Standard MIDI File parser: format 0/1, running status, tempo
meta events honoured throughout the file (not just at time zero), velocity-0-note-on treated as
note-off. Format 2 and SMPTE-based timing are explicitly rejected rather than silently
mis-parsed.

**A real bug worth recording, since it was subtle and only showed up on a real-world file.**
Sysex events (`0xF0`/`0xF7`) were skipped with:

```ts
r.pos += r.vlq();
```

This looks correct but isn't: JavaScript's compound-assignment evaluation order reads the *old*
`r.pos` for the addition before evaluating the right-hand side, even though `r.vlq()` mutates
`r.pos` as a side effect via its own internal `r.u8()` calls. So the length-VLQ's own byte count
silently never gets added to the skip distance — the skip lands short by exactly however many
bytes the length VLQ itself took. On a synthetic single-sysex test file this was *invisible*: a
payload happening to end in a byte with its continuation bit set (e.g. the conventional `0xF7`
terminator) can accidentally re-synchronise the byte stream by luck, absorbing exactly the right
number of extra bytes on the next VLQ read. It only reproduced reliably on a real 10-track file
(`music/96653.mid`, format 1, division 384), where two tracks desynced into tens of millions of
bogus ticks after their first sysex event, inflating a genuine ~23-second song to a reported
107 minutes. Fixed by splitting into two statements so `r.pos` is read fresh after `r.vlq()`
returns. `test/midi.test.ts` locks this in with a payload deliberately chosen *not* to have the
lucky-resync property, so the regression test is actually diagnostic rather than passing by
the same coincidence that hid the bug originally.

### Other files
- `MUZAX.LZS` — AdLib/OPL2 music. Either emulate OPL (OpenRoads ships a JS OPL) or re-record HD stems from it.
- `TREKDAT.LZS` — renderer span tables for the original software rasteriser. **Irrelevant to us** — we're rendering real 3D.
### `DEMO.REC` — attract-mode input recording

**Indexed by position, not by time.** This is the whole trick, and it is not documented on the
ModdingWiki. From the original's disassembly notes (`OpenRoads/Notes/DEMO.REC.txt`):

```
byteIndex = floor(zPosition_fixed16 / 0x666)
```

z is stored at `0x10000` units per block, so `0x10000 / 0x666` = **40.01 samples per block**.
The demo road is 160 rows: 160 × 40.01 = 6402 against a 6398-byte file. That near-exact match is
what identifies the scheme — and reading it as one-byte-per-tick instead implies the demo crawls
the road at 0.9 blocks/sec against a top speed of 6, which is what gave the game away.

Position indexing makes playback self-correcting: a ship running slightly fast or slow still
receives the input belonging to the stretch of road it is actually on.

| Bits | Meaning |
|---|---|
| 0–1 | accelerate: `value − 1` → −1 brake / 0 coast / +1 throttle |
| 2–3 | left-right: `value − 1` → −1 left / 0 straight / +1 right |
| 4 | jump |

Value 3 never occurs on either axis. There is no header byte — index 0 is the sample at road
position 0 — and the recording always plays level 0, the intro road stored first in `ROADS.LZS`.

**This is our golden test.** Feeding these inputs to the sim flies the entire 160-row road
(47.5 s, 1 oxygen pickup, 63 bounces, 1 wall scrape). Nothing but genuinely matching physics
survives that, so it is the objective answer to "is this really SkyRoads". See
`test/demo.golden.test.ts` and `npm run replay`.

---

## 4. Prior art worth mining

| Project | Stack | Why it matters |
|---|---|---|
| [anprogrammer/OpenRoads](https://github.com/anprogrammer/OpenRoads) | TypeScript + WebGL | Most useful reference. Full original-data support, fixed-point `RefPhysics/RefShip.ts` reference sim, JS OPL synth. **Check its licence before copying any code.** |
| [ammaarreshi/SkyRoads-Codex](https://github.com/ammaarreshi/SkyRoads-Codex) | Rust | Most rigorous — traced the DOS binary under DOSBox-X. Best source for exact constants and edge-case rules. |
| [kaimitai/skyhigh](https://github.com/kaimitai/skyhigh_releases) | C++ | "Sky High" level editor. Validates our format parsing and lets us author new levels in the original format. |
| [Mpdreamz/skyroads](https://github.com/Mpdreamz/skyroads) | three.js | Prior three.js attempt — look at what it got wrong. |
| [voyageur/skystreets](https://github.com/voyageur/skystreets) | C/SDL | Native remake. |
| [ModdingWiki](https://moddingwiki.shikadi.net/wiki/SkyRoads_level_format) | — | Canonical format docs. |

---

## 5. Recommended technical approach

### Stack: TypeScript + three.js (`WebGPURenderer`) + Vite
- WebGPU in three.js is production-grade as of r171+, with automatic WebGL2 fallback and Safari now shipping WebGPU. TSL lets us write shaders once.
- The whole aesthetic hinges on **bloom, motion blur and volumetrics over emissive blocks** — cheap and excellent on WebGPU.
- Distribution is a URL. Desktop/Steam later via Tauri if wanted.
- Both best reference implementations are TS/Rust — the TS one is directly readable.
- *Alternative:* Godot 4 if native/console shipping is the priority — but its web export is stuck on the Compatibility (WebGL2) renderer, which undercuts the visual goal.

### Architecture: deterministic sim, decoupled render
```
sim/     fixed-point, 36.0042 Hz, integer math, zero float, zero rendering deps
         → replay DEMO.REC as a golden test
render/  three.js, uncapped fps, interpolates between sim ticks
data/    LZS decompressor, ROADS/MUZAX parsers → typed level structs
```
This is the one architectural decision that must be made up front. Keeping the sim in exact integer fixed-point at 36 Hz is what makes the remake *feel* like SkyRoads instead of "a game that looks like SkyRoads"; it also gives free replays, ghosts and leaderboards.

### HD art direction (faithful-modern)
Keep the readable chunky block language — it's load-bearing for gameplay — and rebuild the presentation:
- Emissive PBR blocks, per-planet palettes derived from the original 72-colour tables (upscaled from 6-bit VGA).
- Bloom, chromatic aberration, film grain, speed-dependent motion blur and FOV punch.
- Volumetric fog receding into the starfield; parallax planet backdrops.
- Burning tiles get real fire shaders; supply tiles pulse; slippery tiles get a wet specular sheen. **Behaviour must stay readable at a glance** — the original's colour coding is the contract with the player.
- Original chiptune reinterpreted, plus the raw OPL rendition as a toggle.

### Risks / open questions
- Bits 3–0 of the road word are undocumented; needs verification against Sky High's parser.
- OpenRoads' licence must be checked before any code reuse (formats and constants are facts, code is not).
- Half-height blocks + tunnel bit combine into flat-topped pipes — the geometry rules there need care in the mesh builder.
- Original ships assets we can legally redistribute, but a first-run "point at your SkyRoads folder" flow is a safer default than bundling.

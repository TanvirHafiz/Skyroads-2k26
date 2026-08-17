# SkyRoads HD

A modern, high-definition remake of *SkyRoads* (BlueMoon Software, 1993), built on a
**1:1 deterministic reconstruction** of the original DOS simulation.

The physics are not approximated. The sim runs at the original's exact tick rate of
59659/1657 = 36.00422 Hz on the original's fixed-point grids, using the reverse-engineered
constants — so jump arcs, top speed, steering authority and fuel burn match the 1993 game
rather than merely evoking it. Rendering is fully decoupled from simulation, so display
refresh rate has no influence on physics.

## You need your own copy of the game

This project does **not** ship the original data files. BlueMoon's licence makes SkyRoads
freeware but requires it be distributed "as a single unit, with all accompanying files
included and intact in their original form" — which rules out redistributing an extracted
`ROADS.LZS`. So, as with ScummVM, you bring your own copy.

1. Download the freeware release (e.g. [archive.org](https://archive.org/details/SkyRoads)).
2. Extract it so the files sit in `assets/original/`:

```
assets/original/ROADS.LZS
assets/original/MUZAX.LZS
assets/original/DEMO.REC
```

`assets/original/` is gitignored and is never bundled into a build.

## Running

**Windows:** double-click [run.bat](run.bat). It installs dependencies on first run, warns if
`assets/original/ROADS.LZS` is missing, starts the dev server, and opens your browser to it.
Leave the window open; closing it (or `Ctrl+C`) stops the server.

**Manually, any OS:**

```bash
npm install
npm run dev
```

Then open the `Local` URL Vite prints (`http://localhost:5173` by default).

Controls: `↑`/`↓` throttle, `←`/`→` steer, `Space` jump, `R` restart, `[`/`]` change level,
`M` load a custom MIDI track for the current session.

## Custom content

**Backdrops:** drop an image named `world0.png` … `world9.png` (or `.jpg`/`.jpeg`/`.webp`) into
`assets/custom/` and it replaces that planet's backdrop — no code changes needed. See
`assets/custom/README.md` for the level-to-planet mapping and art prompts matched to each
original backdrop.

**Music:** drop a `.mid`/`.midi` file into `music/` (project root) and it becomes the game's
default soundtrack — auto-discovered, no filename convention required. Unlike the original's
per-planet MUZAX cycling, a custom track plays continuously across every level, looped. Remove
the file (or press `M` in-game to load a different one for the current session) to fall back to
the original music. Playback goes through the same FM synth engine as `MUZAX.LZS`, so it isn't a
literal MIDI player — General MIDI's 128 programs collapse into four broad instrument characters
(pluck/lead/bass/pad) rather than being faithfully reproduced, and polyphony is capped at 11
simultaneous voices with oldest-note stealing, matching the original engine's own channel count.

## Sharing with beta testers

```bash
npm run dist:win
```

Produces a Windows `.exe` in `release/` — both a normal installer and a standalone portable build
that needs no install step, just double-click and go. This is a complete, zero-setup package:
on first launch the app offers **"Download & Play"**, which fetches the real, unmodified
official freeware release straight from archive.org and extracts it locally — the tester doesn't
need to go find a copy themselves, and doesn't need to know what `ROADS.LZS` even is.
`File → Re-download Official Release...` redoes this later if needed; `File → Change SkyRoads
Data Folder...` lets a tester point at their own existing copy instead, if they'd rather.

**Why this doesn't violate the licence, despite shipping a one-click path to the data:** the app
never embeds or repackages BlueMoon's files itself — nothing at all is bundled beyond our own code
plus whatever's in `music/` and `assets/custom/` (verified: `npx @electron/asar list` on the
packaged app turns up zero `.lzs` files). What "Download & Play" does at runtime is fetch the
*complete, untouched* freeware zip and extract it whole, which is exactly what the licence permits
("distributed... as a single unit, with all accompanying files included and intact in their
original form") — just automated instead of asking the tester to do it by hand. "Freeware" and
"abandonware" are not the same thing as "public domain" or "open source": BlueMoon's programmers
(Heinla, Kasesalu, Tallinn — later the founders of Skype and Kazaa) are identifiable people, and
the licence terms above are still the actual, binding basis for any of this. See
`docs/RESEARCH.md` for the full text and analysis, and `electron/acquire.cjs` for the
implementation.

`npm run electron` runs the packaged app locally (builds first) without going through
electron-builder, for a quick check before cutting a real release. Two env vars exist purely for
scripted testing — `SKYROADS_DATA_DIR=<path>` skips straight to a known folder, and
`SKYROADS_AUTO_DOWNLOAD=1` runs the download flow without the confirmation dialog — since nothing
can drive Electron's native dialogs from a script.

## Verifying

```bash
npm test
```

Covers the LZS decompressor, the road bitfield decode against the real file, *characterisation*
tests that assert emergent behaviour rather than restating constants (jump apex per gravity,
time to top speed, the oxygen/fuel asymmetry), and the golden test below.

The strongest check replays the original game's own attract-mode recording:

```bash
npm run replay
```

`DEMO.REC` holds the inputs the 1993 game recorded for the intro road, indexed by position along
the road rather than by time. Feeding them to our simulation flies the full 160 rows. Wrong
gravity, steering authority or collision response and the ship falls off long before the end —
so completing the road is real evidence the physics match, not just a plausible-looking game.

Dump any road as ASCII art to eyeball the data pipeline:

```bash
npm run dump -- 1
```

## Layout

| Path | Purpose |
|---|---|
| `src/data/` | `.LZS` decompression, `ROADS.LZS` parsing, palette + behaviour mapping |
| `src/sim/` | Deterministic simulation. No rendering imports, no randomness, no clock reads |
| `src/render/` | three.js road geometry |
| `src/app/` | Fixed-timestep loop, input, HUD |
| `tools/` | `dump-level.ts`, `analyse-bits.ts`, `verify-electron-server.cjs`, `verify-acquire.cjs` |
| `electron/` | Electron shell for a standalone `.exe`: `main.cjs` (app/first-run flow), `server.cjs` (local server routing), `acquire.cjs` (official-release download) |
| `docs/RESEARCH.md` | Formats, constants, licence analysis, prior art |

## Credits and provenance

- *SkyRoads* © Bluemoon Interactive. Programmers: Ahti Heinla, Priit Kasesalu, Jaan Tallinn.
- Simulation ported from [OpenRoads](https://github.com/anprogrammer/OpenRoads) (MIT), itself a
  reconstruction of the DOS original.
- File formats from the [ModdingWiki](https://moddingwiki.shikadi.net/wiki/SkyRoads_level_format)
  and the TASVideos mechanics notes. Note that the wiki's road bitfield table is wrong by four
  bits; see `docs/RESEARCH.md`.

Formats here were implemented from public third-party documentation, not by disassembling the
original executable.

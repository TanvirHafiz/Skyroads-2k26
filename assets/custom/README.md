# Custom backdrops

Drop an image here named `world0.png` through `world9.png` (`.jpg`/`.jpeg`/`.webp` also work) and
it replaces that planet's backdrop — no code changes needed. The game checks here first and only
falls back to the original `WORLD*.LZS` art if nothing matches.

Levels are grouped three to a planet: `world0` covers levels 1–3, `world1` covers 4–6, and so on
up to `world9` for levels 28–30. See `docs/RESEARCH.md` for prompts matched to each planet's
original look, if you want to regenerate them consistently.

Any resolution or aspect ratio works — the backdrop always fills the screen ("cover" sizing), so
an image far from the original's ultra-wide 320×138 band will just get cropped top/bottom or
left/right rather than distorted.

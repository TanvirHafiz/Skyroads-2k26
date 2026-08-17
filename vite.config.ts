import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // assets/original/ is gitignored but must be readable by the dev server so
    // the game can load the player's own SkyRoads data files during development.
    fs: { allow: ['.'] },
    // run.bat is meant to be a full double-click-and-play flow, so launch the
    // default browser automatically rather than making the player find the URL.
    open: true,
  },
  build: {
    target: 'esnext', // WebGPU-era browsers only; no legacy transpilation needed.
  },
});

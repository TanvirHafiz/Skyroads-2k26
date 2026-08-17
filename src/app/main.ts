/**
 * First-playable shell: fixed-timestep simulation decoupled from rendering.
 *
 * The sim advances in whole ticks at exactly SIM_HZ and the renderer
 * interpolates between the last two ship states, so the display refresh rate
 * has no influence whatsoever on the physics. This is the property that lets
 * the remake match the original's feel on any monitor, and that makes replays
 * and ghosts possible later.
 *
 * Visuals here are deliberately plain -- this milestone is about feel.
 */

import * as THREE from 'three';
import { parseRoads, type Level } from '../data/roads.js';
import { SimLevel, ROAD_X_MIN } from '../sim/level.js';
import {
  SIM_DT,
  MAX_Z_VELOCITY,
  TANK_FULL,
  TURN_RATE,
  X_BLOCK,
  Y_BLOCK,
  Y_ROAD_SURFACE,
  ROAD_WIDTH,
} from '../sim/constants.js';
import {
  createSim,
  stepSim,
  ShipState,
  type Controls,
  type ShipSim,
  type ShipState_,
} from '../sim/ship.js';
import { buildRoadMesh, BLOCK_D, BLOCK_H, BLOCK_W, type RoadMesh } from '../render/roadMesh.js';
import { buildShip, SHIP_LIGHT_LAYER } from '../render/ship.js';
import { createPost } from '../render/post.js';
import {
  createBackdrop,
  loadCustomBackdrop,
  textureFromWorldFile,
  worldIndexForLevel,
  type Backdrop,
} from '../render/backdrop.js';
import { createExplosionSystem, type ExplosionSystem } from '../render/explosion.js';
import { createMusicPlayer, songForLevel, type MusicPlayer } from '../audio/music.js';

const ROADS_URL = '/assets/original/ROADS.LZS';

// --- Sim -> render coordinate mapping ----------------------------------------
const CENTRE = ((ROAD_WIDTH - 1) * BLOCK_W) / 2;
// The sim uses the original's x space, where the road spans 95..417 -- not 0.
const toRenderX = (simX: number) => ((simX - ROAD_X_MIN) / X_BLOCK - 0.5) * BLOCK_W - CENTRE;
const toRenderY = (simY: number) => ((simY - Y_ROAD_SURFACE) / Y_BLOCK) * BLOCK_H;
const toRenderZ = (simZ: number) => -simZ * BLOCK_D;

// --- Input -------------------------------------------------------------------
const held = new Set<string>();
addEventListener('keydown', (e) => {
  held.add(e.code);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
    e.preventDefault();
  }
});
addEventListener('keyup', (e) => held.delete(e.code));
addEventListener('blur', () => held.clear());

function readControls(): Controls {
  return {
    accel: (held.has('ArrowUp') ? 1 : 0) - (held.has('ArrowDown') ? 1 : 0),
    turn: (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0),
    jump: held.has('Space'),
  };
}

// --- DOM ---------------------------------------------------------------------
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const boot = $<HTMLDivElement>('#boot');
const hud = $<HTMLDivElement>('#hud');
const help = $<HTMLDivElement>('#help');
const statusEl = $<HTMLDivElement>('#status');
const statusTitle = $<HTMLHeadingElement>('#status h1');
const bars = {
  speed: $<HTMLSpanElement>('#speed .bar > span'),
  oxygen: $<HTMLSpanElement>('#oxygen .bar > span'),
  fuel: $<HTMLSpanElement>('#fuel .bar > span'),
};
const gravValue = $<HTMLElement>('#grav b');
const midiFileInput = $<HTMLInputElement>('#midiFile');

const STATUS_TEXT: Partial<Record<ShipState, string>> = {
  [ShipState.Exploded]: 'DESTROYED',
  [ShipState.OutOfOxygen]: 'OUT OF OXYGEN',
  [ShipState.OutOfFuel]: 'OUT OF FUEL',
  [ShipState.Finished]: 'ROAD COMPLETE',
};

// --- Scene -------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// ACES keeps the bloomed emissive tiles from clipping to flat white.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);
scene.fog = new THREE.Fog(0x05070d, 18, 46);

const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 200);
// The backdrop is parented to the camera (see render/backdrop.ts) so it always
// covers the full frame regardless of FOV or yaw; that only works if the
// camera itself is reachable from the scene root.
scene.add(camera);

scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x101828, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(3, 8, 4);
scene.add(key);

// Starfield, so motion reads even over gaps in the road.
{
  const count = 1500;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 260;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 160;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 260;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8fb6ff, size: 0.35 })));
}

const starship = buildShip();
// The sim gives the ship a 28-unit collision width against 46 units per block,
// so it should sit at roughly 0.6 of a lane. The model is authored at ~2 units
// span for easy editing, hence the scale-down.
starship.group.scale.setScalar(0.42);
scene.add(starship.group);

// Both lights are restricted to the ship's lighting layer, so they can be
// bright enough to model the hull without spilling onto the pale road deck --
// which blooms into a white blob the moment any loose light reaches it.
const shipLight = new THREE.PointLight(0xcfe2ff, 14, 8, 2);
shipLight.layers.set(SHIP_LIGHT_LAYER);
scene.add(shipLight);

const shipRim = new THREE.DirectionalLight(0xff9a6a, 2.2);
shipRim.layers.set(SHIP_LIGHT_LAYER);
scene.add(shipRim);

const backdrop: Backdrop = createBackdrop(camera);
const explosions: ExplosionSystem = createExplosionSystem(scene);

const post = createPost(renderer, scene, camera);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(innerWidth, innerHeight);
});

// --- Game state --------------------------------------------------------------
let levels: Level[] = [];
let levelIndex = 1; // level 0 is the intro demo road
let simLevel: SimLevel;
let roadMesh: RoadMesh | null = null;
let sim: ShipSim;
let ship: ShipState_;
let previous: ShipState_;

// Backdrops are fetched on demand and kept, since revisiting a planet is common.
const worldCache = new Map<number, { texture: THREE.Texture; aspect: number }>();

// A drop-in replacement for a planet's backdrop: assets/custom/world0.png (or
// .jpg/.jpeg/.webp) takes priority over the original WORLD0.LZS if present.
// This is how a player supplies their own art without touching any code.
const CUSTOM_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

async function tryLoadCustomBackdrop(
  world: number,
): Promise<{ texture: THREE.Texture; aspect: number } | null> {
  for (const ext of CUSTOM_EXTENSIONS) {
    const result = await loadCustomBackdrop(`/assets/custom/world${world}.${ext}`);
    if (result) return result;
  }
  return null;
}

async function applyBackdrop(index: number): Promise<void> {
  const world = worldIndexForLevel(index);
  let entry = worldCache.get(world);
  if (!entry) {
    entry = (await tryLoadCustomBackdrop(world)) ?? undefined;
    if (!entry) {
      const res = await fetch(`/assets/original/WORLD${world}.LZS`);
      if (!res.ok) return; // No backdrop is survivable; the level still plays.
      entry = textureFromWorldFile(new Uint8Array(await res.arrayBuffer()));
    }
    worldCache.set(world, entry);
  }
  // The player may have changed level while this was in flight.
  if (worldIndexForLevel(levelIndex) !== world) return;
  backdrop.setImage(entry.texture, entry.aspect);
}

let music: MusicPlayer | null = null;

// A drop-in replacement for the game's own soundtrack: any MIDI file placed
// in music/ (project root) becomes THE game's music -- unlike the per-planet
// MUZAX cycling, this plays continuously across every level, looped. Falls
// back to the original per-level MUZAX song if no file is present or it
// fails to parse. Auto-discovered via import.meta.glob rather than a
// hardcoded filename, so swapping the file just works.
const defaultTrackModules = import.meta.glob('/music/*.{mid,midi}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const defaultTrackUrl = Object.values(defaultTrackModules)[0];
let defaultTrackBytes: Uint8Array | null = null;

function playDefaultOrLevelMusic(index: number): void {
  if (!music) return;
  if (defaultTrackBytes) {
    const ok = music.playMidi(defaultTrackBytes, { loop: true });
    if (ok) return; // fall through to MUZAX only if the custom track failed
  }
  music.play(songForLevel(index, music.songs.length));
}

function loadLevel(index: number): void {
  const level = levels[index];
  if (!level) return;
  levelIndex = index;
  void applyBackdrop(index);
  playDefaultOrLevelMusic(index);

  if (roadMesh) {
    scene.remove(roadMesh.group);
    roadMesh.dispose();
  }
  roadMesh = buildRoadMesh(level);
  scene.add(roadMesh.group);

  // Give each planet its own atmosphere, tinted from its own palette so the
  // fog and sky belong to the road rather than being a fixed grey.
  const tint = level.palette.blockFace(1, 'front');
  const atmosphere = new THREE.Color().setRGB(
    tint.r / 255,
    tint.g / 255,
    tint.b / 255,
    THREE.SRGBColorSpace,
  );
  atmosphere.multiplyScalar(0.16);
  scene.background = atmosphere;
  scene.fog = new THREE.Fog(atmosphere.getHex(), 20, 52);

  simLevel = new SimLevel(level);
  sim = createSim(simLevel);
  ship = sim.ship;
  previous = { ...ship };
  gravValue.textContent = String(level.gravity);
  statusEl.classList.remove('show');
  explosions.clear(); // stop any burst still fading from a previous attempt
}

// --- Loop --------------------------------------------------------------------
let accumulator = 0;
let lastTime = performance.now();

function frame(now: number): void {
  requestAnimationFrame(frame);

  // Clamp so a background tab or a breakpoint cannot spiral the sim.
  const elapsed = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;
  accumulator += elapsed;

  const controls = readControls();
  while (accumulator >= SIM_DT) {
    previous = { ...ship };
    stepSim(sim, simLevel, controls);
    accumulator -= SIM_DT;

    if (sim.events.exploded) {
      explosions.spawn(
        new THREE.Vector3(toRenderX(ship.x), toRenderY(ship.y) + 0.15, toRenderZ(ship.z)),
      );
    }
  }

  explosions.update(elapsed);

  const alpha = accumulator / SIM_DT;
  render(alpha, now / 1000);
  updateHud();
}

function render(alpha: number, time: number): void {
  const lerp = (a: number, b: number) => a + (b - a) * alpha;
  const x = toRenderX(lerp(previous.x, ship.x));
  const y = toRenderY(lerp(previous.y, ship.y));
  const z = toRenderZ(lerp(previous.z, ship.z));

  starship.group.position.set(x, y + 0.1, z);
  starship.group.visible = ship.state !== ShipState.Exploded;

  const speed01 = ship.zVelocity / MAX_Z_VELOCITY;
  starship.setThrust(speed01);
  // Bank into the turn, driven by the sim's own steering term.
  starship.setBank(ship.xMovementBase / TURN_RATE);

  roadMesh?.update(time);

  // Chase camera. FOV widens with speed so acceleration is felt, not just read.
  shipLight.position.set(x + 0.6, y + 0.9, z + 1.0);
  shipRim.position.set(x - 2, y + 0.5, z - 2);
  shipRim.target.position.set(x, y, z);
  shipRim.target.updateMatrixWorld();

  camera.position.set(x * 0.32, y + 1.45, z + 3.1);
  camera.lookAt(x * 0.22, y + 0.16, z - 7);

  const targetFov = 64 + speed01 * 13;
  camera.fov += (targetFov - camera.fov) * 0.08;
  camera.updateProjectionMatrix();

  // Cheap trig; resizes the camera-attached backdrop plane to match the FOV
  // that was just animated, so it keeps covering the full frame exactly.
  backdrop.update();

  post.render();
}

function updateHud(): void {
  bars.speed.style.width = `${(ship.zVelocity / MAX_Z_VELOCITY) * 100}%`;
  bars.oxygen.style.width = `${(ship.oxygen / TANK_FULL) * 100}%`;
  bars.fuel.style.width = `${(ship.fuel / TANK_FULL) * 100}%`;

  const text = STATUS_TEXT[ship.state];
  if (text) {
    statusTitle.textContent = text;
    statusEl.classList.add('show');
  }
}

addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') loadLevel(levelIndex);
  if (e.code === 'BracketRight') loadLevel(Math.min(levelIndex + 1, levels.length - 1));
  if (e.code === 'BracketLeft') loadLevel(Math.max(levelIndex - 1, 0));
  if (e.code === 'KeyM') midiFileInput.click();
});

// Loading a MIDI here via M replaces whatever is currently playing and
// persists until the level changes or restarts, at which point loadLevel's
// playDefaultOrLevelMusic() takes back over -- see loadLevel above.
midiFileInput.addEventListener('change', () => {
  const file = midiFileInput.files?.[0];
  midiFileInput.value = ''; // allow re-selecting the same file later
  if (!file || !music) return;
  void file.arrayBuffer().then((buf) => {
    const ok = music!.playMidi(new Uint8Array(buf));
    if (!ok) alert(`Could not read "${file.name}" as a MIDI file.`);
  });
});

// --- Boot --------------------------------------------------------------------
async function main(): Promise<void> {
  let file: Uint8Array;
  try {
    const res = await fetch(ROADS_URL);
    if (!res.ok) throw new Error(String(res.status));
    file = new Uint8Array(await res.arrayBuffer());
  } catch {
    boot.innerHTML =
      `Could not load <code>${ROADS_URL}</code>.<br><br>` +
      `SkyRoads HD reads the original road data from your own copy of the game.<br>` +
      `Place the original files in <code>assets/original/</code> — see the README.`;
    return;
  }

  levels = parseRoads(file).levels;

  // Music is optional: a failure here must not stop the game from running.
  try {
    music = await createMusicPlayer('/assets/original/MUZAX.LZS');
  } catch (err) {
    console.warn('Music unavailable:', err);
  }

  if (defaultTrackUrl) {
    try {
      const res = await fetch(defaultTrackUrl);
      if (res.ok) defaultTrackBytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      console.warn('Default MIDI track failed to load:', err);
    }
  }

  loadLevel(levelIndex);

  boot.remove();
  hud.hidden = false;
  help.hidden = false;

  if (import.meta.env.DEV) {
    // Dev-only handle for inspecting scene state from the console.
    (globalThis as Record<string, unknown>).__skyroads = {
      scene,
      camera,
      backdrop,
      starship,
      explosions,
      music,
      THREE,
      workletUrl: new URL('../audio/fm-processor.js', import.meta.url).href,
      defaultTrackUrl,
      get defaultTrackBytes() {
        return defaultTrackBytes;
      },
      get ship() {
        return ship;
      },
      get level() {
        return levels[levelIndex];
      },
      loadLevel,
    };
  }

  requestAnimationFrame(frame);
}

void main();

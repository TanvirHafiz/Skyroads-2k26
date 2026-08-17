/**
 * Builds the road geometry for a level, coloured from its own VGA palette.
 *
 * Each level ships 72 palette entries giving every block colour four shaded
 * faces (top / front / right / left). Using them directly is what gives each
 * planet its identity, and it preserves the original's colour-coding contract
 * for free: behaviour and colour come from the same index, so a boost pad is
 * still unmistakably a boost pad.
 *
 * Blocks are bucketed by colour index, so a level costs ~15 draw calls no
 * matter how long the road is.
 */

import * as THREE from 'three';
import { TileBehaviour, behaviourForColour, type Palette, type Rgb } from '../data/palette.js';
import { ROAD_WIDTH, type Level } from '../data/roads.js';

/** Render-space block size. A road cell is square in plan; height is 20/46. */
export const BLOCK_W = 1;
export const BLOCK_D = 1;
export const BLOCK_H = 20 / 46;

/**
 * Emissive strength per behaviour -- this is what makes specials pop.
 * Kept below 1.0 even for the brightest tiles: at 1.15 base with the pulse's
 * 1.2x peak, a burning row or a boost cluster (several adjacent instances,
 * common in the level data) pushed well past the bloom threshold everywhere
 * at once and washed out the road underneath it.
 */
const EMISSIVE: Record<TileBehaviour, number> = {
  [TileBehaviour.Normal]: 0.08,
  [TileBehaviour.Sticky]: 0.05,
  [TileBehaviour.Slippery]: 0.12,
  [TileBehaviour.Supplies]: 0.55,
  [TileBehaviour.Boost]: 0.5,
  [TileBehaviour.Burning]: 0.7,
};

const ROUGHNESS: Record<TileBehaviour, number> = {
  [TileBehaviour.Normal]: 0.55,
  [TileBehaviour.Sticky]: 0.92, // matte, visibly draggy
  [TileBehaviour.Slippery]: 0.06, // wet sheen
  [TileBehaviour.Supplies]: 0.4,
  [TileBehaviour.Boost]: 0.4,
  [TileBehaviour.Burning]: 0.7,
};

const METALNESS: Record<TileBehaviour, number> = {
  [TileBehaviour.Normal]: 0.1,
  [TileBehaviour.Sticky]: 0.0,
  [TileBehaviour.Slippery]: 0.85,
  [TileBehaviour.Supplies]: 0.2,
  [TileBehaviour.Boost]: 0.2,
  [TileBehaviour.Burning]: 0.1,
};

const toColor = (c: Rgb): THREE.Color =>
  new THREE.Color().setRGB(c.r / 255, c.g / 255, c.b / 255, THREE.SRGBColorSpace);

export interface RoadMesh {
  group: THREE.Group;
  /** Animates pulsing surfaces. `time` is seconds. */
  update(time: number): void;
  dispose(): void;
}

export function buildRoadMesh(level: Level): RoadMesh {
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];
  const pulsing: Array<{ mats: THREE.MeshStandardMaterial[]; base: number; rate: number }> = [];

  const palette: Palette = level.palette;
  const centreOffset = ((ROAD_WIDTH - 1) * BLOCK_W) / 2;

  /**
   * Six materials in BoxGeometry group order: +x, -x, +y, -y, +z, -z.
   * The palette gives us right / left / top / front; the underside and back
   * reuse the front shade since they are barely ever seen.
   */
  function faceMaterials(colour: number, behaviour: TileBehaviour): THREE.MeshStandardMaterial[] {
    const make = (rgb: Rgb) => {
      const color = toColor(rgb);
      const m = new THREE.MeshStandardMaterial({
        color,
        roughness: ROUGHNESS[behaviour],
        metalness: METALNESS[behaviour],
        emissive: color.clone().multiplyScalar(EMISSIVE[behaviour]),
      });
      disposables.push(m);
      return m;
    };
    const right = make(palette.blockFace(colour, 'right'));
    const left = make(palette.blockFace(colour, 'left'));
    const top = make(palette.blockFace(colour, 'top'));
    const front = make(palette.blockFace(colour, 'front'));
    return [right, left, top, front, front, front];
  }

  // --- Bucket cells ----------------------------------------------------------
  const deckByColour = new Map<number, Array<{ col: number; row: number }>>();
  const cubes: Array<{ col: number; row: number; colour: number; full: boolean }> = [];
  const tunnels: Array<{ col: number; row: number }> = [];

  for (let row = 0; row < level.rows; row++) {
    for (let col = 0; col < ROAD_WIDTH; col++) {
      const cell = level.cells[row * ROAD_WIDTH + col];
      if (!cell) continue;

      if (cell.bottomColour !== 0) {
        let list = deckByColour.get(cell.bottomColour);
        if (!list) deckByColour.set(cell.bottomColour, (list = []));
        list.push({ col, row });
      }
      if (cell.isTunnel) {
        // Only tube cells that actually have deck beneath them. The tunnel bit
        // also appears over gaps at the road's edges, and drawing a fly-through
        // tube where there is no road to fly on reads as floating debris.
        // ASSUMPTION: unverified against the original renderer.
        if (cell.bottomColour !== 0) tunnels.push({ col, row });
      } else if (cell.hasFullTopBlock || cell.hasHalfTopBlock) {
        cubes.push({
          col,
          row,
          colour: cell.topColour || 1,
          full: cell.hasFullTopBlock,
        });
      }
    }
  }

  const dummy = new THREE.Object3D();
  const place = (mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sy = 1) => {
    dummy.position.set(x, y, z);
    dummy.scale.set(1, sy, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  };

  // --- Road deck -------------------------------------------------------------
  const deckGeom = new THREE.BoxGeometry(BLOCK_W, BLOCK_H, BLOCK_D);
  disposables.push(deckGeom);

  for (const [colour, cells] of deckByColour) {
    const behaviour = behaviourForColour(colour);
    const mats = faceMaterials(colour, behaviour);
    const mesh = new THREE.InstancedMesh(deckGeom, mats, cells.length);
    cells.forEach((c, i) => {
      place(mesh, i, c.col * BLOCK_W - centreOffset, -BLOCK_H / 2, -c.row * BLOCK_D);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    group.add(mesh);

    if (behaviour === TileBehaviour.Burning) {
      pulsing.push({ mats, base: EMISSIVE[behaviour], rate: 7 });
    } else if (behaviour === TileBehaviour.Supplies) {
      pulsing.push({ mats, base: EMISSIVE[behaviour], rate: 2.6 });
    }
  }

  // --- Raised blocks ---------------------------------------------------------
  if (cubes.length > 0) {
    // Unit-height box anchored at its base, scaled per instance.
    const cubeGeom = new THREE.BoxGeometry(BLOCK_W, 1, BLOCK_D).translate(0, 0.5, 0);
    disposables.push(cubeGeom);

    const byColour = new Map<number, typeof cubes>();
    for (const c of cubes) {
      let list = byColour.get(c.colour);
      if (!list) byColour.set(c.colour, (list = []));
      list.push(c);
    }

    for (const [colour, list] of byColour) {
      const behaviour = behaviourForColour(colour);
      const mats = faceMaterials(colour, behaviour);
      const mesh = new THREE.InstancedMesh(cubeGeom, mats, list.length);
      list.forEach((c, i) => {
        // Half blocks rise one block height, full blocks two.
        const h = (c.full ? 2 : 1) * BLOCK_H;
        place(mesh, i, c.col * BLOCK_W - centreOffset, 0, -c.row * BLOCK_D, h);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  }

  // --- Tunnels ---------------------------------------------------------------
  // Rendered as an open tube seen from the inside, using the level's dedicated
  // tunnel palette entries.
  if (tunnels.length > 0) {
    const tunnelGeom = new THREE.CylinderGeometry(0.5, 0.5, BLOCK_D, 18, 1, true);
    disposables.push(tunnelGeom);
    const tunnelColor = toColor(palette.tunnelInterior());
    const tunnelMat = new THREE.MeshStandardMaterial({
      color: tunnelColor,
      emissive: tunnelColor.clone().multiplyScalar(0.35),
      roughness: 0.5,
      metalness: 0.5,
      // DoubleSide so the tube reads as a ring structure from outside too;
      // BackSide alone shows only the far wall and looks like a floating lens.
      side: THREE.DoubleSide,
    });
    disposables.push(tunnelMat);

    const mesh = new THREE.InstancedMesh(tunnelGeom, tunnelMat, tunnels.length);
    tunnels.forEach((t, i) => {
      dummy.position.set(t.col * BLOCK_W - centreOffset, 0.34, -t.row * BLOCK_D);
      dummy.rotation.set(Math.PI / 2, 0, 0); // align the tube along Z
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    dummy.rotation.set(0, 0, 0);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  return {
    group,
    update(time: number) {
      for (const p of pulsing) {
        const k = p.base * (0.75 + 0.45 * Math.sin(time * p.rate));
        for (const m of p.mats) m.emissive.copy(m.color).multiplyScalar(k);
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

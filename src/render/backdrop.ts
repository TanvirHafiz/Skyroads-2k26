/**
 * Planet backdrops, drawn behind each level.
 *
 * The originals (WORLD0-9.LZS) are 320x138 painted VGA images -- the sky band
 * the DOS renderer drew as a fixed 2D backdrop behind the 3D road, not an
 * object sitting in the scene.
 *
 * The first version of this parked a plane out in world space in front of the
 * camera. That is wrong for a backdrop: as soon as the camera's FOV pulses
 * with speed or its yaw shifts with steering, a fixed-size world-space plane
 * stops covering the full frame and you see its edges floating against the
 * scene background colour -- exactly the "floating plane" artifact.
 *
 * Fixed by parenting the plane to the camera itself and resizing it every
 * frame from the camera's current FOV and aspect so it always exactly covers
 * the frustum, like a skybox. Being camera-attached, it cannot show an edge
 * regardless of how the camera turns, and carries no parallax of its own --
 * it reads as a true fixed backdrop rather than a floating object.
 */

import * as THREE from 'three';
import { parseImage, toRgba } from '../data/image.js';

/** How far ahead of the camera (in camera space) the backdrop plane sits. */
const DISTANCE = 70;
/** Extra size margin so a resize or FOV pulse between updates never reveals an edge. */
const COVER_MARGIN = 1.05;

export interface Backdrop {
  mesh: THREE.Mesh;
  /** Resizes the plane to cover the camera's current FOV/aspect. Cheap; call every frame. */
  update(): void;
  setImage(image: THREE.Texture, aspect: number): void;
  dispose(): void;
}

/**
 * Loads a plain image (PNG/JPG/etc) as a backdrop texture -- the path for a
 * user-supplied replacement, as opposed to decoding the original's WORLDx.LZS.
 * Resolves to null on any load failure (missing file, bad format) so the
 * caller can fall back to the original asset.
 */
export function loadCustomBackdrop(url: string): Promise<{ texture: THREE.Texture; aspect: number } | null> {
  return new Promise((resolve) => {
    new THREE.TextureLoader().load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearFilter;
        const { width, height } = texture.image as { width: number; height: number };
        resolve({ texture, aspect: width / height });
      },
      undefined,
      () => resolve(null),
    );
  });
}

export function textureFromWorldFile(file: Uint8Array): {
  texture: THREE.DataTexture;
  aspect: number;
} {
  const image = parseImage(file);
  const texture = new THREE.DataTexture(toRgba(image), image.width, image.height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  // These are painted gradients rather than blocky sprites, so smoothing them
  // reads better at HD sizes than nearest-neighbour would.
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  texture.flipY = true;
  return { texture, aspect: image.width / image.height };
}

/**
 * Caller must add `camera` to the scene (`scene.add(camera)`) for a
 * camera-parented child to render at all -- three.js only draws what it can
 * reach by traversing from the scene root.
 */
export function createBackdrop(camera: THREE.PerspectiveCamera): Backdrop {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    fog: false,
    depthWrite: false,
    depthTest: false,
    transparent: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.position.set(0, 0, -DISTANCE);
  camera.add(mesh);

  let currentTexture: THREE.Texture | null = null;
  let imageAspect = 1;

  function resize(): void {
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const frustumHeight = 2 * Math.tan(vFov / 2) * DISTANCE * COVER_MARGIN;
    const frustumWidth = frustumHeight * camera.aspect;

    // "Cover" sizing: fit to whichever axis under-covers, so the backdrop is
    // always at least as large as the frustum in both dimensions.
    let width = frustumWidth;
    let height = frustumHeight;
    if (imageAspect > camera.aspect) {
      width = frustumHeight * imageAspect;
    } else {
      height = frustumWidth / imageAspect;
    }
    mesh.scale.set(width, height, 1);
  }

  return {
    mesh,
    setImage(texture: THREE.Texture, aspect: number) {
      currentTexture?.dispose();
      currentTexture = texture;
      imageAspect = aspect;
      material.map = texture;
      material.needsUpdate = true;
      resize();
      mesh.visible = true;
    },
    update: resize,
    dispose() {
      camera.remove(mesh);
      geometry.dispose();
      material.dispose();
      currentTexture?.dispose();
    },
  };
}

/**
 * Roads are grouped three to a planet, so levels 1-3 use WORLD0, 4-6 WORLD1,
 * and so on. The intro demo road uses WORLD0.
 */
export function worldIndexForLevel(levelIndex: number): number {
  if (levelIndex <= 0) return 0;
  return Math.min(9, Math.floor((levelIndex - 1) / 3));
}

/**
 * Post-processing chain.
 *
 * Bloom is doing the heavy lifting for the HD look: the road's special tiles
 * and the ship's exhaust are emissive, so bloom is what turns them from
 * "brightly coloured" into "glowing". Everything else is deliberately light so
 * the road stays readable at speed.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export interface Post {
  render(): void;
  setSize(width: number, height: number): void;
  dispose(): void;
}

export function createPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Post {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(innerWidth, innerHeight),
    0.4, // strength -- was 0.75; levels dense with special tiles (burning rows,
    // supply/boost clusters) stacked enough glow to wash the road out
    0.55, // radius
    0.35, // threshold -- was 0.22; raised so only genuinely emissive tiles catch,
    // not the merely-bright road deck
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  return {
    render: () => composer.render(),
    setSize: (w, h) => {
      composer.setSize(w, h);
      bloom.setSize(w, h);
    },
    dispose: () => composer.dispose(),
  };
}

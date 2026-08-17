/**
 * Explosion effect: fired once when the ship dies (burning tile, hard impact,
 * falling off the road). CPU-driven particle burst plus a brief expanding
 * ring and a point-light flash, all additive so bloom picks them up.
 *
 * Bursts are independent, short-lived objects created on `spawn` and torn
 * down automatically once their fade finishes -- there is no fixed pool,
 * since deaths are infrequent enough that per-event allocation is cheap.
 */

import * as THREE from 'three';

const PARTICLE_COUNT = 46;
const DURATION = 0.8; // seconds
const SPEED = 3.4; // world units/sec, before per-particle randomisation
const GRAVITY = 2.6; // world units/sec^2, downward drift on the debris

const WARM = new THREE.Color(0xff8a3d);
const HOT = new THREE.Color(0xfff2c8);

interface Burst {
  points: THREE.Points;
  velocities: Float32Array;
  ring: THREE.Mesh;
  light: THREE.PointLight;
  age: number;
}

export interface ExplosionSystem {
  spawn(position: THREE.Vector3): void;
  /** Advances all active bursts. `dt` is real elapsed seconds, not sim time. */
  update(dt: number): void;
  /** Removes any bursts still fading, without touching shared resources. Safe to call often (e.g. on level reload). */
  clear(): void;
  /** Full teardown, including geometry shared across every burst. Call once, at app shutdown. */
  dispose(): void;
}

export function createExplosionSystem(scene: THREE.Scene): ExplosionSystem {
  const active: Burst[] = [];

  const ringGeometry = new THREE.RingGeometry(0.6, 1, 24);
  const disposables: Array<{ dispose(): void }> = [ringGeometry];

  function spawn(position: THREE.Vector3): void {
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    const velocities = new Float32Array(PARTICLE_COUNT * 3);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3] = position.x;
      positions[i * 3 + 1] = position.y;
      positions[i * 3 + 2] = position.z;

      // Random direction on a sphere, weighted slightly upward so the burst
      // reads as debris kicked off the road rather than a flat disc.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = SPEED * (0.4 + Math.random() * 0.9);
      velocities[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
      velocities[i * 3 + 1] = Math.abs(Math.sin(phi) * Math.sin(theta)) * speed * 0.7 + 0.5;
      velocities[i * 3 + 2] = Math.cos(phi) * speed;

      const c = WARM.clone().lerp(HOT, Math.random());
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.22,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd08a,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.copy(position);
    ring.scale.setScalar(0.15);
    ring.frustumCulled = false;
    scene.add(ring);

    const light = new THREE.PointLight(0xffb454, 9, 7, 2);
    light.position.copy(position);
    scene.add(light);

    active.push({ points, velocities, ring, light, age: 0 });
  }

  function update(dt: number): void {
    for (let i = active.length - 1; i >= 0; i--) {
      const b = active[i]!;
      b.age += dt;
      const t = b.age / DURATION;

      if (t >= 1) {
        scene.remove(b.points, b.ring, b.light);
        b.points.geometry.dispose();
        (b.points.material as THREE.Material).dispose();
        (b.ring.material as THREE.Material).dispose();
        active.splice(i, 1);
        continue;
      }

      const pos = b.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let p = 0; p < PARTICLE_COUNT; p++) {
        b.velocities[p * 3 + 1]! -= GRAVITY * dt;
        pos.setX(p, pos.getX(p) + b.velocities[p * 3]! * dt);
        pos.setY(p, pos.getY(p) + b.velocities[p * 3 + 1]! * dt);
        pos.setZ(p, pos.getZ(p) + b.velocities[p * 3 + 2]! * dt);
      }
      pos.needsUpdate = true;

      const mat = b.points.material as THREE.PointsMaterial;
      mat.opacity = 1 - t * t;

      // RingGeometry already lies flat in the XY plane, facing +Z -- which is
      // approximately toward the camera given how little the chase camera
      // yaws -- so no extra orientation is needed here.
      const ringMat = b.ring.material as THREE.MeshBasicMaterial;
      b.ring.scale.setScalar(0.15 + t * 3.2);
      ringMat.opacity = 0.9 * (1 - t);

      b.light.intensity = 9 * (1 - t) * (1 - t);
    }
  }

  function clear(): void {
    for (const b of active) {
      scene.remove(b.points, b.ring, b.light);
      b.points.geometry.dispose();
      (b.points.material as THREE.Material).dispose();
      (b.ring.material as THREE.Material).dispose();
    }
    active.length = 0;
  }

  function dispose(): void {
    clear();
    for (const d of disposables) d.dispose();
  }

  return { spawn, update, clear, dispose };
}

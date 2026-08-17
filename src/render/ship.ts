/**
 * The player's starship, assembled from primitive geometry.
 *
 * Layout follows the classic "cylinder fuselage + delta wing + outboard
 * nacelles" silhouette: a banded central hull with a long nose cone, a dorsal
 * sensor dome, a swept delta wing, and two engine pods on the wingtips. The
 * ship noses toward -Z because the road recedes in that direction.
 *
 * Everything is built from three.js primitives -- no external assets -- so the
 * whole thing stays self-contained and cheap to tweak.
 */

import * as THREE from 'three';

const HULL = 0xc9d4e4;
const HULL_DARK = 0x8b97ab;
const ACCENT = 0xd2703a;
const TRIM = 0x2f3a4d;
const GLOW = 0x5fd8ff;

/** Lighting layer reserved for the ship; see the note in buildShip. */
export const SHIP_LIGHT_LAYER = 1;

export interface Starship {
  group: THREE.Group;
  /** 0..1 -- scales exhaust length and brightness with throttle. */
  setThrust(amount: number): void;
  /** Banks the ship into turns; input is roughly -1..1. */
  setBank(amount: number): void;
  dispose(): void;
}

export function buildShip(): Starship {
  const group = new THREE.Group();
  const body = new THREE.Group(); // banked separately from the group itself
  group.add(body);

  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends THREE.BufferGeometry | THREE.Material>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const hullMat = track(
    new THREE.MeshStandardMaterial({ color: HULL, roughness: 0.34, metalness: 0.72 }),
  );
  const hullDarkMat = track(
    new THREE.MeshStandardMaterial({ color: HULL_DARK, roughness: 0.45, metalness: 0.65 }),
  );
  const accentMat = track(
    new THREE.MeshStandardMaterial({
      color: ACCENT,
      roughness: 0.5,
      metalness: 0.3,
      emissive: new THREE.Color(ACCENT).multiplyScalar(0.25),
    }),
  );
  const trimMat = track(
    new THREE.MeshStandardMaterial({ color: TRIM, roughness: 0.6, metalness: 0.4 }),
  );
  const glassMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x7fe4ff,
      roughness: 0.1,
      metalness: 0.2,
      emissive: new THREE.Color(GLOW).multiplyScalar(0.6),
    }),
  );

  // Exhaust glow is additive so it blooms rather than shading.
  const glowMat = track(
    new THREE.MeshBasicMaterial({
      color: GLOW,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );

  const cylinder = (rt: number, rb: number, h: number, seg = 16) =>
    track(new THREE.CylinderGeometry(rt, rb, h, seg));

  /** Builds a nacelle: pointed nose, tube body, tapered tail, exhaust cone. */
  function nacelle(length: number, radius: number): { group: THREE.Group; flame: THREE.Mesh } {
    const g = new THREE.Group();

    const tube = new THREE.Mesh(cylinder(radius, radius, length), hullMat);
    tube.rotation.x = Math.PI / 2;
    g.add(tube);

    const nose = new THREE.Mesh(cylinder(0.001, radius, length * 0.62), hullDarkMat);
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = -length / 2 - (length * 0.62) / 2;
    g.add(nose);

    const tail = new THREE.Mesh(cylinder(radius * 0.72, radius, length * 0.22), trimMat);
    tail.rotation.x = Math.PI / 2;
    tail.position.z = length / 2 + (length * 0.22) / 2;
    g.add(tail);

    const band = new THREE.Mesh(cylinder(radius * 1.06, radius * 1.06, length * 0.07), accentMat);
    band.rotation.x = Math.PI / 2;
    band.position.z = -length * 0.18;
    g.add(band);

    const flame = new THREE.Mesh(cylinder(0.001, radius * 0.78, 0.5, 12), glowMat);
    flame.rotation.x = -Math.PI / 2;
    flame.position.z = length / 2 + 0.3;
    g.add(flame);

    return { group: g, flame };
  }

  // --- Central fuselage ------------------------------------------------------
  const HULL_LEN = 1.15;
  const HULL_R = 0.135;

  const hull = new THREE.Mesh(cylinder(HULL_R, HULL_R, HULL_LEN, 20), hullMat);
  hull.rotation.x = Math.PI / 2;
  body.add(hull);

  const nose = new THREE.Mesh(cylinder(0.001, HULL_R, 0.66, 20), hullMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -HULL_LEN / 2 - 0.33;
  body.add(nose);

  const noseTip = new THREE.Mesh(track(new THREE.SphereGeometry(0.028, 10, 8)), accentMat);
  noseTip.position.z = -HULL_LEN / 2 - 0.65;
  body.add(noseTip);

  for (const z of [-0.34, 0.06, 0.4]) {
    const band = new THREE.Mesh(cylinder(HULL_R * 1.05, HULL_R * 1.05, 0.035, 20), accentMat);
    band.rotation.x = Math.PI / 2;
    band.position.z = z;
    body.add(band);
  }

  // Tail section and main exhaust.
  const tailCone = new THREE.Mesh(cylinder(HULL_R * 0.8, HULL_R, 0.2, 20), trimMat);
  tailCone.rotation.x = Math.PI / 2;
  tailCone.position.z = HULL_LEN / 2 + 0.1;
  body.add(tailCone);

  const mainFlame = new THREE.Mesh(cylinder(0.001, HULL_R * 0.85, 0.75, 16), glowMat);
  mainFlame.rotation.x = -Math.PI / 2;
  mainFlame.position.z = HULL_LEN / 2 + 0.55;
  body.add(mainFlame);

  // --- Dorsal dome and cockpit ----------------------------------------------
  const domeBase = new THREE.Mesh(cylinder(0.115, 0.13, 0.06, 18), hullDarkMat);
  domeBase.position.set(0, HULL_R * 0.85, -0.12);
  body.add(domeBase);

  const dome = new THREE.Mesh(
    track(new THREE.SphereGeometry(0.105, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2)),
    glassMat,
  );
  dome.position.set(0, HULL_R * 0.85 + 0.03, -0.12);
  body.add(dome);

  // Ventral fin.
  const ventral = new THREE.Mesh(cylinder(0.05, 0.075, 0.16, 12), hullDarkMat);
  ventral.rotation.x = Math.PI;
  ventral.position.set(0, -HULL_R - 0.06, -0.1);
  body.add(ventral);

  // --- Delta wing ------------------------------------------------------------
  // A swept triangle: apex forward on the centreline, trailing edge at the back.
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, -0.62); // apex, forward
  wingShape.lineTo(0.95, 0.5); // right trailing tip
  wingShape.lineTo(-0.95, 0.5); // left trailing tip
  wingShape.closePath();

  const wingGeom = track(
    new THREE.ExtrudeGeometry(wingShape, { depth: 0.035, bevelEnabled: false }),
  );
  const wing = new THREE.Mesh(wingGeom, hullDarkMat);
  // Extrusion runs along +Z; lay it flat so thickness becomes vertical.
  wing.rotation.x = Math.PI / 2;
  wing.position.set(0, -0.018, 0.12);
  body.add(wing);

  // Wing root strakes for a bit of surface interest.
  for (const side of [-1, 1]) {
    const strake = new THREE.Mesh(track(new THREE.BoxGeometry(0.06, 0.05, 0.5)), trimMat);
    strake.position.set(side * 0.26, 0.02, 0.16);
    body.add(strake);
  }

  // --- Wingtip nacelles ------------------------------------------------------
  const flames: THREE.Mesh[] = [mainFlame];
  for (const side of [-1, 1]) {
    const { group: pod, flame } = nacelle(0.62, 0.078);
    pod.position.set(side * 0.72, 0.0, 0.16);
    body.add(pod);
    flames.push(flame);
  }

  // Point lights would be per-ship overkill; the additive cones plus bloom read
  // as thrust well enough and cost nothing.
  const baseScales = flames.map((f) => f.scale.z);

  // Layer 1 is the ship's private lighting layer: a light set to layer 1 lights
  // the hull without spilling onto the pale road deck, which blooms far too
  // easily. Layer 0 stays enabled so the camera still draws it normally.
  group.traverse((o) => o.layers.enable(SHIP_LIGHT_LAYER));

  return {
    group,
    setThrust(amount: number) {
      const t = Math.max(0, Math.min(1, amount));
      flames.forEach((f, i) => {
        f.scale.z = (baseScales[i] ?? 1) * (0.25 + t * 1.5);
        (f.material as THREE.MeshBasicMaterial).opacity = 0.35 + t * 0.55;
        f.visible = t > 0.02;
      });
    },
    setBank(amount: number) {
      const target = -amount * 0.5;
      body.rotation.z += (target - body.rotation.z) * 0.15;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Lamps, LAMP_HEIGHT } from '../src/client/world/lamps.ts';
import { Lights } from '../src/client/state/lights.ts';
import type { Light } from '../src/client/state/lights.ts';
import { TILE, LAMP_SEATS, ZONE_SPOTS, deckTop, lampSpot, zoneSlot } from '../src/shared/layout.ts';

/**
 * Reading a lamp's name by hovering over it.
 *
 * The name is not in the scene: it can only be read by pointing at the lamp.
 * If the pointing is wrong, that name can no longer be read anywhere.
 */

const W = 1400;
const H = 900;
/** A three-deck zone, its root on the top deck wherever it happens to be: the lamp stands on it. */
const ZONE = { root: new THREE.Vector3(30, deckTop(3), -20) };
const zoneOf = (): typeof ZONE => ZONE;

/** One lit lamp, and where its head really is. */
function oneLamp(): { lamps: Lamps; head: THREE.Vector3 } {
  const lights = new Lights(() => LAMP_SEATS, () => 1000);
  lights.light({
    id: 'tool:a', kind: 'tool', sessionId: 's1', projectId: 'p1',
    provider: 'claude', name: 'Bash', bornAt: 1000,
  });
  const lamps = new Lamps();
  lamps.setLights(lights.values(), zoneOf, 1000);

  const spot = lampSpot(lights.get('tool:a')!.slot);
  return {
    lamps,
    head: new THREE.Vector3(ZONE.root.x + spot.x, ZONE.root.y + LAMP_HEIGHT, ZONE.root.z + spot.z),
  };
}

/** The direction it is looked at from: from the side and a little above, as one looks at a square. */
const FROM = new THREE.Vector3(0.6, 0.35, 1).normalize();

/** A camera in front of the lamp's head, at this distance, looking straight at it. */
function cameraFacing(head: THREE.Vector3, distance: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(52, W / H, 0.5, 4000);
  camera.position.copy(head).addScaledVector(FROM, distance);
  camera.lookAt(head);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

test('pointing at a lamp reads out its work', () => {
  const { lamps, head } = oneLamp();
  const camera = cameraFacing(head, 40);
  const light = lamps.pick(W / 2, H / 2, camera, W, H);
  assert.equal(light?.id, 'tool:a');
  assert.equal(light?.name, 'Bash');
});

test('far from the lamp nothing is read', () => {
  const { lamps, head } = oneLamp();
  const camera = cameraFacing(head, 40);
  assert.equal(lamps.pick(W / 2 + 300, H / 2, camera, W, H), null);
});

test('a distant lamp, a few pixels wide, is picked even without hitting it dead centre', () => {
  const { lamps, head } = oneLamp();
  const camera = cameraFacing(head, 700);
  assert.ok(lamps.pick(W / 2 + 8, H / 2, camera, W, H), 'it has to be hit to the pixel');
  assert.equal(lamps.pick(W / 2 + 30, H / 2, camera, W, H), null, 'margin too wide');
});

test('a lamp behind the camera is not picked', () => {
  // Projected from behind, a point flips its signs and can land right in the
  // centre of the screen: without the check you would read the name of a
  // lamp that cannot be seen.
  const { lamps, head } = oneLamp();
  const camera = new THREE.PerspectiveCamera(52, W / H, 0.5, 4000);
  camera.position.copy(head).addScaledVector(FROM, 40);
  camera.lookAt(camera.position.clone().addScaledVector(FROM, 10));
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  assert.equal(lamps.pick(W / 2, H / 2, camera, W, H), null);
});

test('a lamp stands on the edge of its lot, never on a pad', () => {
  // The place is decided by `lampSpot`, on the kerb strip: where the lamp is
  // read is where the lot is read, and no building stands on it.
  const light: Light = {
    id: 'agent:x', kind: 'subagent', sessionId: 's1', projectId: 'p1',
    provider: 'claude', name: 'Explore', bornAt: 1000, litAt: 1000, endedAt: null, slot: 3,
  };
  const lamps = new Lamps();
  lamps.setLights([light], zoneOf, 1000);

  const mesh = lamps.object3d.children[0] as THREE.InstancedMesh;
  assert.equal(mesh.count, 1);
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(0, m);
  const at = new THREE.Vector3().setFromMatrixPosition(m);

  const spot = lampSpot(3);
  // A tolerance and not an equality: the instance buffer is float32 by
  // construction, so a position read back through it is rounded.
  // Its foot on the top deck, where the root is. It used to add the deck
  // height on top of a root already at deck height, and every lamp stood a
  // plate's thickness in the air.
  const want = [ZONE.root.x + spot.x, ZONE.root.y, ZONE.root.z + spot.z];
  at.toArray().forEach((v, k) => {
    assert.ok(Math.abs(v - want[k]!) < 1e-4, `component ${k}: ${v} instead of ${want[k]}`);
  });

  // Inside the tile, and away from every pad: a lamp planted on a building
  // would not be seen, and neither would a building with a pole through it.
  assert.ok(Math.hypot(spot.x, spot.z) <= TILE, 'the lamp is outside its tile');
  for (let k = 0; k < ZONE_SPOTS; k++) {
    const b = zoneSlot(k);
    assert.ok(Math.hypot(spot.x - b.x, spot.z - b.z) > 1.5, `the lamp stands on pad ${k}`);
  }
  lamps.dispose();
});

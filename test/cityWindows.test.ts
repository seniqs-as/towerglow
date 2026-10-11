import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Windows } from '../src/client/city/windows.ts';
import { Lights } from '../src/client/state/lights.ts';
import { floorsForSize, windowCell, windowPlacement } from '../src/client/city/layout.ts';

/**
 * Reading a window's name by hovering over it.
 *
 * The name no longer lives on stage: it is read only by pointing at the
 * window. If the picking is wrong, that name can no longer be read anywhere.
 */

const W = 1400;
const H = 900;
const SIZE = 200;
const building = () => ({ position: new THREE.Vector3(30, 0, -20), height: 40, footprint: 12, size: SIZE });

/** A lit window, and where it really stands on the facade. */
function oneWindow(): { windows: Windows; center: THREE.Vector3; normal: THREE.Vector3 } {
  const lights = new Lights(() => 64, () => 1000);
  lights.light({
    id: 'tool:a', kind: 'tool', sessionId: 's1', projectId: 'p1',
    provider: 'claude', name: 'Bash', bornAt: 1000,
  });
  const windows = new Windows();
  windows.setLights(lights.values(), building);

  const m = building();
  const floors = floorsForSize(SIZE);
  const { floor, col } = windowCell(lights.get('tool:a')!.slot, floors);
  const p = windowPlacement(floor, col, floors, m.footprint, m.height);
  return {
    windows,
    center: new THREE.Vector3(m.position.x + p.x, p.y, m.position.z + p.z),
    normal: new THREE.Vector3(p.nx, 0, p.nz),
  };
}

/** A camera facing the window straight on, at this distance. */
function cameraFacing(center: THREE.Vector3, normal: THREE.Vector3, distance: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(52, W / H, 0.5, 4000);
  camera.position.copy(center).addScaledVector(normal, distance);
  camera.lookAt(center);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

test('pointing at a window reads the work inside it', () => {
  const { windows, center, normal } = oneWindow();
  const camera = cameraFacing(center, normal, 40);
  const light = windows.pick(W / 2, H / 2, camera, W, H);
  assert.equal(light?.id, 'tool:a');
  assert.equal(light?.name, 'Bash');
});

test('far from the window nothing is read', () => {
  const { windows, center, normal } = oneWindow();
  const camera = cameraFacing(center, normal, 40);
  assert.equal(windows.pick(W / 2 + 300, H / 2, camera, W, H), null);
});

test('a distant window, a few pixels wide, is picked without centering it', () => {
  const { windows, center, normal } = oneWindow();
  const camera = cameraFacing(center, normal, 700);
  assert.ok(windows.pick(W / 2 + 8, H / 2, camera, W, H), 'should not need pixel-perfect centering');
  assert.equal(windows.pick(W / 2 + 30, H / 2, camera, W, H), null, 'margin too wide');
});

test('a window behind the camera is not picked', () => {
  // Projected from behind, a point flips its signs and can land right at
  // the center of the screen: without the check, the name of a window that
  // is not visible would be read.
  const { windows, center, normal } = oneWindow();
  const camera = new THREE.PerspectiveCamera(52, W / H, 0.5, 4000);
  camera.position.copy(center).addScaledVector(normal, 40);
  camera.lookAt(camera.position.clone().addScaledVector(normal, 10));
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  assert.equal(windows.pick(W / 2, H / 2, camera, W, H), null);
});

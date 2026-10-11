import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Labels } from '../src/client/ui/labels.ts';
import type { LabelItem } from '../src/client/ui/labels.ts';

/**
 * The names over the towers flickered while the view turned, at 60 fps.
 *
 * Seen on 2026-09-28 in the browser: twelve seconds of rotation turned the
 * name of one tower on and off fifty times, and its neighbour's seventeen. A
 * hidden node has no box, so a hidden name was tested at a guessed 90 px,
 * fitted, was shown, measured its real width on the next frame, overlapped
 * and hid again; and a hidden name was tested on every frame, not only at a
 * decision. Under a software renderer every frame is a decision and none of
 * this shows: it takes the real frame rate, so the test steps one.
 *
 * The page is the smallest one that behaves like a browser where it matters:
 * a node with the `hidden` attribute measures 0 by 0.
 */

const CHAR_W = 7.2;

class FakeNode {
  hidden = false;
  textContent = '';
  className = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = { add: () => {} };
  addEventListener(): void {}
  remove(): void {}
  get offsetWidth(): number {
    return this.hidden ? 0 : Math.round(this.textContent.length * CHAR_W + 14);
  }
  get offsetHeight(): number {
    return this.hidden ? 0 : 18;
  }
}

function page(): { root: FakeNode & { appendChild(n: FakeNode): void }; nodes: FakeNode[] } {
  const nodes: FakeNode[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g['document'] = { createElement: () => new FakeNode() };
  g['window'] = { innerWidth: 1400, innerHeight: 900 };
  const root = Object.assign(new FakeNode(), { appendChild: (n: FakeNode) => void nodes.push(n) });
  return { root, nodes };
}

/** A small city at a pitch of 48, towers of different heights, as on the user's screen. */
function city(): LabelItem[] {
  const plate = (id: string, text: string, x: number, z: number, height: number): LabelItem => ({
    id, text, kind: 'project', position: new THREE.Vector3(x, 0, z), offsetY: height + 4, priority: 3,
  });
  return [
    plate('a', 'SENIQS NEW WEBSITE', 48, 48, 20),
    plate('b', 'AINT_CLEAN', 96, 0, 16),
    plate('c', 'TOWER_DEFENSE', -48, -48, 45),
    plate('d', 'ALV', 0, -48, 60),
    plate('e', 'DECSIM2', 0, 0, 60),
    plate('f', 'VISIBILITYCHECK', 48, -96, 70),
    plate('g', 'MY_DASHBOARD', 48, 0, 55),
    plate('h', 'RPG', 96, -48, 72),
  ];
}

test('turning the view at 60 fps, a name changes state only when its tower really hides it', () => {
  const { root, nodes } = page();
  const camera = new THREE.PerspectiveCamera(45, 1400 / 900, 1, 2000);
  const labels = new Labels(root as unknown as HTMLElement, camera);
  labels.set(city());

  const flips = new Map<FakeNode, number>();
  const last = new Map<FakeNode, boolean>();
  const dt = 1 / 60;
  for (let frame = 0; frame < 12 * 60; frame++) {
    const t = frame * dt;
    // A full turn in twelve seconds, with the wobble of a hand on a mouse.
    const a = (t / 12) * Math.PI * 2 + Math.sin(t * 9) * 0.01;
    camera.position.set(24 + Math.cos(a) * 300, 110, -24 + Math.sin(a) * 300);
    camera.lookAt(24, 30, -24);
    camera.updateMatrixWorld();
    labels.update(dt);
    for (const node of nodes) {
      if (last.has(node) && last.get(node) !== node.hidden) flips.set(node, (flips.get(node) ?? 0) + 1);
      last.set(node, node.hidden);
    }
  }
  for (const node of nodes) {
    // Around a full turn a name passes behind its neighbours two or three
    // times, and each crossing is one hide and one show. Before, the busiest
    // name here went on and off fourteen times.
    assert.ok((flips.get(node) ?? 0) <= 6, `"${node.textContent}" went on and off ${flips.get(node)} times`);
  }
  delete (globalThis as Record<string, unknown>)['document'];
  delete (globalThis as Record<string, unknown>)['window'];
});

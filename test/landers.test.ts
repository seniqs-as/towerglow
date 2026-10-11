import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  Landers, HOVER_HEIGHT, ENTRY_HEIGHT, DESCEND_S, LIFT_S, MIN_HOVER_S, VISIT_S, summonsLander,
} from '../src/client/world/landers.ts';
import type { DeltaEvent } from '../src/shared/protocol.ts';

const DT = 1 / 30;

/** Step the landers for `seconds` on a clock that starts where the last run stopped. */
function fly(l: Landers, seconds: number, clock: { t: number }): void {
  for (let s = 0; s < seconds; s += DT) {
    clock.t += DT;
    l.update(DT, clock.t);
  }
}

/** Step until the first lander is in `phase`, or give up after `max` seconds; returns the seconds it took. */
function flyUntil(l: Landers, phase: string, clock: { t: number }, max = 60): number {
  const start = clock.t;
  while (l.inspect()[0]?.phase !== phase && clock.t - start < max) {
    clock.t += DT;
    l.update(DT, clock.t);
  }
  return clock.t - start;
}

test('a skill brings a lander down out of the sky to hover over the habitat', () => {
  const summit = new THREE.Vector3(12, 3.2, -8);
  const clock = { t: 0 };
  const l = new Landers({ clock: () => clock.t * 1000 });
  l.set(['p1'], (id) => (id === 'p1' ? summit : null));
  l.update(DT, (clock.t += DT));
  const [start] = l.inspect();
  assert.equal(start?.phase, 'descending');
  assert.ok(start!.y > summit.y + ENTRY_HEIGHT - 1, `it enters high: ${start!.y}`);

  fly(l, DESCEND_S + 0.5, clock);
  const [hover] = l.inspect();
  assert.equal(hover?.phase, 'hovering');
  assert.ok(Math.abs(hover!.y - (summit.y + HOVER_HEIGHT)) < 0.2, `holds station over the summit: ${hover!.y}`);
  l.dispose();
});

test('the lander follows a habitat that is still rising', () => {
  const summit = new THREE.Vector3(0, 1, 0);
  const clock = { t: 0 };
  const l = new Landers({ clock: () => clock.t * 1000 });
  l.set(['p1'], () => summit);
  fly(l, DESCEND_S + 0.5, clock);
  summit.y = 4;
  fly(l, 0.2, clock);
  const [hover] = l.inspect();
  assert.ok(Math.abs(hover!.y - (4 + HOVER_HEIGHT)) < 0.2, `rose with the live summit: ${hover!.y}`);
  l.dispose();
});

test('when the skill ends the lander holds station its minimum, then climbs away and is gone', () => {
  const summit = new THREE.Vector3(0, 2, 0);
  const clock = { t: 0 };
  const l = new Landers({ clock: () => clock.t * 1000 });
  l.set(['p1'], () => summit);
  fly(l, DESCEND_S + 0.5, clock);
  const low = l.inspect()[0]!.y;
  l.set([], () => summit);
  // A turn that ends right after its skill used to turn the lander round at once.
  fly(l, 1, clock);
  assert.equal(l.inspect()[0]?.phase, 'hovering', 'still holding station');
  flyUntil(l, 'lifting', clock);
  fly(l, LIFT_S / 2, clock);
  const [lifting] = l.inspect();
  assert.equal(lifting?.phase, 'lifting');
  assert.ok(lifting!.y > low, 'going up');
  fly(l, LIFT_S, clock);
  assert.equal(l.inspect().length, 0, 'gone once it has climbed out');
  l.dispose();
});

test('a skill that comes back while its lander is leaving brings the same lander back down', () => {
  const summit = new THREE.Vector3(0, 2, 0);
  const clock = { t: 0 };
  const l = new Landers({ clock: () => clock.t * 1000 });
  l.set(['p1'], () => summit);
  fly(l, DESCEND_S + 0.5, clock);
  l.set([], () => summit);
  flyUntil(l, 'lifting', clock);
  fly(l, LIFT_S * 0.6, clock);
  const high = l.inspect()[0]!.y;
  l.set(['p1'], () => summit);
  fly(l, DT, clock);
  const back = l.inspect();
  assert.equal(back.length, 1, 'no second lander out of the sky');
  assert.equal(back[0]!.phase, 'descending');
  assert.ok(back[0]!.y <= high + 0.5 && back[0]!.y < summit.y + ENTRY_HEIGHT - 1, 'it turns round where it was');
  fly(l, DESCEND_S + 0.5, clock);
  assert.equal(l.inspect()[0]!.phase, 'hovering');
  l.dispose();
});

test('a project with no habitat yet gets no lander until it has one', () => {
  let summit: THREE.Vector3 | null = null;
  const clock = { t: 0 };
  const l = new Landers({ clock: () => clock.t * 1000 });
  l.set(['p1'], () => summit);
  fly(l, 1, clock);
  assert.equal(l.inspect().length, 0);
  summit = new THREE.Vector3(0, 1, 0);
  fly(l, DT, clock);
  assert.equal(l.inspect().length, 1);
  l.dispose();
});

test('the engine washes under the lander while it comes down, and a burst as it settles', () => {
  const washes: { t: number; y: number }[] = [];
  const clock = { t: 0 };
  const summit = new THREE.Vector3(5, 2, 5);
  const l = new Landers({ onThrust: (_x, y) => washes.push({ t: clock.t, y }), clock: () => clock.t * 1000 });
  l.set(['p1'], () => summit);
  fly(l, DESCEND_S - 0.2, clock);
  const during = washes.length;
  assert.ok(during >= 12, `a steady wash on the way down: ${during}`);
  const lander = l.inspect()[0]!;
  assert.ok(washes.at(-1)!.y < lander.y + 0.01, 'from under the lander, not above it');
  fly(l, 0.4, clock);
  const settled = washes.filter((w) => w.t > DESCEND_S - 0.2).length;
  assert.ok(settled >= 3, `a burst as it brakes into the hover: ${settled}`);
  l.dispose();
});

test('a skill over before the lander is down still gets the whole minimum hover', () => {
  const summit = new THREE.Vector3(0, 2, 0);
  const clock = { t: 0 };
  const l = new Landers({ clock: () => clock.t * 1000 });
  l.set(['p1'], () => summit);
  fly(l, 0.5, clock);
  l.set([], () => summit);
  // It finishes coming down rather than turning round halfway.
  assert.equal(flyUntil(l, 'hovering', clock) < DESCEND_S, true);
  const held = flyUntil(l, 'lifting', clock);
  assert.ok(Math.abs(held - MIN_HOVER_S) < 0.1, `held station for ${held}s`);
  l.dispose();
});

test('a visit brings the lander down with nothing in use, and it leaves on its own', () => {
  const summit = new THREE.Vector3(3, 2, 3);
  const clock = { t: 0 };
  const l = new Landers({ clock: () => clock.t * 1000 });
  l.set([], () => summit);
  l.visit('p1');
  fly(l, DT, clock);
  assert.equal(l.inspect()[0]?.phase, 'descending');
  const hovered = flyUntil(l, 'hovering', clock) + flyUntil(l, 'lifting', clock);
  // The visit ran out during the hover; the minimum hover is what decides.
  assert.ok(hovered >= Math.max(VISIT_S, MIN_HOVER_S), `came down and held for ${hovered}s`);
  flyUntil(l, 'gone', clock, LIFT_S + 0.5);
  assert.equal(l.inspect().length, 0, 'gone without anyone taking it away');
  l.dispose();
});

test('visits in a row keep one lander there longer instead of bringing more', () => {
  const summit = new THREE.Vector3(0, 2, 0);
  const clock = { t: 0 };
  const l = new Landers({ clock: () => clock.t * 1000 });
  l.set([], () => summit);
  l.visit('p1');
  fly(l, DESCEND_S + 0.5, clock);
  // A burst of MCP calls, one every few seconds, well past the minimum hover.
  for (let i = 0; i < 6; i++) {
    l.visit('p1');
    fly(l, 4, clock);
    const now = l.inspect();
    assert.equal(now.length, 1, 'one lander a project');
    assert.equal(now[0]!.phase, 'hovering', `still there at call ${i}`);
  }
  const left = flyUntil(l, 'lifting', clock);
  assert.ok(left <= VISIT_S, `leaves once the calls stop: ${left}s`);
  l.dispose();
});

test('a visit to a project with no habitat is not kept for later', () => {
  let summit: THREE.Vector3 | null = null;
  const clock = { t: 0 };
  const l = new Landers({ clock: () => clock.t * 1000 });
  l.set([], () => summit);
  l.visit('p1');
  fly(l, VISIT_S + 1, clock);
  summit = new THREE.Vector3(0, 1, 0);
  fly(l, DT, clock);
  assert.equal(l.inspect().length, 0);
  l.dispose();
});

test('a visit made while nothing was drawn is not replayed when the page draws again', () => {
  const summit = new THREE.Vector3(0, 2, 0);
  const clock = { t: 0 };
  const l = new Landers({ clock: () => clock.t * 1000 });
  l.set([], () => summit);
  // A background tab: the call arrives, no frame runs for an hour.
  l.visit('p1');
  clock.t += 3600;
  fly(l, DT, clock);
  assert.equal(l.inspect().length, 0, 'a lander for a call made an hour ago');
  l.dispose();
});

test('the lander comes for a prompt and for a call off the colony, not for the crew\'s own tools', () => {
  const tool = (cat: string): DeltaEvent => ({
    t: 'tool.start', id: 't', sessionId: 's', agentId: null, name: 'X', cat, at: 0, target: null,
  } as unknown as DeltaEvent);
  const prompt = { t: 'prompt', sessionId: 's', promptId: 'p', at: 0, chars: 3, source: 'typed' } as DeltaEvent;
  assert.equal(summonsLander(prompt), true);
  assert.equal(summonsLander(tool('net')), true, 'WebFetch, WebSearch');
  assert.equal(summonsLander(tool('mcp')), true, 'an MCP server');
  for (const cat of ['read', 'edit', 'exec', 'search', 'agent', 'plan', 'msg', 'other']) {
    assert.equal(summonsLander(tool(cat)), false, cat);
  }
  const end = { t: 'turn.end', sessionId: 's', at: 0, durationMs: 1, messageCount: 1 } as DeltaEvent;
  assert.equal(summonsLander(end), false);
});

import { test } from 'node:test';
import * as THREE from 'three';
import assert from 'node:assert/strict';
import { Settings } from '../src/client/core/settings.ts';
import { Particles } from '../src/client/agents/particles.ts';

/** A fixed dice roll: the counts must not depend on luck. */
const HALF = (): number => 0.5;
const TINT = { r: 0.6, g: 0.55, b: 0.5 };

function particles(level: 'off' | 'low' | 'full'): Particles {
  const settings = new Settings({ storage: null });
  settings.set('particles', level);
  return new Particles(settings, HALF);
}

const EMITTERS: [name: string, fire: (p: Particles) => void][] = [
  ['puff', (p) => p.puff(0, 1, 0, TINT, 1)],
  ['uplink', (p) => p.uplink(0, 2, 0, TINT)],
  ['steam', (p) => p.steam(0, 1, 0, 1)],
  ['exhaust', (p) => p.exhaust(0, 5, 0)],
];

test('every new emitter throws particles when they are on, and more of them at full than at low', () => {
  for (const [name, fire] of EMITTERS) {
    const low = particles('low');
    const full = particles('full');
    fire(low);
    fire(full);
    assert.ok(low.liveCount > 0, `${name} at low`);
    assert.ok(full.liveCount >= low.liveCount, `${name}: full ${full.liveCount} vs low ${low.liveCount}`);
    low.dispose();
    full.dispose();
  }
});

test('with particles off, none of the new emitters spawns anything', () => {
  for (const [name, fire] of EMITTERS) {
    const off = particles('off');
    fire(off);
    assert.equal(off.liveCount, 0, name);
    off.dispose();
  }
});

/** Every live particle's height, read off the draw buffers the GPU would get. */
function heights(p: Particles): number[] {
  const out: number[] = [];
  for (const child of p.object3d.children) {
    if (!(child instanceof THREE.Points)) continue;
    const pos = child.geometry.getAttribute('position');
    const count = child.geometry.drawRange.count;
    for (let i = 0; i < Math.min(count, pos.count); i++) out.push(pos.getY(i));
  }
  return out;
}

test('an uplink keeps climbing, and a crate puff stays on the deck it landed on', () => {
  const up = particles('full');
  up.uplink(0, 2, 0, TINT);
  const start = Math.max(...heights(up));
  up.update(0.5);
  up.update(0.5);
  assert.ok(up.liveCount > 0, 'still in the air after a second');
  assert.ok(Math.min(...heights(up)) > start, 'and higher than it started');
  up.dispose();

  const dust = particles('full');
  dust.puff(0, 1, 0, TINT, 1);
  for (let i = 0; i < 8; i++) dust.update(0.05);
  assert.ok(dust.liveCount > 0);
  assert.ok(Math.min(...heights(dust)) >= 1, 'never through the deck');
  dust.dispose();
});

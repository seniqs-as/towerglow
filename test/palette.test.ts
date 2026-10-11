import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightColor } from '../src/client/world/palette.ts';
import type { Light } from '../src/client/state/lights.ts';
import { PROVIDER_COLOR, SKILL_COLOR, TOOL_COLOR } from '../src/client/world/palette.ts';

/**
 * The colour of a window is the ONLY thing that says what work is inside it:
 * names are read only by hovering over it with the mouse. Two categories that
 * look alike leave nothing in place of the name.
 */

function light(kind: Light['kind'], name: string | null): Light {
  return {
    id: 'x', kind, sessionId: 's', projectId: 'p', provider: 'claude',
    name, bornAt: 0, litAt: 0, endedAt: null, slot: 0,
  };
}

test('every tool category lights the window in a different colour', () => {
  const seen = new Map<number, string>();
  for (const tool of ['Read', 'Edit', 'Bash', 'Grep', 'WebFetch', 'TaskOutput', 'TodoWrite', 'AskUserQuestion', 'mcp__x__y', 'Frobnicate']) {
    const color = lightColor(light('tool', tool));
    const twin = seen.get(color);
    assert.equal(twin, undefined, `${tool} and ${twin} light the same colour`);
    seen.set(color, tool);
  }
  assert.equal(seen.size, 10, 'a category was left without a colour of its own');
});

test('a call does not take the colour of the provider (Claude Code, Codex) that makes it', () => {
  // It was the old behaviour: the whole facade orange, and the orange said
  // only "Claude Code", which the building already said.
  for (const tool of ['Read', 'Bash', 'Grep', 'WebFetch']) {
    assert.notEqual(lightColor(light('tool', tool)), PROVIDER_COLOR.claude);
  }
});

test('the turn keeps the colour of its provider: it is the session at the desk', () => {
  assert.equal(lightColor(light('turn', null)), PROVIDER_COLOR.claude);
  assert.equal(lightColor({ ...light('turn', null), provider: 'codex' }), PROVIDER_COLOR.codex);
});

test('an unknown tool still lights the window', () => {
  assert.equal(lightColor(light('tool', 'SomethingNew')), TOOL_COLOR.other);
  assert.equal(lightColor(light('tool', null)), TOOL_COLOR.other);
});

/**
 * How far apart two colours of the scene must be, in ΔE CIE76.
 *
 * Below this threshold two neighbouring windows read as the same thing. The
 * value is just below today's tightest pair (Claude's orange and the yellow
 * of `msg`): it is there to make the test fail when a tweak brings something
 * closer still, not to certify the current palette.
 */
const MIN_DELTA_E = 25;

function lab(hex: number): [number, number, number] {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = lin((hex >> 16) & 0xff);
  const g = lin((hex >> 8) & 0xff);
  const b = lin(hex & 0xff);
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

test('the colours that can share a facade are told apart by eye', () => {
  // Everything that can light a window, together: the ten categories, the
  // two providers and the skill. These are the hues that really end up side by
  // side.
  const scene: Record<string, number> = {
    ...TOOL_COLOR,
    'turn/claude': PROVIDER_COLOR.claude,
    'turn/codex': PROVIDER_COLOR.codex,
    skill: SKILL_COLOR,
  };
  const names = Object.keys(scene);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = lab(scene[names[i]]!);
      const b = lab(scene[names[j]]!);
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      assert.ok(d >= MIN_DELTA_E, `${names[i]} and ${names[j]} are too close: ΔE ${d.toFixed(1)}`);
    }
  }
});

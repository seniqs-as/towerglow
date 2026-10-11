import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gestureFor, requestGesture, restingGesture, settleGesture, GESTURE_CLIP, GESTURE_HOLD_S,
} from '../src/client/agents/gestures.ts';
import { CLIP } from '../src/client/assets/crew.ts';
import type { ToolCategory } from '../src/shared/protocol.ts';

test('every tool category has a gesture, and every gesture a clip the rig really has', () => {
  const cats: ToolCategory[] = ['read', 'edit', 'exec', 'search', 'net', 'agent', 'plan', 'msg', 'mcp', 'other'];
  for (const cat of cats) {
    const clip = GESTURE_CLIP[gestureFor(cat)];
    assert.ok(clip in CLIP, `${cat} plays ${clip}, which crew.glb does not bake`);
  }
  // The shapes that tell work apart: a read is not a hammer blow, a shell command is not a read.
  assert.equal(gestureFor('edit'), 'hammer');
  assert.equal(gestureFor('read'), gestureFor('search'));
  assert.notEqual(gestureFor('read'), gestureFor('exec'));
  assert.equal(gestureFor('net'), gestureFor('mcp'));
});

test('a burst of calls does not make the hands twitch: a gesture holds, and the last one asked for comes next', () => {
  const s = restingGesture();
  requestGesture(s, 'inspect', 10);
  assert.equal(s.current, 'inspect', 'the first call after a rest is taken at once');
  requestGesture(s, 'operate', 10.2);
  requestGesture(s, 'hammer', 10.4);
  requestGesture(s, 'uplink', 10.6);
  assert.equal(s.current, 'inspect', 'switched inside the hold');
  assert.equal(settleGesture(s, 10 + GESTURE_HOLD_S - 0.01), false);
  assert.equal(settleGesture(s, 10 + GESTURE_HOLD_S), true);
  assert.equal(s.current, 'uplink', 'not the latest call');
  assert.equal(s.pending, null);
});

test('asking again for the gesture already showing drops a stale one waiting behind it', () => {
  // read, edit, read inside a second: the hands never left reading, so the
  // edit must not play three seconds later, after the work moved on.
  const s = restingGesture();
  requestGesture(s, 'inspect', 0);
  requestGesture(s, 'hammer', 0.3);
  requestGesture(s, 'inspect', 0.6);
  assert.equal(settleGesture(s, 5), false);
  assert.equal(s.current, 'inspect');
});

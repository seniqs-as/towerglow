import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentBudget, attachmentLine, countsLine, effortChoice, effortOptions, modelOptions, nextReason, orderAfterMove, readinessOf,
  activeWarning, answerMeter, draftShown, gitBoxes, meetingNext, planTabLabel, sayMeter, seatedChair,
  sendState, taskLabel, unreadAnswers, WEB_BOX, workLeft,
} from '../src/client/ui/planning.ts';
import {
  CLAUDE_EFFORTS, CLAUDE_MODELS, CODEX_EFFORTS, MAX_ANSWER_CHARS, MAX_ATTACHMENT_CHARS, MAX_ATTACHMENTS, MAX_ATTACHMENTS_TOTAL_CHARS, MAX_SAY_CHARS,
  MAX_TODO_CHARS,
} from '../src/shared/protocol.ts';
import type { PlanDoc, PlanTask } from '../src/shared/protocol.ts';

function task(over: Partial<PlanTask> = {}): PlanTask {
  return {
    id: 't1', title: 'Add the export button', briefing: 'CSV in the reports panel.',
    provider: 'claude', model: 'sonnet', effort: null, size: 'medium', pinned: false,
    status: 'queued', question: null, answer: null, needs: [], attempts: 0, jobId: null, sessionId: null,
    did: null, learned: null, reason: null, ...over,
  };
}

function doc(over: Partial<PlanDoc> = {}): Pick<PlanDoc, 'status' | 'ready' | 'questions' | 'projects'> {
  return {
    status: 'proposed', ready: true, questions: [],
    projects: [{ projectId: 'p1', name: 'alpha', priority: 1, git: { commit: true, push: false }, tasks: [task()] }],
    ...over,
  };
}

test('a file over the cap is refused before it is read, with its number', () => {
  const out = attachmentBudget([], 'TODO.md', MAX_ATTACHMENT_CHARS + 1);
  assert.equal(out.ok, false);
  assert.match(out.reason ?? '', /TODO\.md is too big/);
});

test('the same name does not count twice: it is the updated file', () => {
  const existing = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({ name: `f${i}.md`, chars: 10 }));
  assert.equal(attachmentBudget(existing, 'f0.md', 10).ok, true);
  assert.equal(attachmentBudget(existing, 'new.md', 10).ok, false);
});

test('the attachments total has a cap of its own', () => {
  const existing = [{ name: 'a.md', chars: MAX_ATTACHMENTS_TOTAL_CHARS - 5 }];
  const out = attachmentBudget(existing, 'b.md', 10);
  assert.equal(out.ok, false);
  assert.match(out.reason ?? '', new RegExp(String(MAX_ATTACHMENTS_TOTAL_CHARS)));
});

test('the counter under the message knows the turn cap, and past it says to attach', () => {
  assert.equal(sayMeter('  hello  ', '').label, `5 / ${MAX_SAY_CHARS.toLocaleString('en-US')}`);
  assert.equal(sayMeter('x'.repeat(MAX_SAY_CHARS), '').over, false);
  assert.equal(sayMeter('x'.repeat(MAX_SAY_CHARS - 10), '').near, true);
  const over = sayMeter('x'.repeat(MAX_SAY_CHARS + 1), '');
  assert.equal(over.over, true);
  assert.match(over.label, /too long for one message: attach it as a file/);
});

test('the counter also counts the room left in the to-dos, which the server refuses the same way', () => {
  // The store appends "\n\n" + the new turn: that is the room left.
  const todo = 'x'.repeat(MAX_TODO_CHARS - 1002);
  assert.match(sayMeter('', todo).label, /\/ 1,000$/);
  assert.equal(sayMeter('y'.repeat(1000), todo).over, false);
  assert.equal(sayMeter('y'.repeat(1001), todo).over, true);
  assert.match(sayMeter('', 'x'.repeat(MAX_TODO_CHARS)).label, /\/ 0$/);
});

test('push says where it goes, "push to main"; without git there are no commit and push boxes', () => {
  assert.deepEqual(gitBoxes('main')?.map((b) => b.label), ['commit', 'push to main'], 'no tests box: the tests always run');
  assert.equal(gitBoxes('release')?.at(-1)?.label, 'push to release');
  assert.equal(gitBoxes(null), null);
});

test('send with an empty text box: sends the answers if there are any, otherwise it is disabled', () => {
  assert.deepEqual(sendState('', 3, false, false), { label: 'send answers', enabled: true, hint: '3 answers ready: send them, or add a message' });
  assert.equal(sendState('', 0, false, false).enabled, false, 'a button that does nothing is disabled');
  assert.deepEqual(sendState('ok', 3, false, false).label, 'send', 'with a message the answers go along with it');
  assert.equal(sendState('ok', 0, false, true).enabled, false, 'over the cap nothing is sent');
  assert.deepEqual(sendState('', 2, true, false), { label: 'thinking', enabled: false, hint: 'the chair is answering' });
});

test('an answer over the cap is flagged before sending it, with the way out', () => {
  assert.equal(answerMeter('x'.repeat(MAX_ANSWER_CHARS)).over, false);
  const over = answerMeter('x'.repeat(MAX_ANSWER_CHARS + 1));
  assert.equal(over.over, true);
  assert.match(over.label, /too long: say the rest in a message/);
});

test('a draft survives the redraw; it goes away when the plan has exactly those words', () => {
  // On the field shape: saving q1 redrew the panel, and q2 half written vanished.
  assert.deepEqual(draftShown(undefined, 'CSV'), { text: 'CSV', keep: false });
  assert.deepEqual(draftShown('JSON, because', 'CSV'), { text: 'JSON, because', keep: true });
  assert.deepEqual(draftShown('  CSV ', 'CSV'), { text: 'CSV', keep: false });
  assert.deepEqual(draftShown('half', null), { text: 'half', keep: true });
});

test('the plan tab is called "approve plan" as long as it waits for your yes', () => {
  assert.equal(planTabLabel('drafting'), 'approve plan');
  assert.equal(planTabLabel('proposed'), 'approve plan');
  assert.equal(planTabLabel('paused'), 'approve plan', 'resuming is approving again');
  assert.equal(planTabLabel('approved'), 'plan');
  assert.equal(planTabLabel('done'), 'plan');
});

test('after the answers the meeting says they arrived; with an open question or a turn running it stays silent', () => {
  const minutes = [
    { at: 1, role: 'user' as const, text: 'the to-dos' },
    { at: 2, role: 'ceo' as const, text: 'three questions' },
    { at: 3, role: 'user' as const, text: "Answers to the chair's questions:\n\nQ: x\nA: y" },
    { at: 4, role: 'ceo' as const, text: 'plan updated' },
  ];
  const base = { ...doc(), minutes };
  assert.equal(meetingNext(base, false), 'Your answers were sent to the chair, and it has updated the plan.');
  assert.equal(meetingNext(base, true), null, 'while it answers, the dots do the talking');
  assert.equal(meetingNext({ ...base, questions: [{ id: 'q1', text: '?', answer: null, seen: false }] }, false), null);
  assert.equal(meetingNext({ ...base, questions: [{ id: 'q1', text: '?', answer: 'a', seen: false }] }, false), null, 'send answers already says it');
  assert.equal(meetingNext({ ...base, minutes: minutes.slice(0, 2) }, false), 'The chair has laid the plan on the table.');
  assert.equal(meetingNext({ ...base, status: 'approved' }, false), null);
});

test('before the yes, your active sessions in the plan projects are named, with their count', () => {
  const d = { ...doc(), active: { p1: 2 } };
  assert.match(activeWarning(d) ?? '', /^Sessions of yours are active in alpha \(2\)\. Stop them before you approve/);
  assert.match(activeWarning(d) ?? '', /moved in the last 5 minutes/);
  assert.equal(activeWarning({ ...d, active: { p1: 0 } }), null);
  assert.equal(activeWarning({ ...d, status: 'approved' }), null);
});

test('the chair seat holds the plan choice; before it arrives, Claude, whatever the order', () => {
  assert.equal(seatedChair(null, ['codex', 'claude']), 'claude');
  assert.equal(seatedChair('codex', ['claude', 'codex']), 'codex');
  assert.equal(seatedChair(null, ['codex']), 'codex');
  assert.equal(seatedChair('claude', ['codex']), 'codex', 'a choice that no longer exists is not shown');
  assert.equal(seatedChair(null, []), null);
});

test('an attachment says whether the chair has it, or whether it goes with the next message', () => {
  assert.equal(attachmentLine({ name: 'global_todo.txt', chars: 2690, sent: false }), 'global_todo.txt · 2,690 chars · goes with your next message');
  assert.equal(attachmentLine({ name: 'global_todo.txt', chars: 2690, sent: true }), 'global_todo.txt · 2,690 chars · sent to the chair');
});

test('a task label says fleet, model and size; the effort for Codex, and for Claude when you chose one', () => {
  assert.equal(taskLabel(task()), 'claude · sonnet · medium');
  assert.equal(taskLabel(task({ model: null })), 'claude · default model · medium');
  assert.equal(taskLabel(task({ model: 'opus', effort: 'xhigh', size: 'large' })), 'claude · opus · xhigh effort · large');
  assert.equal(taskLabel(task({ provider: 'codex', model: null, effort: 'high', size: 'large' })), 'codex · default model · high effort · large');
});

test('the web box says what it gives to each fleet, and what a page is', () => {
  // It stands beside commit and push, and also where there is no git: the
  // hint is all a user reads before ticking it.
  assert.equal(WEB_BOX.label, 'web');
  assert.match(WEB_BOX.hint, /A Claude worker gets the WebSearch and WebFetch tools, and its shell stays offline/);
  assert.match(WEB_BOX.hint, /a Codex worker gets the network in its sandbox/);
  assert.match(WEB_BOX.hint, /text from outside, read by a session that may commit and push/);
  assert.equal(gitBoxes(null), null, 'no git: no commit and no push, and the web box is drawn apart from them');
});

test('every fleet has an effort to choose: Claude its five levels and a default, Codex its three', () => {
  // Only a Codex task had the select: a Claude task ran at Claude Code's
  // default and the plan could not say "think harder on this one".
  assert.deepEqual(effortOptions('claude').map((o) => o.value), [null, 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(effortOptions('claude')[0]?.label, 'default effort');
  assert.deepEqual(effortOptions('claude').slice(1).map((o) => o.label), CLAUDE_EFFORTS.map((e) => `${e} effort`));
  assert.deepEqual(effortOptions('codex').map((o) => o.value), [...CODEX_EFFORTS]);
  // What the select shows as chosen: nothing passed is "default" for Claude,
  // and medium for Codex, whose row has always said so.
  assert.equal(effortChoice(task()), null);
  assert.equal(effortChoice(task({ effort: 'max' })), 'max');
  assert.equal(effortChoice(task({ provider: 'codex', effort: null })), 'medium');
  assert.equal(effortChoice(task({ provider: 'codex', effort: 'low' })), 'low');
});

test('the model options are the shared list for Claude, and only the default for Codex', () => {
  assert.deepEqual(modelOptions('claude').map((o) => o.value), [null, ...CLAUDE_MODELS]);
  assert.deepEqual(modelOptions('codex').map((o) => o.value), [null]);
});

test('only a proposal with queued tasks can be approved, and open questions are counted', () => {
  assert.equal(readinessOf(doc({ status: 'drafting' })).ready, false);
  assert.match(readinessOf(doc({ projects: [] })).why, /no task/);
  const open = readinessOf(doc({ questions: [{ id: 'q1', text: 'CSV?', answer: null, seen: false }] }));
  assert.equal(open.ready, false);
  assert.match(open.why, /1 question still open/);
  assert.equal(readinessOf(doc({ ready: false })).ready, false);
  assert.equal(readinessOf(doc()).ready, true);
});

test('an answer the chair has not read blocks approval, and says so', () => {
  const unread = doc({ questions: [{ id: 'q1', text: 'CSV?', answer: 'CSV', seen: false }] });
  assert.equal(unreadAnswers(unread), 1);
  const r = readinessOf(unread);
  assert.equal(r.ready, false);
  assert.equal(r.blocked, true);
  assert.equal(r.why, '1 answer the chair has not read yet: send it a message first');
  // Read, it no longer locks anything: the rest stays advisory.
  const read = readinessOf(doc({ questions: [{ id: 'q1', text: 'CSV?', answer: 'CSV', seen: true }] }));
  assert.equal(read.blocked, false);
  assert.equal(read.ready, true);
  const open = readinessOf(doc({ questions: [{ id: 'q1', text: 'CSV?', answer: null, seen: false }] }));
  assert.equal(open.blocked, false, 'an open question is flagged, it does not block');
});

test('the counts line skips zeros and says "no task yet" when there is nothing', () => {
  assert.equal(countsLine({ queued: 3, running: 1, question: 0, done: 2, failed: 0, skipped: 0 }), '1 running · 3 queued · 2 done');
  assert.equal(countsLine({ queued: 0, running: 0, question: 0, done: 0, failed: 0, skipped: 0 }), 'no task yet');
});

test('moving a project swaps two places and leaves the others alone; at the edges it does nothing', () => {
  assert.deepEqual(orderAfterMove(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(orderAfterMove(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
  assert.deepEqual(orderAfterMove(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(orderAfterMove(['a', 'b', 'c'], 'zzz', 1), ['a', 'b', 'c']);
});

test('why nothing starts: the server reason wins, then the status', () => {
  const counts = { queued: 1, running: 0, question: 0, done: 0, failed: 0, skipped: 0 };
  assert.equal(nextReason({ status: 'approved', next: 'alpha: 5h at 80%', counts }), 'alpha: 5h at 80%');
  assert.equal(nextReason({ status: 'approved', next: null, counts }), 'waiting for the next tick');
  assert.equal(nextReason({ status: 'approved', next: null, counts: { ...counts, running: 1 } }), 'working');
  assert.match(nextReason({ status: 'paused', next: null, counts }), /paused/);
  assert.match(nextReason({ status: 'proposed', next: null, counts }), /approve/);
});

test('the Planning glyph carries a mark while the plan still has work in it', () => {
  // "if there is a plan still running or still to be completed, show an
  // icon next to the planning one" -- the user, 2026-09-19.
  const counts = (over: Partial<Record<'queued' | 'running' | 'question' | 'done' | 'failed' | 'skipped', number>>) => ({
    queued: 0, running: 0, question: 0, done: 0, failed: 0, skipped: 0, ...over,
  });
  assert.deepEqual(workLeft({ status: 'approved', counts: counts({ running: 2, queued: 7 }) }),
    { state: 'running', label: 'Planning \u2014 2 running, 7 to do' });
  // paused with the stopped tasks back in the queue: not done, so still marked
  assert.deepEqual(workLeft({ status: 'paused', counts: counts({ queued: 8, failed: 3 }) }),
    { state: 'pending', label: 'Planning \u2014 11 to do, paused' });
  // a task asking you is work left too
  assert.equal(workLeft({ status: 'approved', counts: counts({ question: 1, done: 4 }) })?.state, 'pending');
  // proposed and waiting for your yes: the plan has not started, and it is not done
  assert.equal(workLeft({ status: 'proposed', counts: counts({ queued: 3 }) })?.state, 'pending');
  // nothing left, or nothing yet: no mark
  assert.equal(workLeft({ status: 'done', counts: counts({ done: 5, skipped: 1 }) }), null);
  assert.equal(workLeft({ status: 'approved', counts: counts({ done: 5, skipped: 1 }) }), null);
  assert.equal(workLeft({ status: 'drafting', counts: counts({}) }), null);
});

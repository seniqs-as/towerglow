import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentsOf, MAX_DOCUMENTS, parseWorkReport, workTask } from '../src/server/ceo/work.ts';
import { MAX_FIELD_CHARS } from '../src/shared/protocol.ts';
import { MAX_NOTE_CHARS } from '../src/server/ceo/memory.ts';
import { OUTCOME_FENCE } from '../src/server/ceo/outcome.ts';
import type { Proposal } from '../src/server/ceo/proposals.ts';

/*
 * The line the worker leaves, and why there was none before.
 *
 * The CEO has a fenced block for its own proposals, the reviewer has one for
 * the verdict, the worker had none: it received the CEO's sentence on stdin
 * and returned prose. So the note that ended up in the CEO's memory was the
 * ECHO of its own sentence.
 *
 * Measured on 14 September 2026, after a real job on decsim2: `memory.json`
 * contained "already done: decsim2 consumed peak cognitive load (1.3M
 * thinking, 2.7M output) across 14 sessions; review 20 commits and stabilize
 * for release" -- with the CEO's wrong numbers inside, because the commits
 * were 72. The worker had found it out and written it in the first line of
 * its answer, and that line reached nobody.
 */

const NOW = Date.parse('2026-09-14T12:00:00.000Z');

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1', at: NOW, provider: 'claude', kind: 'consolidate',
    summary: 'decsim2 consumed peak cognitive load; review 20 commits',
    projectId: 'proj', projectName: 'decsim2',
    task: 'Review decsim2 past 7d: analyze 14 sessions, 20 commits.',
    status: 'accepted', decidedAt: NOW, sessionId: null, ...over,
  };
}

test('the task stays the first thing, intact: it is what you accepted', () => {
  const text = workTask(proposal());
  assert.ok(
    text.startsWith('Review decsim2 past 7d: analyze 14 sessions, 20 commits.'),
    'the task is not the first thing the worker reads',
  );
});

test('the task asks the worker to say when the request did not stand up', () => {
  // It is the half of the contract worth the most: a worker that silently
  // works around a wrong number leaves the CEO convinced it was right.
  const text = workTask(proposal());
  assert.match(text, /not true here/);
  assert.match(text, /wrong counts/);
  assert.match(text, /worth more than/);
});

test('a proposal\'s worker is told to leave its changes uncommitted', () => {
  // Claude's worker is denied git add, commit and push by name. Codex has no
  // per-command rule: for its worker this sentence is the only fence.
  const text = workTask(proposal());
  assert.match(text, /Do not commit and do not push/);
});

test('the task carries the fence, and says that of the whole answer one line is remembered', () => {
  const text = workTask(proposal());
  assert.ok(text.includes(OUTCOME_FENCE), 'the fence is missing');
  assert.match(text, /"did"/);
  assert.match(text, /"founded"/);
  assert.match(text, /the only part of your answer the CEO will remember/);
});

test('with no task the summary stands in: there is no such thing as a job without an assignment', () => {
  // `fleet` has its own gate on `proposal.task` BEFORE this wrapper, but if
  // one day it fell, the worker must still receive something sensible
  // instead of the word "null".
  const text = workTask(proposal({ task: null }));
  assert.ok(text.startsWith('decsim2 consumed peak cognitive load'));
});

test('the worker\'s line is read from the fenced block', () => {
  const got = parseWorkReport([
    'I looked at git: there are 72 commits, not 20.',
    OUTCOME_FENCE,
    '{"did": "sorted 72 commits by area; nothing to consolidate", "founded": false}',
    '```',
  ].join('\n'));
  assert.equal(got?.founded, false);
  assert.match(got?.did ?? '', /72 commit/);
});

/*
 * The documents a worker leaves for you: the shape the ledger may keep.
 *
 * A path is dropped rather than cut -- half a path is not a path -- and
 * anything that points outside the project never reaches the ledger, though
 * the server checks each one again against the real folder before opening it.
 */
test('the documents a worker names are relative, inside the project, short and few', () => {
  assert.deepEqual(documentsOf(['docs/plan.md', './docs/plan.md', ' docs/notes.md ']), ['docs/plan.md', 'docs/notes.md'], 'a leading ./ and spaces are the same path, once');
  assert.deepEqual(documentsOf(['/etc/passwd', '../secrets.md', 'docs/../../x.md', 'C:\\x.md', '\\\\srv\\x.md']), [], 'nothing outside the project');
  assert.deepEqual(documentsOf([42, null, '', 'docs/a.md']), ['docs/a.md']);
  assert.deepEqual(documentsOf(['x/'.repeat(80) + 'a.md']), [], 'a path over the delta cap is dropped, not cut');
  assert.equal(documentsOf(['a'.repeat(MAX_FIELD_CHARS - 3) + '.md']).length, 1, 'at the cap it passes');
  const many = Array.from({ length: MAX_DOCUMENTS + 3 }, (_, i) => `docs/${i}.md`);
  assert.equal(documentsOf(many).length, MAX_DOCUMENTS);
  assert.deepEqual(documentsOf('docs/plan.md'), [], 'a string is not a list');
  assert.deepEqual(documentsOf(undefined), []);
});

test('the worker block carries the documents it wrote, and without them the list is empty', () => {
  const got = parseWorkReport(`${OUTCOME_FENCE}\n{"did": "wrote the plan", "founded": true, "wrote": ["docs/plan.md"]}\n\`\`\``);
  assert.deepEqual(got?.wrote, ['docs/plan.md']);
  const none = parseWorkReport(`${OUTCOME_FENCE}\n{"did": "fixed it", "founded": true}\n\`\`\``);
  assert.deepEqual(none?.wrote, []);
});

test('only an explicit false counts as an unfounded request', () => {
  // As for `holds` in the verdict: a missing field is a model that did not
  // answer the question, not a model declaring the request founded.
  const missing = parseWorkReport(`${OUTCOME_FENCE}\n{"did": "done"}\n\`\`\``);
  assert.equal(missing?.founded, true);
  const asNull = parseWorkReport(`${OUTCOME_FENCE}\n{"did": "done", "founded": null}\n\`\`\``);
  assert.equal(asNull?.founded, true);
  const asFalse = parseWorkReport(`${OUTCOME_FENCE}\n{"did": "done", "founded": false}\n\`\`\``);
  assert.equal(asFalse?.founded, false);
});

test('an answer without a block makes the parser invent nothing', () => {
  // The prose stays readable in Reports anyway: here `null` comes back and
  // the caller keeps the summary, instead of remembering an invented sentence.
  assert.equal(parseWorkReport('I did the job and I am happy with it'), null);
  assert.equal(parseWorkReport(''), null);
  assert.equal(parseWorkReport(`${OUTCOME_FENCE}\nnot json\n\`\`\``), null);
  assert.equal(parseWorkReport(`${OUTCOME_FENCE}\n{"founded": false}\n\`\`\``), null);
  assert.equal(parseWorkReport(`${OUTCOME_FENCE}\n{"did": "   "}\n\`\`\``), null);
  assert.equal(parseWorkReport(`${OUTCOME_FENCE}\n[1,2,3]\n\`\`\``), null);
});

test('an unclosed block is the normal shape of a truncated answer', () => {
  // The same case `lastBlock` solves for the verdict and for the proposals: a
  // whole job is not thrown away over a newline.
  const got = parseWorkReport(`${OUTCOME_FENCE}\n{"did": "half done", "founded": true}`);
  assert.equal(got?.did, 'half done');
});

test('a very long line is cut: it is a line, not a paragraph', () => {
  // The cap is the memory's, applied AT THE SOURCE as `parseVerdict` does:
  // twenty-four notes of two hundred characters must be able to fit even in
  // the cheapest brief.
  const long = 'x'.repeat(1000);
  const got = parseWorkReport(`${OUTCOME_FENCE}\n{"did": "${long}", "founded": true}\n\`\`\``);
  assert.equal(got?.did.length, MAX_NOTE_CHARS);
});

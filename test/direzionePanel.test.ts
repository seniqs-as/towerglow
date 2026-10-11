import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionOf, textToSend } from '../src/client/ui/direzione.ts';
import { ANALYSES } from '../src/server/ceo/analyses.ts';
import type { AnalysisOffer } from '../src/shared/protocol.ts';

/**
 * The analyses as they arrive in the caps: the same ones the module declares.
 *
 * They are built FROM `ANALYSES` and not by hand precisely because these tests
 * defend the absence of a second copy of the question.
 */
const OFFERS: readonly AnalysisOffer[] = ANALYSES.map(
  (a) => ({ kind: a.kind, title: a.title, question: a.question }),
);

test('the sentence the button puts in the text box is the one the server sends', () => {
  // Not a paraphrase: you read what you pay for. If one day they diverged, the
  // panel would show one question and pay for another.
  const q = questionOf(OFFERS, 'sessions');
  assert.equal(q, ANALYSES.find((a) => a.kind === 'sessions')?.question);
  assert.ok(q.length > 0);
});

test('without the sentences from the server the text box stays empty, but the button arms anyway', () => {
  // An older server, or CEOs switched off: the `kind` is the only thing needed
  // for the question to go out, and the sentence is an extra you get to read.
  assert.equal(questionOf([], 'quota'), '');
});

test('an untouched question is not sent: the server already has it written down', () => {
  // Sending it back would paste it a second time into the same prompt, and
  // prompts are paid by the token.
  const q = questionOf(OFFERS, 'tokens');
  assert.equal(textToSend(q, q), '');
});

test('what you add is sent, because the server does not have it', () => {
  const q = questionOf(OFFERS, 'tokens');
  assert.equal(textToSend(`${q} Focus on my_dashboard.`, q), `${q} Focus on my_dashboard.`);
  assert.equal(textToSend('just my question', q), 'just my question');
});

test('a free-form question is always sent: there is no analysis to compare it with', () => {
  assert.equal(textToSend('how much did I spend today?', null), 'how much did I spend today?');
});

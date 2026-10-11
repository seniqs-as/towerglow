import { lastBlock, OUTCOME_FENCE } from './outcome.ts';
import { EFFECT_DIRECTION as DIRECTION, EFFECT_LABELS as LABELS } from '../../shared/protocol.ts';
import { METRICS, MIN_COHORT } from './effect.ts';
import type { EffectReading, EffectVerdict } from './effect.ts';
import type { Job } from './jobs.ts';

/**
 * Asking the CEO whether its advice worked, in the only way that produces an
 * answer worth anything.
 *
 * The problem: the one who gave the advice is being asked to judge it, on
 * numbers that do not come from an experiment. Nobody held anything constant,
 * the sessions after are not redoing the work of the sessions before, and a
 * model shown a minus thirty percent and asked "did it work?" says yes. That
 * answer costs a whole preamble and carries no information.
 *
 * So the opposite is asked: BREAK the link. Name the thing, other than your
 * advice, that best explains these numbers. It is the same craft `review.ts`
 * applies to proposals -- there "agreeing is the cheap answer and is worth
 * nothing", here the cheap answer is taking the credit -- and it is also why
 * `attributed` has the opposite direction from `holds`: a forgotten field
 * must not count as a merit.
 *
 * The judgement is not the measurement. The measurement stays what it is, and
 * goes into memory on its own, cohort included; this adds the why, which is
 * the only part a model can give and a tally cannot.
 */

/** A figure written the way the one who must explain it reads it. */
function line(id: (typeof METRICS)[number], r: EffectReading): string {
  const b = r.baseline.side[id];
  const a = r.after[id];
  if (b.value === null || a.value === null) {
    // Missing and not "equal": it is the distinction the prompt must enforce,
    // or the model will read a hole as confirmation that nothing changed.
    const which = b.value === null ? 'before' : 'after';
    return `- ${LABELS[id]}: not enough sessions ${which} `
      + `(${b.value === null ? b.n : a.n} of ${MIN_COHORT}) -- missing, not unchanged`;
  }
  const delta = b.value === 0 ? null : Math.round(((a.value - b.value) / b.value) * 100);
  const dir = DIRECTION[id] === 'none' ? ' (no better or worse direction)' : '';
  return `- ${LABELS[id]}: ${round(b.value)} -> ${round(a.value)}`
    + (delta === null ? '' : ` (${delta > 0 ? '+' : ''}${delta}%)`)
    + ` [${b.n} vs ${a.n} sessions]${dir}`;
}

function round(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n < 10 ? n.toFixed(2) : String(Math.round(n));
}

/** The task that goes to the CEO, on stdin: the command line never changes. */
export function judgeTask(job: Job, r: EffectReading): string {
  const where = job.projectName ?? 'that project';
  return [
    `You proposed this work on ${where}. The user accepted it, a session did it, and`,
    `these are that project's numbers before and after. Medians per session, sessions`,
    'you opened yourself excluded, your own fleet only.',
    '',
    `PROPOSED: ${job.summary}`,
    job.workDid ? `DONE: ${job.workDid}` : '',
    job.workFounded === false
      ? 'The session that did it reported the request rested on something untrue here.'
      : '',
    job.reviewHolds === false
      ? 'A second opinion objected to the proposal at the time.'
      : '',
    '',
    ...METRICS.map((id) => line(id, r)),
    '',
    `Cohorts: ${r.baseline.sessions} sessions before, ${r.afterSessions} after.`,
    'A figure with too few sessions says so instead of showing a number: treat a',
    'missing line as missing, never as unchanged.',
    '',
    'This was NOT an experiment. Nobody held anything constant, and the sessions',
    'after are not the sessions before doing the same job over again.',
    '',
    'Your task is to BREAK the attribution, not to confirm it. For each figure that',
    'moved, name the thing OTHER than your advice that best explains it: a different',
    'kind of task in the period, a different model, one long session dominating a',
    'small cohort, work done for unrelated reasons, or a cohort too small to mean',
    'anything at all. Claiming these numbers is the cheap answer and is worth',
    'nothing. Only if you genuinely cannot find another explanation, say so and name',
    'the single figure that is the evidence.',
    '',
    'End your answer with this block, and write nothing after it:',
    OUTCOME_FENCE,
    '{"title":"<six words or fewer>","attributed":false,'
      + '"why":"one line: what actually explains the move",'
      + '"proposals":[]}',
    '```',
    '`attributed` is true ONLY when you could not find another explanation; leaving',
    'it out means no. Propose something only if these numbers support it -- an empty',
    'list is a legitimate answer, and "do more of what I suggested" is not a finding.',
  ].filter((l) => l !== '').join('\n');
}

/**
 * The judgement from the fenced block.
 *
 * Defensive like `parseVerdict` and for the same reason: a model writes the
 * text. Without a readable block nothing is attributed to anyone, and the
 * prose stays readable where it arrived anyway.
 */
export function parseJudgement(text: string, at: number): EffectVerdict | null {
  const block = lastBlock(text);
  if (!block || !block.trim()) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const why = obj['why'];
  if (typeof why !== 'string' || why.trim().length === 0) return null;
  return {
    at,
    /*
     * The OPPOSITE direction from `holds` and `founded`, and it is not an
     * oversight.
     *
     * There, the missing field is a model that did not answer the question,
     * and the neutral assumption is "it holds". Here the zero-cost answer is
     * "yes, it's my doing": accepting it by default would mean that a model
     * that forgets the field takes the credit.
     */
    attributed: obj['attributed'] === true,
    why: why.trim().slice(0, 200),
  };
}

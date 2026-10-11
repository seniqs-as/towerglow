import type { AnalysisKind, CeoDepth, ProviderId } from '../../shared/protocol.ts';
import { OUTCOME_FENCE } from './outcome.ts';

/**
 * The five analyses, written down once.
 *
 * They live in their own file because three different places need the same
 * answer about them: the runner (which brief to build), the port (what a client
 * may ask for) and the panel (what to put on a button). A question typed by
 * hand is still allowed and still works -- it simply gets the cheap brief,
 * because guessing that free text needs the project code would buy the
 * expensive brief every single time.
 *
 * The text of each question is a prompt, not a label: it is paid for on every
 * call, so it says what to look at and stops.
 */

export interface Analysis {
  kind: AnalysisKind;
  /** What it is called on the button. */
  title: string;
  /** The question sent when you pick it instead of typing your own. */
  question: string;
  /**
   * Whether the answer needs the project code, not just the metadata.
   *
   * Only one of the five does. The other four are answered by numbers the
   * world model already holds, and handing them a perimeter of readable
   * repositories would only invite reads nobody asked for.
   */
  code: boolean;
}

export const ANALYSES: readonly Analysis[] = [
  {
    kind: 'sessions',
    title: 'session report',
    question:
      'Report on how the fleet worked. Turns and their length, tool calls by category, '
      + 'measured reasoning time, context used, model, subagents and skills. '
      + 'Name the sessions that stand out and say why; do not describe every one of them.',
    code: false,
  },
  {
    kind: 'development',
    title: 'development trend',
    question:
      'Where is development actually moving? Which parts are under stress from reads, '
      + 'writes and churn, what landed as commits, which projects have not moved in weeks. '
      + 'Separate what is being worked on from what is merely open.',
    code: false,
  },
  {
    kind: 'tokens',
    title: 'token waste',
    question:
      'Where are tokens being wasted? Look at the cache read/write ratio first, then '
      + 'thinking against output, orphan tool calls, the same target read twice in one turn, '
      + 'context running out early, and the model chosen against the work actually done.',
    code: false,
  },
  {
    kind: 'structure',
    title: 'structural improvements',
    question:
      'Cross how I work with what is in the repositories: a project with no CLAUDE.md whose '
      + 'sessions reread the same files, a skill that already exists for something done by hand '
      + 'every time, two modules doing the same job. Read only what you need from the roots listed.',
    code: true,
  },
  {
    kind: 'quota',
    title: 'quota and spend',
    question:
      'Given the rate-limit windows, what should I give up first and what can wait? '
      + 'Rank by what these numbers say, not by what is generally advisable.',
    code: false,
  },
];

export function analysisOf(kind: AnalysisKind | null): Analysis | null {
  if (kind === null) return null;
  return ANALYSES.find((a) => a.kind === kind) ?? null;
}

/**
 * The block the model has to end with, and the reason it is a block.
 *
 * Asking for prose and then mining it for actions gives a different shape every
 * time. Asking for one fenced object at the end keeps the report readable for a
 * human AND parseable for the panel, without a second call to reformat the
 * first -- and a second call costs another full preamble, which is measured at
 * about five cents before the question is even asked.
 *
 * An empty list is spelled out as legitimate on purpose: a model told to
 * produce proposals will produce proposals, and an invented one is worse than
 * none at all.
 */
export const OUTCOME_CONTRACT = [
  'End your reply with one fenced block, and write nothing after it:',
  '',
  OUTCOME_FENCE,
  '{"title":"<six words or fewer>","proposals":[{"kind":"<one word>",'
    + '"summary":"<what to change and what it buys, max 240 chars>",'
    + '"project":"<the project name exactly as written above, or null>",'
    + '"command":"<the full instruction a dedicated session would receive, or null>"}]}',
  '```',
  '',
  'At most 4 proposals, and none at all if the numbers do not support one: an empty list is a '
    + 'legitimate answer. Everything before the block is the report the user reads, so do not '
    + 'repeat the block in prose.',
  'Write `command` as if handing the task to someone who cannot see this conversation: it is the '
    + 'whole instruction, and nothing else will be added to it. `project` must match a name from '
    + 'the snapshot exactly, or be null -- a proposal naming a project that does not exist cannot '
    + 'be carried out, and will be refused rather than guessed at.',
].join('\n');

/* ───────────────────────── the three depths ───────────────────────── */

/**
 * How deep, and how much it costs.
 *
 * Each step moves three things together -- the model, how much brief is paid
 * for, and how much it may answer -- because moving just one does not really
 * change the bill. The model is the biggest lever of all: between haiku and
 * opus there is a factor of five, while between the shortest and the longest
 * brief there is less than two, on a fraction of the prompt.
 *
 * Three distinct command lines, one per step, and it is not a violation of the
 * cache rule: the cache is tied to the model anyway, so three models are three
 * caches in any case. Within a step the line stays byte-for-byte identical,
 * which is the property that was needed.
 */
export interface Depth {
  kind: CeoDepth;
  title: string;
  /** The brief's cap in characters: that is how depth is paid for. */
  briefChars: number;
  /**
   * How many live sessions to list.
   *
   * It needs a cap of its own because "your fleet" is one of the two sections
   * that cannot be sacrificed: with only the character cap, forty sessions
   * broke through it on their own and the fast step was not fast.
   */
  sessions: number;
  /** At most how many proposals. */
  proposals: number;
  /** Whether to declare the read perimeter outside the structural analysis too. */
  code: boolean;
  /** What to add to the contract. Empty for standard, which is the reference. */
  extra: string;
}

export const DEPTHS: Record<CeoDepth, Depth> = {
  fast: {
    kind: 'fast',
    title: 'fast',
    briefChars: 2000,
    sessions: 6,
    proposals: 2,
    code: false,
    extra: 'Answer in at most five lines. Name the single biggest thing and stop; '
      + 'if the numbers do not support even one proposal, say so in one line.',
  },
  standard: {
    kind: 'standard',
    title: 'standard',
    briefChars: 6000,
    sessions: 20,
    proposals: 4,
    code: false,
    extra: '',
  },
  deep: {
    kind: 'deep',
    title: 'deep',
    briefChars: 9000,
    sessions: 20,
    proposals: 4,
    code: true,
    extra: 'Take the time this needs. Open the files you have to before proposing '
      + 'anything structural, and say which ones you looked at. Where two readings of '
      + 'the numbers are possible, give both instead of picking the tidier one.',
  },
};

/**
 * The model for a step.
 *
 * The two tools have two different levers, and the right one is used for each
 * instead of forcing a single one:
 *
 *  - CLAUDE CODE has a ladder of models made of stable aliases -- `haiku`,
 *    `sonnet`, `opus` -- and the middle rung is the one you choose with
 *    `--ceo-model`. Depth changes the model.
 *  - CODEX does not: its model names belong to another vendor and change
 *    without us noticing. There the lever is `model_reasoning_effort`, which
 *    is a real, stable scale on the SAME model. Codex's "middle step" is
 *    therefore the model you already chose in `~/.codex/config.toml`, at
 *    medium effort.
 *
 * That is why, if you do not declare `--ceo-codex-model`, no `-m` is passed at
 * all: better the model you configured than a guessed name that makes the
 * spawn fail. And that was the bug -- the same `sonnet` string also ended up
 * in `codex exec`, where it means nothing.
 */
export function modelFor(
  provider: ProviderId,
  depth: CeoDepth,
  standard: string,
  codexModel: string | null,
): string | null {
  if (provider === 'codex') return codexModel;
  if (depth === 'fast') return 'haiku';
  if (depth === 'deep') return 'opus';
  return standard;
}

/** Codex's reasoning effort for a step. `null` for Claude Code. */
export function effortFor(provider: ProviderId, depth: CeoDepth): string | null {
  if (provider !== 'codex') return null;
  if (depth === 'fast') return 'low';
  if (depth === 'deep') return 'high';
  return 'medium';
}

/** The contract, with the step's addition. */
export function contractFor(depth: CeoDepth): string {
  const d = DEPTHS[depth];
  const base = OUTCOME_CONTRACT.replace('At most 4 proposals', `At most ${d.proposals} proposals`);
  return d.extra ? `${base}\n${d.extra}` : base;
}

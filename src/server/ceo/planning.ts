import type { ProviderId, ProviderLimits, Reserve } from '../../shared/protocol.ts';
import { CLAUDE_MODELS, MAX_BRIEFING_CHARS, MAX_SUMMARY_CHARS } from '../../shared/protocol.ts';
import { windowNow } from '../../shared/limits.ts';
import { commandsOf } from './allow.ts';
import { lastBlock, OUTCOME_FENCE } from './outcome.ts';
import type { Attachment, ParsedPlan, ParsedProject, ParsedTask, Plan } from './plan.ts';

/**
 * The meeting: what the chair reads, and the block it answers with.
 *
 * The chair is a CEO in a resumed session, so it keeps what it read between
 * turns; this file decides what it is told on the first turn, on every later
 * turn, and when the session is gone and the meeting restarts from the
 * minutes. The block at the end of each answer is the only thing the program
 * reads back: the prose is for you.
 *
 * What the chair must produce is a BRIEFING per task, not a summary: the
 * worker that gets it cannot ask anyone anything, so every decision the
 * meeting took must be in the text it receives. That is the one instruction
 * the whole feature depends on, and it is repeated in the role, in the
 * contract and in the rules on purpose.
 */

/**
 * The system prompt of a Claude meeting: short, because the role is in the
 * prompt for both tools.
 *
 * No language is imposed here, on purpose and by decision of the user: the
 * chair answers in the language the user writes in. The analyst's answers
 * are product and stay English; a meeting is a conversation with you.
 */
export const MEETING_SYSTEM = 'You chair the planning meeting of Towerglow, an observatory of agentic coding sessions. Answer in the language the user writes in.';

export const MEETING_ROLE = [
  '# Your role',
  'You chair a planning meeting with the user. You plan work for both fleets:',
  'claude (Claude Code sessions) and codex (Codex CLI sessions).',
  'You will NOT be available while the work runs. Each task is handed to a fresh,',
  'non-interactive session that cannot ask anyone anything: a worker that must',
  'ask stops, and that project waits for the user. So the briefing you write for',
  'a task must carry every decision, convention, file name, acceptance check and',
  'answer a worker needs to finish without asking.',
  'A task that only plans, studies or reports produces a markdown document in the',
  'repository, and its briefing names the file: a plan that lives only in a',
  'worker\'s answer is a plan nobody can open.',
  'Before you propose, ask the clarifying questions a Claude Code or Codex session',
  'would ask before starting: scope, what "done" means, conventions, what not to',
  'touch, how to verify. Read the code under the roots listed below to ask good',
  'questions and to write good briefings, and say which files you looked at. Ask',
  'only what the to-dos and the code do not settle; never ask what you can read.',
  'Keep each turn short: read what you need to ask good questions -- a few files',
  'per project -- then answer; you can read more in the next turn. A turn has a',
  'cost cap, and one that reads for minutes is stopped before it says anything.',
  'At most one session works on a project at a time, and none starts on a project',
  'where the user is working. Split work so that projects can run side by side.',
  'Workers always run a project\'s tests before they finish. For every project,',
  'list in `tests` the commands that run its tests and checks, read from the',
  'repository (package.json scripts, composer.json, a Makefile, a tests folder,',
  'CLAUDE.md or the README): each an exact command or a prefix and `*`, like',
  '`php tests/*` or `bash tests/smoke.sh`. A worker may run only these and the',
  'common runners (npm test, npx, pytest, cargo test, go test, php -l, node',
  '--check), so a command you leave out is one it will stop and ask for. Never git,',
  'never a bare interpreter (`php *`), one command per entry. Commits and the push',
  'to the project\'s branch are on by default: the user decides them with a',
  'checkbox, so do not ask about them.',
  'Answer in the language the user writes in.',
].join('\n');

export const MEETING_CONTRACT = [
  'End every answer with this block, and nothing after it:',
  OUTCOME_FENCE,
  '{"ready": false,',
  ' "questions": [{"id": "q1", "text": "<one question, at most 500 chars>"}],',
  ' "projects": [{"name": "<a project name exactly as listed>", "priority": 1,',
  '   "tests": ["npm test", "node --check *"],',
  '   "tasks": [{"id": null, "title": "<at most 240 chars>",',
  `     "briefing": "<at most ${MAX_BRIEFING_CHARS} chars: everything the worker needs, decisions included>",`,
  '     "provider": "claude", "model": "sonnet", "effort": null, "size": "medium"}]}]}',
  '```',
  'Rules: keep the `id` of a task you are not replacing, null for a new one; a task',
  'you leave out is dropped. `priority` 1 is first. `provider` is claude or codex.',
  `\`model\` is ${CLAUDE_MODELS.join(', ')} for claude (cheapest first) and null for codex;`,
  '`effort` is low, medium or high for codex and null for claude; `size` is small,',
  'medium or large. `ready` is true only when no question is open and every',
  'briefing is complete; until then list the tasks you already see and the',
  'questions that remain. The block is read by a program: valid JSON, no comments,',
  'and a project name that is not in the list is dropped. The JSON keys and the',
  'enumerated values stay as written above; the prose, the questions and the',
  'briefings are in the language the user writes in.',
].join('\n');

/** A project as the chair sees it: the name it must use, and where the code is. */
export interface MeetingProject {
  name: string;
  providers: readonly ProviderId[];
  branch: string | null;
  commits: number;
  /** Absolute root, readable by the chair through the perimeter. `null` if not on disk. */
  root: string | null;
  /** The user has a session of their own open here right now. */
  live: boolean;
}

export interface MeetingContext {
  projects: readonly MeetingProject[];
  limits: readonly ProviderLimits[];
  providers: readonly ProviderId[];
  codexModel: string | null;
  now: number;
}

function section(title: string, lines: readonly string[]): string {
  return [`# ${title}`, ...lines].join('\n');
}

function projectsSection(ctx: MeetingContext): string {
  if (ctx.projects.length === 0) return section('Projects', ['(none known yet: open a session in a project first)']);
  const lines = ctx.projects.map((p) => {
    const bits = [`- ${p.name}`];
    bits.push(p.providers.length > 0 ? `tools: ${p.providers.join(', ')}` : 'tools: none yet');
    if (p.branch) bits.push(`branch ${p.branch}`);
    if (p.commits > 0) bits.push(`${p.commits}+ commits seen`);
    bits.push(p.root ? `code at ${p.root}` : 'not on disk');
    if (p.live) bits.push('the user is working here now');
    return bits.join(' · ');
  });
  return section('Projects', ['Use these names exactly in the block.', ...lines]);
}

function quotaSection(plan: Plan, ctx: MeetingContext): string {
  const lines: string[] = [];
  for (const p of ctx.providers) {
    const mine = ctx.limits.find((l) => l.provider === p);
    const reserve: Reserve = plan.reserve[p] ?? { '5h': 0, '7d': 0 };
    if (!mine || mine.windows.length === 0) {
      lines.push(`- ${p}: no quota reading yet · reserve ${reserve['5h']}% of 5h, ${reserve['7d']}% of 7d`);
      continue;
    }
    const wins = mine.windows.map((w) => {
      const now = windowNow(w, ctx.now);
      return `${w.label}${w.model ? ` ${w.model}` : ''} at ${Math.round(now.usedPercent)}%`;
    });
    lines.push(`- ${p}: ${wins.join(', ')} · reserve to keep free: ${reserve['5h']}% of 5h, ${reserve['7d']}% of 7d`);
  }
  lines.push(`Up to ${plan.parallel} task${plan.parallel === 1 ? '' : 's'} run at once, on different projects.`);
  return section('Quota now', lines);
}

function fleetsSection(ctx: MeetingContext): string {
  const codex = ctx.codexModel ?? 'its configured model';
  const lines = [
    `- claude: models ${CLAUDE_MODELS.join(' < ')} (cost order). Pick the cheapest that can do the task well.`,
    `- codex: ${codex}, with effort low < medium < high.`,
  ];
  if (!ctx.providers.includes('codex')) lines.push('There is no codex CEO here: hand every task to claude.');
  if (!ctx.providers.includes('claude')) lines.push('There is no claude CEO here: hand every task to codex.');
  return section('Fleets and models', lines);
}

function attachmentLines(list: readonly Attachment[]): string[] {
  const lines: string[] = [];
  for (const a of list) {
    lines.push(`--- ${a.name} (${a.chars} chars) ---`, a.text.trimEnd(), '--- end ---');
  }
  return lines;
}

function materialSection(plan: Plan): string[] {
  const out: string[] = [];
  out.push(section('To-dos, in the user\'s words', [plan.todo || '(nothing typed yet)']));
  if (plan.attachments.length > 0) out.push(section('Attachments', attachmentLines(plan.attachments)));
  return out;
}

/** The files the chair does not have yet: they go with the next turn, once. */
export function pendingAttachments(plan: Plan): Attachment[] {
  return plan.attachments.filter((a) => !a.sent);
}

/** Removed files the chair still has, minus any you attached again under the same name. */
export function withdrawnNames(plan: Plan): string[] {
  return plan.withdrawn.filter((n) => !plan.attachments.some((a) => a.name === n));
}

/**
 * What changed on the table since the chair's last turn.
 *
 * The first turn carries every file; a later one carried none, so a file
 * attached after the meeting had started never reached the chair -- which
 * answered that it could see no attachment. Only the news travels: the
 * resumed session keeps what it read, and sending every file every turn
 * would pay for them again at each line of the meeting.
 */
function newsSection(plan: Plan): string | null {
  const fresh = pendingAttachments(plan);
  const gone = withdrawnNames(plan);
  const lines: string[] = [];
  if (fresh.length > 0) {
    lines.push(
      'Files the user attached since your last turn. One with the name of a file',
      'you already have is its new version and replaces it.',
      ...attachmentLines(fresh),
    );
  }
  if (gone.length > 0) lines.push(`Removed by the user, disregard them: ${gone.join(', ')}.`);
  return lines.length > 0 ? section('Attachments', lines) : null;
}

/** The first turn: everything the chair needs, once. */
export function openingPrompt(plan: Plan, ctx: MeetingContext): string {
  // Answers too, when there are any: every prompt that opens or continues the
  // meeting carries them, because the desk marks them read once it has run.
  const answers = answersSection(plan);
  return [
    MEETING_ROLE,
    projectsSection(ctx),
    quotaSection(plan, ctx),
    fleetsSection(ctx),
    ...materialSection(plan),
    ...(answers ? [answers] : []),
    section('This turn', [
      'Read the material and the code. Ask what you need to know before planning,',
      'and lay out the tasks you already see. If everything is clear, propose the',
      'plan and call it ready.',
    ]),
    MEETING_CONTRACT,
  ].join('\n\n');
}

/** The plan as the chair should picture it: ids, choices and what is pinned. No briefings. */
function compactPlan(plan: Plan, briefings: boolean): string {
  const projects = plan.projects.map((p) => ({
    name: p.name,
    priority: p.priority,
    git: p.git,
    tests: plan.commands[p.projectId] ?? [],
    tasks: p.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      ...(briefings ? { briefing: t.briefing } : {}),
      provider: t.provider,
      model: t.model,
      effort: t.effort,
      size: t.size,
      status: t.status,
      ...(t.pinned ? { pinned: true } : {}),
      ...(t.did ? { did: t.did } : {}),
    })),
  }));
  return JSON.stringify({ ready: plan.ready, projects }, null, 1);
}

function answersSection(plan: Plan): string | null {
  const answered = plan.questions.filter((q) => q.answer !== null);
  if (answered.length === 0) return null;
  return section('Your questions, answered', answered.map((q) => `Q (${q.id}): ${q.text}\nA: ${q.answer}`));
}

/**
 * A turn with no words: the user sent answers. Said as a note and not as
 * words of the user: a canned English line in the user's mouth would be the
 * last thing the user "said", and the chair answers in the user's language.
 */
const NO_MESSAGE = '(no message this turn: the user answered your questions, below)';

/** A later turn: what the user said, what changed, and the plan as it stands. */
export function turnPrompt(plan: Plan, said: string): string {
  const parts: string[] = [section('The user says', [said || NO_MESSAGE])];
  const news = newsSection(plan);
  if (news) parts.push(news);
  const answers = answersSection(plan);
  if (answers) parts.push(answers);
  parts.push(section('The plan as it stands', [
    'Task and project ids are the ones to keep. A task marked `pinned` keeps the',
    'fleet and model the user chose by hand; a task past `queued` is no longer',
    'yours to rewrite. Priority, git rules and test commands below are the user\'s',
    'current choices; the `tests` you list are added to them, never removed.',
    compactPlan(plan, false),
  ]));
  parts.push(section('This turn', [
    'Answer the user, ask what still needs asking, and return the whole plan in',
    'the block: every project and task you want kept, with complete briefings.',
  ]));
  parts.push(MEETING_CONTRACT);
  return parts.join('\n\n');
}

/**
 * The turn after the brake: the same session, no more reading.
 *
 * Measured on a real meeting: twelve to-dos over three projects, and the
 * chair read 25 files and ran 47 searches in seven minutes without writing a
 * line, until the per-call brake stopped it -- twice, at one dollar and then
 * at two. What it read is in the session and still cached, so the answer
 * costs cents; thrown away, it was the whole call for "No answer.".
 */
export function wrapUpPrompt(why: string): string {
  return [
    section('You were stopped', [
      `Your last turn was stopped before you answered: ${why}.`,
      'Everything you read is still in this conversation. Do not open, search or',
      'list any more files: answer the user now with what you have -- the questions',
      'you need answered and the tasks you already see -- and name the files you',
      'did not get to, so they can be read in a later turn.',
    ]),
    MEETING_CONTRACT,
  ].join('\n\n');
}

/**
 * The meeting starts over from the minutes.
 *
 * The chair's session is gone (deleted, expired, or the tool refused to
 * resume it): a fresh session gets everything the first one got, plus the
 * minutes and the plan with its briefings, so nothing decided is lost.
 */
export function restartPrompt(plan: Plan, ctx: MeetingContext, said: string): string {
  const parts: string[] = [
    MEETING_ROLE,
    projectsSection(ctx),
    quotaSection(plan, ctx),
    fleetsSection(ctx),
    ...materialSection(plan),
  ];
  if (plan.minutes.length > 0) {
    parts.push(section('Minutes so far', [
      'Your earlier session is gone; this is what was said, oldest first.',
      ...plan.minutes.map((m) => `[${m.role === 'user' ? 'user' : m.role === 'ceo' ? 'you' : 'note'}] ${m.text}`),
    ]));
  }
  const answers = answersSection(plan);
  if (answers) parts.push(answers);
  if (plan.projects.length > 0) {
    parts.push(section('The plan as it stands', [
      'With the briefings already written. Keep the ids; a task past `queued` is',
      'no longer yours to rewrite; `pinned` choices stay.',
      compactPlan(plan, true),
    ]));
  }
  parts.push(section('The user says', [said || NO_MESSAGE]));
  parts.push(section('This turn', [
    'Pick the meeting up from here. Answer the user, ask what still needs asking,',
    'and return the whole plan in the block.',
  ]));
  parts.push(MEETING_CONTRACT);
  return parts.join('\n\n');
}

/* ───────────────────────── the block ───────────────────────── */

const MAX_QUESTIONS = 12;
const MAX_PROJECTS = 24;
const MAX_TASKS = 60;
const MAX_QUESTION = 500;

function str(v: unknown, cap: number): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > cap ? t.slice(0, cap) : t;
}

function nullable(v: unknown, cap: number): string | null {
  const s = str(v, cap);
  return s === '' || s === 'null' ? null : s;
}

/**
 * The chair's block, typed.
 *
 * Defensive like every other parser of model output: a block that is not
 * there, not JSON or not a plan yields `null`, and the prose stands on its
 * own in the minutes. Validation of names, providers and models is not here:
 * it needs the world, and it lives in the store where the names resolve.
 */
export function parseMeetingOutcome(text: string): ParsedPlan | null {
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

  const questions: ParsedPlan['questions'] = [];
  if (Array.isArray(obj['questions'])) {
    for (const q of obj['questions']) {
      if (questions.length >= MAX_QUESTIONS) break;
      const e = q as Record<string, unknown> | null;
      const textQ = str(e?.['text'], MAX_QUESTION);
      if (!textQ) continue;
      questions.push({ id: str(e?.['id'], 24) || `q${questions.length + 1}`, text: textQ });
    }
  }

  const projects: ParsedProject[] = [];
  let total = 0;
  if (Array.isArray(obj['projects'])) {
    for (const p of obj['projects']) {
      if (projects.length >= MAX_PROJECTS) break;
      const e = p as Record<string, unknown> | null;
      const name = str(e?.['name'], 64);
      if (!name) continue;
      const tasks: ParsedTask[] = [];
      if (Array.isArray(e?.['tasks'])) {
        for (const t of e['tasks'] as unknown[]) {
          if (total >= MAX_TASKS) break;
          const te = t as Record<string, unknown> | null;
          const title = str(te?.['title'], MAX_SUMMARY_CHARS);
          if (!title) continue;
          const provider = te?.['provider'] === 'codex' ? 'codex' : 'claude';
          const effort = te?.['effort'];
          const size = te?.['size'];
          tasks.push({
            id: nullable(te?.['id'], 64),
            title,
            briefing: str(te?.['briefing'], MAX_BRIEFING_CHARS),
            provider,
            model: nullable(te?.['model'], 64),
            effort: effort === 'low' || effort === 'medium' || effort === 'high' ? effort : null,
            size: size === 'small' || size === 'large' ? size : 'medium',
          });
          total += 1;
        }
      }
      const priority = typeof e?.['priority'] === 'number' && Number.isFinite(e['priority'])
        ? (e['priority'] as number) : projects.length + 1;
      projects.push({
        name,
        priority,
        tests: commandsOf(e?.['tests']),
        tasks,
      });
    }
  }

  // A block with neither a question nor a project is not a plan: noise that
  // happened to be JSON.
  if (questions.length === 0 && projects.length === 0 && obj['ready'] !== true) return null;
  return { ready: obj['ready'] === true, questions, projects };
}

import type { GitRules, Minute, PlanProject, PlanTask } from '../../shared/protocol.ts';
import { MAX_QUESTION_CHARS } from '../../shared/protocol.ts';
import { commandsOf } from './allow.ts';
import { MAX_NOTE_CHARS } from './memory.ts';
import { lastBlock, OUTCOME_FENCE } from './outcome.ts';
import { documentsOf } from './work.ts';

/**
 * What a planned task's worker receives, and the block it answers with.
 *
 * The worker is a fresh, non-interactive session in the project: nobody will
 * answer it. So it gets the chair's briefing verbatim, the lines of the
 * meeting that name its project, and the rules -- what it may run, what to
 * do with git -- and it is told, plainly, that a question stops the task and
 * that the briefing already answers what the meeting settled. The block at
 * the end says how it went in one of three words; `question` is the one that
 * needs you. A command it was refused goes in `needs`, which the panel turns
 * into a button: a permission is a flag, and no answer in words can grant it.
 */

/** How many lines of minutes travel with a task, and how long each may be. */
const MAX_MINUTE_LINES = 20;
const MAX_MINUTE_LINE = 500;

export interface PlanReport {
  status: 'done' | 'failed' | 'question';
  did: string | null;
  question: string | null;
  /** Commands it was refused and needs, as permission patterns. */
  needs: string[];
  /**
   * The documents it wrote for you to read, as paths inside the project.
   *
   * A task that only plans leaves its plan as a file in the repository, and
   * this is how the panel learns where it is: the worker says so, the server
   * checks the path, the row gets a button. Empty when the work was code.
   */
  wrote: string[];
}

export const PLAN_WORK_CONTRACT = [
  'End your answer with this block, and nothing after it:',
  OUTCOME_FENCE,
  '{"status": "done", "did": "one line: what you actually did", "question": null, "needs": [], "wrote": []}',
  '```',
  '`status` is done, failed, or question. `did` is one line and the only part of',
  'your answer the plan keeps. With `status: "question"`, put the question in',
  '`question`: the options and your recommendation, so the user can answer in a line.',
  '`needs` lists the commands you were refused and need, as permission patterns;',
  'when it is not empty, `status` is question.',
  '`wrote` lists the documents you wrote for the user to read -- a plan, a study, a',
  'report -- as paths relative to the repository; leave it empty when your work is',
  'code. A task that asks for a plan or a report and names no file gets one under',
  '`docs/`, as markdown, and you list it here: a plan that lives only in this answer',
  'is a plan nobody can open.',
].join('\n');

/** The lines of the meeting that speak of this project, oldest first. */
export function minutesFor(project: Pick<PlanProject, 'name'>, minutes: readonly Minute[]): string[] {
  const needle = project.name.toLowerCase();
  const out: string[] = [];
  for (const m of minutes) {
    if (m.role === 'system') continue;
    if (!m.text.toLowerCase().includes(needle)) continue;
    const line = m.text.replace(/\s+/g, ' ').trim();
    out.push(`- [${m.role === 'user' ? 'user' : 'chair'}] ${line.length > MAX_MINUTE_LINE ? `${line.slice(0, MAX_MINUTE_LINE - 1)}…` : line}`);
  }
  return out.length > MAX_MINUTE_LINES ? out.slice(out.length - MAX_MINUTE_LINES) : out;
}

/**
 * The rules as they apply: a project that is not under git has nothing to
 * commit or push, whatever its checkboxes say. `branch` is null there.
 */
export function effectiveGit(rules: GitRules, branch: string | null): GitRules {
  return branch === null ? { commit: false, push: false } : rules;
}

/**
 * The tests, which always run, and what the worker may run to do it.
 *
 * Before 2026-09-19 a checkbox decided, and "tests" granted only the common
 * runners: the decsim2 worker, told to run its PHP tests, was refused `php`
 * on every attempt and asked the user to edit a settings file. Now the
 * worker says which commands it was refused, and the panel allows them.
 */
export function testsRules(commands: readonly string[]): string[] {
  // One paragraph each: the prompt puts a blank line between the entries.
  return [
    'Run the project\'s tests and checks before you finish, after your last change. '
      + 'If the project has none, check what you can -- at least a syntax check of every '
      + 'file you touched -- and say in `did` that it has no tests.',
    commands.length > 0
      ? `Besides the common test runners you may run: ${commands.map((c) => `\`${c}\``).join(', ')}.`
      : 'The common test runners are allowed: npm test, npm run, npx, node --test, node --check, php -l, composer test, phpunit, pytest, cargo test, go test, make test.',
    'If a command you need for the tests is refused, do not work around it and do '
      + 'not ask the user to edit a settings file: stop with `status: "question"` and '
      + 'list the exact commands in `needs`, as permission patterns -- a whole command, '
      + 'or a prefix and `*` (`php tests/*`, `bash tests/smoke.sh`). The user allows '
      + 'them with one click, and this session resumes with them.',
  ];
}

function rules(project: PlanProject, commands: readonly string[], branch: string | null): string[] {
  const g = effectiveGit(project.git, branch);
  const out = ['# Rules', 'Work only inside this repository.'];
  if (branch === null) {
    out.push('This directory is not under git: do not run git, and leave your changes as files.');
  }
  if (g.commit) {
    out.push(
      'If the repository has a remote, run `git pull --rebase` before you start; if',
      'it conflicts, stop with `status: "failed"` and say so.',
    );
  }
  out.push(...testsRules(commands));
  if (branch !== null) {
    out.push(g.commit
      ? 'Commit as you go: small commits, an imperative subject of at most 72 characters, a body that says why.'
      : 'Do not commit: leave your changes in the working tree.');
    // A repository with no remote has nowhere to push: said, so the worker
    // does not fail a task whose work is done and committed.
    out.push(g.push
      ? `Push to \`${branch}\` when the tests pass, and only that branch. If the repository has no remote, there is nothing to push: say so in \`did\`.`
      : 'Never push.');
  }
  out.push(
    'Nobody will answer during this task. If the briefing does not settle a decision',
    'you must take, stop and ask with `status: "question"`: give the options and your',
    'recommendation. Do not ask what the briefing already answers, and do not ask',
    'about details a careful engineer would just decide.',
  );
  return out;
}

export interface PlanWorkInput {
  task: PlanTask;
  project: PlanProject;
  minutes: readonly Minute[];
  /** The project's branch now; `null` when it is not under git. */
  branch: string | null;
  /** What the project may run besides the common runners: the plan's `commands` for it. */
  commands: readonly string[];
}

/** The task, on stdin, for a fresh session. */
export function planTask(input: PlanWorkInput): string {
  const { task, project } = input;
  const parts: string[] = [
    `# ${task.title}`,
    `Project: ${project.name}. This task was planned in a meeting between the user and the ${task.provider} CEO of Towerglow; the briefing below is what they agreed.`,
    '# Briefing from the planning meeting',
    task.briefing || '(the chair wrote no briefing: do what the title says, carefully)',
  ];
  const lines = minutesFor(project, input.minutes);
  if (lines.length > 0) parts.push('# What the meeting said about this project', ...lines);
  if (task.answer) {
    parts.push(
      '# An earlier attempt asked, and the user answered',
      `Question: ${task.question ?? '(not recorded)'}`,
      `Answer: ${task.answer}`,
    );
  }
  parts.push(...rules(project, input.commands, input.branch));
  parts.push(PLAN_WORK_CONTRACT);
  return parts.join('\n\n');
}

/** The user's answer, on stdin, for the SAME session resumed. */
export function planAnswer(task: PlanTask): string {
  return [
    `You stopped with a question: ${task.question ?? '(not recorded)'}`,
    `The user's answer: ${task.answer ?? '(none)'}`,
    'Continue the same task under the same rules, and finish it.',
    PLAN_WORK_CONTRACT,
  ].join('\n\n');
}

/** A retry of a task that failed, in the same session when there is one. */
export function planRetry(task: PlanTask): string {
  return [
    `The previous attempt of "${task.title}" ended without finishing${task.reason ? ` (${task.reason})` : ''}.`,
    'Pick it up where it stopped, under the same rules, and finish it.',
    PLAN_WORK_CONTRACT,
  ].join('\n\n');
}

/**
 * The worker's block, typed.
 *
 * As defensive as `parseWorkReport`, and for the same reason: a model wrote
 * it. No block, or a status that is not one of the three, is `null`, and the
 * caller decides what a missing block means -- the prose is still there.
 */
export function parsePlanReport(text: string): PlanReport | null {
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
  const status = obj['status'];
  if (status !== 'done' && status !== 'failed' && status !== 'question') return null;
  const did = typeof obj['did'] === 'string' && obj['did'].trim() ? obj['did'].trim().slice(0, MAX_NOTE_CHARS) : null;
  const question = typeof obj['question'] === 'string' && obj['question'].trim()
    ? obj['question'].trim().slice(0, MAX_QUESTION_CHARS) : null;
  const needs = commandsOf(obj['needs']);
  const wrote = documentsOf(obj['wrote']);
  // Refused a command it needs, it has not finished, whatever status it
  // wrote: the tests always run, and a "done" without them is not done.
  if (needs.length > 0) return { status: 'question', did, question: question ?? needsQuestion(needs), needs, wrote };
  return { status, did, question, needs, wrote };
}

/** The question a worker that only listed its needs is asking. */
export function needsQuestion(needs: readonly string[]): string {
  const list = needs.map((c) => `\`${c}\``).join(', ');
  return `It was refused commands it needs to test its work: ${list}. Allow them to resume it.`.slice(0, MAX_QUESTION_CHARS);
}

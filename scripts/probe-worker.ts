import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GitRules } from '../src/shared/protocol.ts';
import {
  allowedToolsFor, disallowedToolsFor, gitDirOf, outsideSandboxDenied, projectMemoryOf, sandboxFor,
} from '../src/server/ceo/allow.ts';

/**
 * A worker's rules, tried on the real `claude`.
 *
 *   npm run probe:worker [-- <project folder>]
 *
 * The tests of `allow.ts` hold the flags; they cannot know how Claude Code
 * reads them. On 2026-10-13 two drafts of one rule passed every test and
 * failed the wrong way round on the real tool: a class written `[!m]` is
 * read as "`!` or `m`", so the rule meant to deny everything but a project's
 * notes denied only the notes, and every transcript could be read. This is
 * the check that saw it. Run it after touching a rule, a sandbox setting or
 * the flags of a worker, and after a new version of Claude Code.
 *
 * It lives here and not beside the module it tries: it names an address on
 * the web for a worker to be refused, and nothing that does belongs in the
 * server's build, where `check:bundle` would rightly stop it.
 *
 * It starts two short headless sessions in the project, with the flags
 * `fleet.ts` gives a worker, and asks each for a list of steps that change
 * nothing: dry runs, reads, writes that are expected to be refused. What
 * happened is read from the stream, never from what the model says, and
 * compared with what the rules promise. It costs a few cents of your plan,
 * and for five minutes the project counts as one where you are working.
 * The files it plants to be refused are removed when it ends.
 */

type Tool = 'Read' | 'Write' | 'Bash' | 'WebFetch';
type Outcome = 'runs' | 'refused';

interface Step {
  tool: Tool;
  /** The path, the command or the address: what the call is matched by. */
  arg: string;
  expect: Outcome;
  why: string;
  /**
   * A denied tool is taken away, not refused call by call: the model cannot
   * even try. For such a step no call at all is the refusal.
   */
  gone?: boolean;
}

interface Seen {
  tool: string;
  arg: string;
  failed: boolean;
  text: string;
}

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
/** Planted in your home folder, outside every project: what a command is NOT kept from reading. */
const OUTSIDE = path.join(HOME, 'tg-probe-readable.txt');
/** Planted beside the transcripts: names a rule must cover, none of them `memory`. */
const PLANTED = ['zz-tg-probe.txt', 'Mem-tg-probe.txt', 'memory-tg-probe.txt', 'mem'];

const short = (s: string): string => s.split(HOME).join('~');

/** The first file under a folder that is not a transcript: a tool output, usually. */
function firstFile(dir: string): string | null {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      const hit = firstFile(p);
      if (hit) return hit;
    } else if (!name.endsWith('.jsonl')) return p;
  }
  return null;
}

function hasRemote(cwd: string): boolean {
  try {
    return execFileSync('git', ['remote'], { cwd, encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
}

/** One session with a worker's flags; resolves with every tool call it made. */
function run(cwd: string, rules: GitRules, steps: readonly Step[]): Promise<Seen[]> {
  const memory = projectMemoryOf(cwd);
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
    '--permission-mode', 'acceptEdits', '--disable-slash-commands',
    '--permission-prompts', 'none',
    '--settings', JSON.stringify(sandboxFor(rules, gitDirOf(cwd), memory?.dir ?? null)),
    '--strict-mcp-config',
    '--allowedTools', ...allowedToolsFor(rules, []),
    '--disallowedTools', ...disallowedToolsFor(rules), ...outsideSandboxDenied(rules, memory),
  ];
  const task = [
    'This is a permissions check of your environment, asked by the owner of this machine.',
    'Do each step below once, in this order, with exactly the tool it names and exactly the',
    'path, address or command it gives. Do not change anything, do not retry a step that',
    'fails or is refused, and do nothing else. A refusal or a failure is an expected result',
    'here: go on to the next step. When all are done, answer only "done".',
    '',
    ...steps.map((s, i) => {
      if (s.tool === 'Read') return `${i + 1}. Read tool, limit 1: ${s.arg}`;
      if (s.tool === 'Write') return `${i + 1}. Write tool, content "x": ${s.arg}`;
      if (s.tool === 'WebFetch') return `${i + 1}. WebFetch tool, prompt "What is the title?": ${s.arg}`;
      return `${i + 1}. Bash tool: ${s.arg}`;
    }),
  ].join('\n');

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
    const seen: Seen[] = [];
    let carry = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      carry += chunk;
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const content = (rec as { message?: { content?: unknown } })?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content as Record<string, unknown>[]) {
          if (block['type'] === 'tool_use') {
            calls.set(String(block['id']), {
              name: String(block['name']),
              input: (block['input'] ?? {}) as Record<string, unknown>,
            });
          } else if (block['type'] === 'tool_result') {
            const call = calls.get(String(block['tool_use_id']));
            if (!call) continue;
            const raw = block['content'];
            const text = Array.isArray(raw)
              ? raw.map((x) => String((x as { text?: unknown })?.text ?? '')).join(' ')
              : String(raw ?? '');
            const i = call.input;
            seen.push({
              tool: call.name,
              arg: String(i['command'] ?? i['file_path'] ?? i['url'] ?? ''),
              failed: block['is_error'] === true,
              text: text.replace(/\s+/g, ' ').trim(),
            });
          }
        }
      }
    });
    child.on('error', reject);
    child.on('close', () => resolve(seen));
    child.stdin.end(task, 'utf8');
  });
}

/** Compare what happened with what the rules promise; returns how many steps disagree. */
function report(title: string, steps: readonly Step[], seen: readonly Seen[]): number {
  console.log(`\n${title}`);
  let wrong = 0;
  for (const step of steps) {
    const hit = seen.find((s) => s.tool === step.tool && s.arg === step.arg);
    const got: Outcome | 'not run' = !hit ? 'not run' : hit.failed ? 'refused' : 'runs';
    const ok = got === step.expect || (got === 'not run' && step.expect === 'refused' && step.gone === true);
    if (!ok) wrong += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${step.why}`);
    if (!ok) {
      console.log(`       expected ${step.expect}, ${got}: ${step.tool} ${short(step.arg)}`);
      if (hit) console.log(`       -> ${short(hit.text).slice(0, 200)}`);
    }
  }
  return wrong;
}

async function main(): Promise<number> {
  const cwd = path.resolve(process.argv[2] ?? process.cwd());
  const memory = projectMemoryOf(cwd);
  console.log(`worker rules, on the real claude, in ${short(cwd)}`);

  const closed: Step[] = [];
  const planted: string[] = [];
  if (memory) {
    const own = path.dirname(memory.dir);
    const note = fs.readdirSync(memory.dir).find((n) => n.endsWith('.md'));
    const transcript = fs.readdirSync(own).find((n) => n.endsWith('.jsonl'));
    const session = fs.readdirSync(own).find((n) => /^[0-9a-f]{8}-/.test(n) && fs.statSync(path.join(own, n)).isDirectory());
    const inner = session ? firstFile(path.join(own, session)) : null;
    const other = fs.readdirSync(PROJECTS)
      .filter((n) => n !== memory.slug)
      .map((n) => path.join(PROJECTS, n, 'memory'))
      .filter((d) => fs.existsSync(d))
      .map((d) => fs.readdirSync(d).filter((n) => n.endsWith('.md')).map((n) => path.join(d, n))[0])
      .find((f) => f !== undefined);
    for (const name of PLANTED) {
      const p = path.join(own, name);
      if (fs.existsSync(p)) continue;
      fs.writeFileSync(p, 'planted by the worker probe: a worker must not read this\n');
      planted.push(p);
      closed.push({ tool: 'Read', arg: p, expect: 'refused', why: `any other entry of the project folder is denied (${name})` });
    }
    if (note) {
      closed.push({ tool: 'Read', arg: path.join(memory.dir, note), expect: 'runs', why: 'the Read tool opens a note of this project' });
      closed.push({ tool: 'Bash', arg: `head -1 ${path.join(memory.dir, note)}`, expect: 'runs', why: 'and so does a command' });
    }
    if (transcript) {
      closed.push({ tool: 'Read', arg: path.join(own, transcript), expect: 'refused', why: 'a transcript of this project is denied to Read' });
      closed.push({ tool: 'Bash', arg: `python3 -c "print(open('${path.join(own, transcript)}').read(20))"`, expect: 'refused', why: 'and to a script' });
    }
    if (inner) closed.push({ tool: 'Read', arg: inner, expect: 'refused', why: 'a file in a session folder is denied' });
    if (other) {
      closed.push({ tool: 'Read', arg: other, expect: 'refused', why: 'another project\'s note is denied to Read' });
      closed.push({ tool: 'Bash', arg: `python3 -c "print(open('${other}').read(20))"`, expect: 'refused', why: 'and to a script' });
    }
    closed.push({ tool: 'Write', arg: path.join(memory.dir, 'tg-probe-note.md'), expect: 'refused', why: 'no note can be written' });
  } else {
    console.log('  (this project has no memory folder, or its rules cannot be exact: the notes are not probed)');
  }
  closed.push(
    { tool: 'WebFetch', arg: 'https://example.com', expect: 'runs', why: 'with web ticked a page is fetched' },
    { tool: 'Bash', arg: 'curl -sS -m 5 -o /dev/null https://example.com', expect: 'refused', why: 'and the shell still reaches no host' },
    { tool: 'Bash', arg: 'awk \'END { print NR }\' package.json | head -1', expect: 'runs', why: 'a pipeline runs without a permission' },
    { tool: 'Bash', arg: `touch ${path.join(HOME, 'tg-probe-outside.txt')}`, expect: 'refused', why: 'nothing is written outside the project' },
    { tool: 'Bash', arg: `ls ${path.join(HOME, '.ssh')}`, expect: 'refused', why: 'the credentials cannot be listed' },
    // Not guards: limits the documents state. A change here is a change to write down.
    { tool: 'Bash', arg: `cat ${OUTSIDE}`, expect: 'runs', why: 'known limit: a command reads a file of yours outside the project' },
    { tool: 'Read', arg: '/etc/hosts', expect: 'refused', why: 'the Read tool does not: a file outside the project is refused' },
  );
  if (gitDirOf(cwd)) {
    closed.push(
      { tool: 'Bash', arg: 'git add --dry-run package.json', expect: 'refused', why: 'with commit unticked git add is denied by name' },
      { tool: 'Bash', arg: 'touch .git/tg-probe', expect: 'refused', why: 'and the shell cannot write in .git' },
    );
  }

  const open: Step[] = [
    { tool: 'WebFetch', arg: 'https://example.com', expect: 'refused', gone: true, why: 'without web no page is fetched' },
  ];
  if (hasRemote(cwd)) {
    open.push(
      { tool: 'Bash', arg: 'git fetch --dry-run origin', expect: 'runs', why: 'with push ticked git fetch alone reaches the remote' },
      { tool: 'Bash', arg: 'git fetch --dry-run origin && echo reached', expect: 'refused', why: 'and chained to another command it does not' },
    );
  }

  let wrong = 0;
  const plantedOutside = !fs.existsSync(OUTSIDE);
  if (plantedOutside) fs.writeFileSync(OUTSIDE, 'planted by the worker probe: a file outside the project\n');
  try {
    wrong += report('commit and push unticked, web ticked', closed, await run(cwd, { commit: false, push: false, web: true }, closed));
    wrong += report('commit and push ticked, web unticked', open, await run(cwd, { commit: true, push: true }, open));
  } finally {
    if (plantedOutside) fs.rmSync(OUTSIDE, { force: true });
    for (const p of planted) fs.rmSync(p, { force: true });
    for (const stray of [path.join(HOME, 'tg-probe-outside.txt'), path.join(cwd, '.git', 'tg-probe')]) {
      if (fs.existsSync(stray)) {
        console.log(`  a guard failed and left ${short(stray)}: removed`);
        fs.rmSync(stray, { force: true });
      }
    }
    const note = memory ? path.join(memory.dir, 'tg-probe-note.md') : null;
    if (note && fs.existsSync(note)) {
      console.log(`  a guard failed and left ${short(note)}: removed`);
      fs.rmSync(note, { force: true });
    }
  }
  console.log(wrong === 0 ? '\nevery rule held' : `\n${wrong} rule${wrong === 1 ? '' : 's'} did not hold`);
  return wrong === 0 ? 0 : 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(String((err as Error)?.message ?? err));
    process.exitCode = 2;
  },
);

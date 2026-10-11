import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeLines, codexLines, follow, REPLAY_BYTES, toolSummary, transcriptFor } from '../src/server/watch.ts';
import { followCommand, shellQuote, viewerTty } from '../src/server/focus.ts';
import { slugFor } from '../src/server/paths.ts';
import type { PathPolicy } from '../src/server/paths.ts';

/*
 * The window a worker gets instead of a terminal: what it prints, where it
 * reads from, and the command that opens it. The shapes are the ones on disk
 * on 2026-09-19, from the translation worker that hit the 5h limit.
 */

const CWD = '/Users/me/Desktop/my_dashboard';
const SID = '8f4b1f21-6cd9-453f-a9ad-7dcf90898986';

test('a prompt, a text, a call and its result become a few readable lines', () => {
  assert.deepEqual(claudeLines({ type: 'user', message: { content: 'Translate the repo\nline two' } }, CWD),
    ['', '› Translate the repo', '  line two']);
  assert.deepEqual(claudeLines({
    type: 'assistant',
    message: { content: [
      { type: 'thinking', thinking: 'hidden' },
      { type: 'text', text: 'I start by measuring the scope of the job.' },
      { type: 'tool_use', name: 'Read', input: { file_path: `${CWD}/src/server/ceo/allow.ts` } },
    ] },
  }, CWD), ['', 'I start by measuring the scope of the job.', '● Read(src/server/ceo/allow.ts)']);
  const result = claudeLines({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'a\nb\nc\nd\ne' }] },
  }, CWD);
  assert.deepEqual(result, ['  ⎿ a', '    b', '    c', '    … 2 more lines']);
});

test('records that are not work print nothing', () => {
  assert.deepEqual(claudeLines({ type: 'user', isMeta: true, message: { content: 'caveat' } }, CWD), []);
  assert.deepEqual(claudeLines({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }, CWD), []);
  assert.deepEqual(claudeLines({ type: 'last-prompt' }, CWD), []);
  assert.deepEqual(claudeLines({ type: 'assistant', message: { content: 'not an array' } }, CWD), []);
  assert.deepEqual(claudeLines(null, CWD), []);
});

test('escape sequences in a transcript never reach the terminal', () => {
  // A tool result can carry a fetched page or a command's output: printed as
  // it was, an escape sequence in it could rename the window, move the cursor
  // over earlier lines or hide text. Line breaks and tabs stay.
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const hostile = `ok${ESC}]0;pwned${BEL}\tdone${ESC}[2K${String.fromCharCode(0x9b)}A\nnext`;
  const lines = [
    ...claudeLines({ type: 'assistant', message: { content: [{ type: 'text', text: hostile }] } }, CWD),
    ...claudeLines({ type: 'user', message: { content: [{ type: 'tool_result', content: hostile }] } }, CWD),
    ...codexLines({ type: 'response_item', payload: { type: 'function_call_output', output: hostile } }),
  ];
  for (const line of lines) {
    for (const ch of line) {
      const c = ch.charCodeAt(0);
      assert.ok(!(c < 0x20 && c !== 0x09) && !(c >= 0x7f && c <= 0x9f), `control character ${c} in ${JSON.stringify(line)}`);
    }
  }
  assert.ok(lines.some((l) => l.includes('ok]0;pwned\tdone[2KA')), 'the visible text is kept');
});

test('a long briefing shows its head and says how many lines are left', () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const lines = claudeLines({ type: 'user', message: { content: long } }, CWD);
  assert.equal(lines.at(-1), '  … 16 more lines');
});

test('a call\'s summary says what it does, not its whole input', () => {
  assert.equal(toolSummary('Bash', { command: 'npm test\nsecond line' }, CWD), 'Bash(npm test)');
  assert.equal(toolSummary('Grep', { pattern: 'turret' }, CWD), 'Grep(turret)');
  assert.equal(toolSummary('Task', { description: 'translate comments' }, CWD), 'Task(translate comments)');
  assert.equal(toolSummary('Write', { file_path: '/elsewhere/x.ts' }, CWD), 'Write(/elsewhere/x.ts)');
  assert.ok(toolSummary('Bash', { command: 'x'.repeat(500) }, CWD).length < 140);
});

test('a Codex rollout is read from its response_items, and tagged instructions stay out', () => {
  const item = (payload: object): object => ({ type: 'response_item', payload });
  assert.deepEqual(codexLines(item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] })), []);
  assert.deepEqual(codexLines(item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] })), ['', 'done']);
  assert.deepEqual(codexLines(item({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }) })), ['● shell(bash -lc ls)']);
  assert.deepEqual(codexLines(item({ type: 'function_call_output', output: JSON.stringify({ output: 'one\ntwo' }) })), ['  ⎿ one', '    two']);
  assert.deepEqual(codexLines({ type: 'event_msg', payload: { type: 'agent_message', message: 'dup' } }), []);
});

function claudeDir(): { policy: PathPolicy; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-watch-'));
  const policy: PathPolicy = { claudeDir: path.join(root, '.claude'), codexDir: path.join(root, '.codex'), homeDir: root };
  const dir = path.join(policy.claudeDir, 'projects', slugFor(CWD));
  fs.mkdirSync(dir, { recursive: true });
  return { policy, file: path.join(dir, `${SID}.jsonl`) };
}

test('the transcript is where the tailer reads it, and a non-id never becomes a path', () => {
  const { policy, file } = claudeDir();
  fs.writeFileSync(file, '');
  assert.equal(transcriptFor('claude', SID, CWD, policy, Date.now()), file);
  assert.equal(transcriptFor('claude', '../../etc/passwd', CWD, policy, Date.now()), null);
  assert.equal(transcriptFor('claude', 'ffffffff-0000-0000-0000-000000000000', CWD, policy, Date.now()), null, 'not there');
});

test('the view prints the work done, follows the new work and stops when the process dies', async () => {
  const { policy, file } = claudeDir();
  const line = (o: object): string => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(file, line({ type: 'user', message: { content: 'the task' } }));
  let out = '';
  let ticks = 0;
  const code = await follow({
    provider: 'claude', sessionId: SID, cwd: CWD, policy,
    alive: () => ticks < 3,
    write: (t) => { out += t; },
    sleep: async () => {
      ticks += 1;
      // the worker writes while the window watches
      if (ticks === 1) fs.appendFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }));
      // half a line, then the rest: it must not print a broken record
      if (ticks === 2) fs.appendFileSync(file, '{"type":"assistant","message":{"content":[{"type":"text",');
      if (ticks === 3) fs.appendFileSync(file, '"text":"done"}]}}\n');
    },
    now: () => Date.now(),
    paint: { prompt: (s) => s, tool: (s) => s, dim: (s) => s, error: (s) => s },
  });
  assert.equal(code, 0);
  assert.match(out, /› the task/);
  assert.match(out, /● Bash\(npm test\)/);
  assert.match(out, /\ndone\n/, 'a line that arrived in halves prints whole, afterwards');
  assert.match(out, /the session has ended/);
  assert.match(out, new RegExp(`claude --resume ${SID}`));
});

test('a session that dies before writing its transcript says so instead of waiting forever', async () => {
  const { policy } = claudeDir();
  let out = '';
  const code = await follow({
    provider: 'claude', sessionId: SID, cwd: CWD, policy, alive: () => false,
    write: (t) => { out += t; }, sleep: async () => {}, now: () => Date.now(),
    paint: { prompt: (s) => s, tool: (s) => s, dim: (s) => s, error: (s) => s },
  });
  assert.equal(code, 1);
  assert.match(out, /ended before it wrote a transcript/);
});

test('every value on the window\'s command line is a single shell word', () => {
  assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
  const cmd = followCommand({
    provider: 'claude', sessionId: SID, cwd: "/Users/me/my project's", pid: 4242,
    node: '/usr/local/bin/node', entry: '/opt/tower glow/bin/towerglow.mjs',
    claudeDir: '/Users/me/.claude', codexDir: '/Users/me/.codex',
  });
  assert.equal(cmd, `cd '/Users/me/my project'\\''s' && '/usr/local/bin/node' '/opt/tower glow/bin/towerglow.mjs' `
    + `watch ${SID} --provider claude --cwd '/Users/me/my project'\\''s' --pid 4242 `
    + `--claude-dir '/Users/me/.claude' --codex-dir '/Users/me/.codex'`);
});

test('a second click finds the window the first one opened, and only that one', () => {
  const ps = [
    'ttys001  -bash',
    `ttys004  /usr/local/bin/node /opt/tg/bin/towerglow.mjs watch ${SID} --provider claude --cwd /x --pid 4242`,
    `??       /usr/local/bin/node /opt/tg/bin/towerglow.mjs watch ffff0000-aaaa --provider claude`,
  ].join('\n');
  assert.equal(viewerTty(ps, SID), 'ttys004');
  assert.equal(viewerTty(ps, 'ffff0000-aaaa'), null, 'without a tty there is no window to bring forward');
  assert.equal(viewerTty(ps, '8f4b1f21'), null, 'a prefix is not the same session');
});

/*
 * The log of a task that is over.
 *
 * A worker's window used to be reachable only through its astronaut, which
 * goes back aboard when the session ends: of a finished task nothing could
 * be read but the worker's last message. The transcript is still on disk, and
 * `--once` prints it whole and stops -- whole, because the four-megabyte
 * replay of a live view drops the beginning, and the beginning of a planning
 * worker's transcript is where it reads the briefing and decides.
 */
test('once prints the whole transcript, beginning included, and stops without a process to watch', async () => {
  const { policy, file } = claudeDir();
  const line = (o: object): string => `${JSON.stringify(o)}\n`;
  // Well past REPLAY_BYTES: a live view would skip the first record.
  const filler = 'x'.repeat(1024);
  let text = line({ type: 'user', message: { content: 'the briefing' } });
  for (let i = 0; i < 5000; i += 1) {
    text += line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${CWD}/f${i}.ts`, note: filler } }] } });
  }
  text += line({ type: 'assistant', message: { content: [{ type: 'text', text: 'all done' }] } });
  fs.writeFileSync(file, text);
  assert.ok(fs.statSync(file).size > REPLAY_BYTES, 'the fixture must be bigger than the live replay');
  let out = '';
  let slept = 0;
  const code = await follow({
    provider: 'claude', sessionId: SID, cwd: CWD, policy, alive: null, once: true,
    write: (t) => { out += t; }, sleep: async () => { slept += 1; }, now: () => Date.now(),
    paint: { prompt: (s) => s, tool: (s) => s, dim: (s) => s, error: (s) => s },
  });
  assert.equal(code, 0);
  assert.equal(slept, 0, 'nothing to wait for: it prints and stops');
  assert.match(out, /the log of Claude Code session/);
  assert.match(out, /› the briefing/, 'the first record is there: no replay cap on a log');
  assert.match(out, /● Read\(f4999\.ts\)/);
  assert.match(out, /\nall done\n/);
  assert.doesNotMatch(out, /earlier work not shown/);
  assert.match(out, /end of the transcript/);
  assert.match(out, new RegExp(`claude --resume ${SID}`));
});

test('once with no transcript on disk says so instead of waiting for one', async () => {
  const { policy } = claudeDir();
  let out = '';
  let slept = 0;
  const code = await follow({
    provider: 'claude', sessionId: SID, cwd: CWD, policy, alive: null, once: true,
    write: (t) => { out += t; }, sleep: async () => { slept += 1; }, now: () => Date.now(),
    paint: { prompt: (s) => s, tool: (s) => s, dim: (s) => s, error: (s) => s },
  });
  assert.equal(code, 1);
  assert.equal(slept, 0);
  assert.match(out, /no transcript on disk/);
});

test('a window on a session that is over runs the log, not a follow of a dead pid', () => {
  const cmd = followCommand({
    provider: 'claude', sessionId: SID, cwd: '/Users/me/p', pid: null,
    node: '/usr/local/bin/node', entry: '/opt/tg/bin/towerglow.mjs',
    claudeDir: '/Users/me/.claude', codexDir: '/Users/me/.codex',
  });
  assert.match(cmd, new RegExp(` watch ${SID} --provider claude --cwd '/Users/me/p' --once `));
  assert.doesNotMatch(cmd, /--pid/);
  // The marker a second click looks for is the same: one window per session, alive or not.
  assert.equal(viewerTty(`ttys002  ${cmd.slice(cmd.indexOf("'/usr/local/bin/node'"))}`.replace(/'/g, ''), SID), 'ttys002');
});

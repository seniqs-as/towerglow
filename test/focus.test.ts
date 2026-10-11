import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDocument, revealCommand, shellInCommand, terminalOf, typeable } from '../src/server/focus.ts';
import type { Proc } from '../src/server/focus.ts';

function table(...rows: [number, number, string, string][]): Map<number, Proc> {
  const m = new Map<number, Proc>();
  for (const [pid, ppid, tty, comm] of rows) m.set(pid, { pid, ppid, tty, comm });
  return m;
}

/*
 * The real chain, measured on 2026-09-13 with `ps -axo pid=,ppid=,tty=,comm=`
 * while a CEO worker was running: the child has no tty, the server has none,
 * and the first tty met walking up is the one of the human session that had
 * started the server.
 */
const REAL = table(
  [38339, 37999, '??', 'claude'],                       // the CEO worker
  [37999, 37997, '??', 'node'],                         // the towerglow server
  [37997, 47539, '??', '/bin/bash'],
  [47539, 47274, 'ttys003', 'claude'],                  // the watcher's session
  [47274, 47273, 'ttys003', '-bash'],
  [47273, 20158, 'ttys003', 'login'],
  [20158, 1, '??', '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'],
);

test('a process without a tty has no terminal, and does not take its parent\'s', () => {
  // The observed bug: clicking the CEO worker's badge brought up the window of
  // whoever was watching. Not "no terminal" but the WRONG terminal, which is
  // worse because it looks like it worked.
  assert.equal(terminalOf(REAL, 38339), null);
  assert.equal(terminalOf(REAL, 37999), null, 'not even the server has a terminal');
});

test('a session with a tty of its own finds its application', () => {
  assert.deepEqual(terminalOf(REAL, 47539), { tty: 'ttys003', app: 'Terminal' });
});

test('a pid that no longer exists has no terminal', () => {
  assert.equal(terminalOf(REAL, 99999), null);
});

test('without a known terminal among the parents, Terminal is tried anyway', () => {
  // There is a tty: the window exists, it is only the application that is unknown.
  const t = table([100, 1, 'ttys009', 'claude']);
  assert.deepEqual(terminalOf(t, 100), { tty: 'ttys009', app: 'Terminal' });
});

/*
 * Opening a document a worker wrote.
 *
 * The path is the worker's own word, kept in the ledger: it must resolve
 * inside the project -- through symlinks too -- exist, and be a document.
 * `open` on a script would run it, and the worker is a model.
 */
function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doc-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'plan.md'), '# plan\n');
  fs.writeFileSync(path.join(root, 'run.sh'), 'echo hi\n');
  fs.writeFileSync(path.join(os.tmpdir(), 'tg-doc-outside.md'), 'outside\n');
  fs.symlinkSync(path.join(os.tmpdir(), 'tg-doc-outside.md'), path.join(root, 'docs', 'link.md'));
  return root;
}

test('a document inside the project opens with the resolved path, and only a document', async () => {
  const root = project();
  const launched: string[][] = [];
  const launch = async (cmd: string, args: string[]): Promise<void> => { launched.push([cmd, ...args]); };
  const ok = await openDocument(root, 'docs/plan.md', launch);
  assert.equal(ok.ok, true);
  assert.equal(launched.length, 1);
  assert.equal(launched[0]![launched[0]!.length - 1], fs.realpathSync(path.join(root, 'docs', 'plan.md')));
  // A script is not a document, whatever the worker called it.
  assert.deepEqual(await openDocument(root, 'run.sh', launch), { ok: false, reason: 'not a document' });
  assert.equal(launched.length, 1, 'nothing else was launched');
});

test('a document name that is a symlink to a script inside the project never opens', async () => {
  // The extension used to be checked on the name only, and `open` got the
  // file behind it: `notes.md` linked to `run.sh` would have run the script.
  const root = project();
  fs.symlinkSync(path.join(root, 'run.sh'), path.join(root, 'docs', 'notes.md'));
  const launch = async (): Promise<void> => { throw new Error('must not be called'); };
  assert.deepEqual(await openDocument(root, 'docs/notes.md', launch), { ok: false, reason: 'not a document' });
});

test('a path that leaves the project never opens: dot-dot, absolute, or a symlink pointing out', async () => {
  const root = project();
  const launch = async (): Promise<void> => { throw new Error('must not be called'); };
  assert.equal((await openDocument(root, '../tg-doc-outside.md', launch)).ok, false);
  assert.equal((await openDocument(root, path.join(os.tmpdir(), 'tg-doc-outside.md'), launch)).ok, false);
  assert.equal((await openDocument(root, 'docs/link.md', launch)).ok, false, 'the symlink resolves outside');
  assert.equal((await openDocument(root, 'docs/missing.md', launch)).ok, false);
  assert.equal((await openDocument(root, 'docs', launch)).ok, false, 'a folder is not a document');
  assert.equal((await openDocument('relative/root', 'docs/plan.md', launch)).ok, false);
});

test('a finished session opens a shell in its project, with the folder as one quoted word', () => {
  assert.equal(shellInCommand('/Users/a/my project'), "cd '/Users/a/my project'");
  // A quote in a folder name closes nothing: it cannot append a command.
  assert.equal(shellInCommand("/tmp/x'; rm -rf ~"), `cd '/tmp/x'\\''; rm -rf ~'`);
});

test('showing a project folder never launches it, even when it is named like an app', () => {
  // `open tool.app` runs the app: a repository cloned under that name, with a
  // script in Contents/MacOS, ran on the click meant to show its files.
  assert.deepEqual(revealCommand('/Users/me/code/tool.app', 'darwin'), { cmd: 'open', args: ['-R', '/Users/me/code/tool.app'] });
  assert.deepEqual(revealCommand('/Users/me/code/notes.pkg', 'darwin'), { cmd: 'open', args: ['-R', '/Users/me/code/notes.pkg'] });
  // A plain folder still opens as itself.
  assert.deepEqual(revealCommand('/Users/me/code/my_dashboard', 'darwin'), { cmd: 'open', args: ['/Users/me/code/my_dashboard'] });
  assert.deepEqual(revealCommand('/home/me/code/proj', 'linux'), { cmd: 'xdg-open', args: ['/home/me/code/proj'] });
  assert.equal(revealCommand('C:\\code', 'win32'), null);
});

test('a path with control characters is never typed into a terminal', () => {
  // Terminal's `do script` types the command as if from the keyboard: a ^U in
  // a folder name would erase the quoted cd typed before it and leave the rest
  // of the name to run. Quoting cannot help, so such a path is refused.
  const ctrlU = String.fromCharCode(0x15);
  assert.equal(typeable(`/Users/me/code/x${ctrlU}touch pwned`), false);
  assert.equal(typeable(`/Users/me/code/a${String.fromCharCode(0x1b)}[2J`), false);
  assert.equal(typeable(`/Users/me/code/a${String.fromCharCode(0x9b)}b`), false);
  assert.equal(typeable("/Users/me/code/it's fine $(not run)"), true, 'quotes and $() are the shell quote\'s job');
  assert.equal(typeable('/Users/me/code/with\ttab'), true);
});

#!/usr/bin/env node
/**
 * The observe-only version must be obtainable by DELETING one folder.
 *
 * It is the condition for deriving two projects from a single tree: `towerglow`
 * without CEOs, which opens no socket to the outside and can say so, and
 * `towerglow-ceo`, which has them. A promise like that holds only as long as
 * someone checks it, and this is the check.
 *
 * It does not touch the real tree: it copies the sources elsewhere, removes
 * `src/server/ceo/` there and recompiles. If anything outside that folder named
 * it, tsc says so.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CEO_DIR = path.join('src', 'server', 'ceo');

/**
 * Literal imports of the folder allowed from outside: none. The one place that
 * loads it, cli.ts, composes the path at runtime (`['.', 'ceo', 'index.ts']`),
 * because TypeScript resolves even a dynamic import written as a literal.
 */
const ALLOWED = [];

function fail(message) {
  process.stderr.write(`\n✗ check:passive — ${message}\n\n`);
  process.exit(1);
}

/* ── 1. no static import of the folder from outside ──────────────────────── */

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.(ts|mjs|js)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

const offenders = [];
for (const abs of walk(path.join(ROOT, 'src'))) {
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith(CEO_DIR)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  // A `from '...ceo/...'` is a static link: it survives the deletion only
  // if the folder is there.
  for (const m of text.matchAll(/from\s+'([^']*\/ceo\/[^']*)'/g)) {
    offenders.push(`${rel}: static import from ${m[1]}`);
  }
  for (const m of text.matchAll(/import\(\s*'([^']*\/ceo\/[^']*)'\s*\)/g)) {
    const allowed = ALLOWED.some((a) => rel === a.file && text.includes(a.needle));
    if (!allowed) offenders.push(`${rel}: undeclared dynamic import from ${m[1]}`);
  }
}
if (offenders.length > 0) fail(`the CEO folder is named from outside:\n  ${offenders.join('\n  ')}`);

/* ── 2. without the folder, it still compiles ────────────────────────────── */

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-passive-'));
try {
  for (const item of ['src', 'tsconfig.base.json', 'tsconfig.server.json', 'tsconfig.client.json', 'package.json']) {
    fs.cpSync(path.join(ROOT, item), path.join(work, item), { recursive: true });
  }
  // The modules are lent, not copied: they are hundreds of megabytes.
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(work, 'node_modules'), 'dir');

  fs.rmSync(path.join(work, CEO_DIR), { recursive: true, force: true });
  if (fs.existsSync(path.join(work, CEO_DIR))) fail('could not remove the folder from the copy');

  try {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.server.json', '--noEmit'], {
      cwd: work, stdio: 'pipe', encoding: 'utf8',
    });
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    fail(`without src/server/ceo/ the server does not compile:\n\n${out}\n`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

process.stdout.write('✓ passive: without src/server/ceo/ the server still compiles\n');

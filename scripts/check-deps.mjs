#!/usr/bin/env node
/** The runtime tree must match the committed allowlist exactly. */
import { execFileSync } from 'node:child_process';

const ALLOWED = new Set(['ws']);

const raw = execFileSync('npm', ['ls', '--all', '--omit=dev', '--json'], { encoding: 'utf8' });
const tree = JSON.parse(raw);

const found = new Set();
(function walk(node) {
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    // An optional peer that is not installed shows up as an empty object,
    // without `version`: it is not part of the real tree and must not count.
    if (!child || typeof child.version !== 'string') continue;
    found.add(name);
    walk(child);
  }
})(tree);

const extra = [...found].filter((n) => !ALLOWED.has(n));
const missing = [...ALLOWED].filter((n) => !found.has(n));

if (extra.length || missing.length) {
  if (extra.length) console.error(`✗ unexpected runtime dependencies: ${extra.join(', ')}`);
  if (missing.length) console.error(`✗ expected dependencies missing: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`✓ runtime tree: ${[...found].join(', ') || '(empty)'}`);

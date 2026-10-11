#!/usr/bin/env node
// Startup shim.
//
// The sources take precedence over the build: Node 22 runs TypeScript
// directly, and in development a stale dist would silently run old code.
// In the published package `files` includes only bin/ and dist/, so the
// sources are not there and the build is used.
// `node:sqlite` emits an ExperimentalWarning on every start. We use it only
// read-only for the Codex indexes, and for whoever launches the tool it is
// noise that leads to no action. It has to be intercepted HERE: this is the
// only code that runs before the imports, and the warning fires on the
// module's first use.
// Only this one is silenced; every other warning still comes through.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const message = typeof warning === 'string' ? warning : (warning?.message ?? '');
  if (/SQLite is an experimental feature/i.test(message)) return;
  return emitWarning(warning, ...rest);
};

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'src', 'server', 'cli.ts');
const built = join(here, '..', 'dist', 'server', 'server', 'cli.js');

const target = existsSync(source) ? source : built;
if (!existsSync(target)) {
  process.stderr.write("towerglow: neither sources nor build present. Run 'npm run build'.\n");
  process.exit(1);
}
await import(pathToFileURL(target).href);

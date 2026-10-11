#!/usr/bin/env node
/**
 * Fails if anything in dist/ could talk to the outside world.
 * It is the check that makes the "zero egress" promise verifiable without
 * having to trust the README.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['dist/client', 'dist/server'];
const EXTS = new Set(['.js', '.mjs', '.css', '.html', '.map']);

const RULES = [
  { re: /https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])[a-z0-9]/gi, why: 'non-loopback URL' },
  { re: /\bfetch\s*\(/g, why: 'fetch()' },
  { re: /XMLHttpRequest/g, why: 'XMLHttpRequest' },
  { re: /sendBeacon/g, why: 'navigator.sendBeacon' },
  { re: /\bEventSource\b/g, why: 'EventSource' },
  { re: /RTCPeerConnection/g, why: 'WebRTC' },
  { re: /importScripts/g, why: 'importScripts' },
  { re: /\b(unpkg|jsdelivr|cdnjs|esm\.sh)\b/gi, why: 'CDN' },
  { re: /fonts\.(googleapis|gstatic)/gi, why: 'remote fonts' },
];

// Declared exceptions, one by one, each with its reason.
// This list must stay short and readable: it is where a reviewer of the repo
// checks that no way out has been passed off as harmless.
const ALLOWED = [
  { re: /ws:\/\/127\.0\.0\.1/, why: 'WebSocket to our own loopback server' },
  { re: /ws:\/\/localhost/, why: 'same, hostname form' },
  { re: /http:\/\/127\.0\.0\.1/, why: 'same' },
  { re: /www\.w3\.org\/1999\/xhtml/, why: 'XML namespace for createElementNS: an identifier, never downloaded' },
  { re: /www\.w3\.org\/2000\/svg/, why: 'SVG namespace: an identifier, never downloaded' },
  { re: /jcgt\.org\/published/, why: 'bibliographic citation inside the three.js GLSL source' },
];

function* files(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (EXTS.has(extname(p))) yield p;
  }
}

let failures = 0;
let scanned = 0;

for (const root of ROOTS) {
  for (const file of files(root)) {
    scanned++;
    const text = readFileSync(file, 'utf8');
    for (const { re, why } of RULES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const hit = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30);
        if (ALLOWED.some((a) => a.re.test(hit))) continue;
        console.error(`✗ ${file}: ${why} → …${hit.replace(/\s+/g, ' ')}…`);
        failures++;
      }
    }
  }
}

if (scanned === 0) {
  console.error("✗ no files scanned: run 'npm run build' first");
  process.exit(1);
}
if (failures > 0) {
  console.error(`\n✗ ${failures} suspicious occurrences in ${scanned} files`);
  process.exit(1);
}
console.log(`✓ zero-egress: ${scanned} files scanned, no way out to the outside world`);

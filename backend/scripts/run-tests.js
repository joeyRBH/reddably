#!/usr/bin/env node
'use strict';

// Single entrypoint for the backend test suite — `npm test` from the repo root.
//
// The suite is plain Node scripts: every backend/tests/*.test.js runs standalone
// (`node backend/tests/foo.test.js`) and signals its result with the process exit
// code. That style is deliberate — no framework, no build step, per CLAUDE.md —
// and this runner keeps it: it discovers the files, runs each in its own process
// so a require-cache mock in one can never leak into another, and aggregates the
// results into one pass/fail verdict.
//
// Output is quiet on success (one line per file) and loud on failure (the whole
// captured stdout+stderr of the failing file), so a green run stays readable and
// a red one gives you everything without a second command.
//
//   npm test                  run every test file
//   npm test -- claim         run only files whose name contains "claim"
//   npm test -- --verbose     stream each file's own output as it runs
//
// Exit code is 0 only when every file passed; any failure — a non-zero exit, a
// crash, or a signal kill — makes it 1.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const TESTS_DIR = path.join(REPO_ROOT, 'backend', 'tests');

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const filters = argv.filter((a) => !a.startsWith('--'));

const all = fs
  .readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

const files = filters.length
  ? all.filter((f) => filters.some((needle) => f.includes(needle)))
  : all;

if (all.length === 0) {
  console.error(`No test files found in ${path.relative(REPO_ROOT, TESTS_DIR)}.`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`No test files match ${filters.join(', ')} (${all.length} available).`);
  process.exit(1);
}

console.log(`Running ${files.length} test file${files.length === 1 ? '' : 's'}\n`);

const failures = [];
const startedAt = Date.now();

for (const file of files) {
  const rel = path.join('backend', 'tests', file);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [path.join(TESTS_DIR, file)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: verbose ? 'inherit' : 'pipe',
    env: process.env,
  });
  const ms = Date.now() - t0;

  // status is null when the child was killed by a signal (OOM, timeout kill) —
  // never a pass. res.error covers a spawn that never started at all.
  const ok = !res.error && res.status === 0;
  if (ok) {
    console.log(`  ok    ${rel} (${ms}ms)`);
    continue;
  }

  const reason = res.error
    ? res.error.message
    : res.status === null
      ? `killed by signal ${res.signal}`
      : `exit ${res.status}`;
  console.log(`  FAIL  ${rel} (${ms}ms) — ${reason}`);
  failures.push({
    rel,
    reason,
    output: verbose ? '' : `${res.stdout || ''}${res.stderr || ''}`,
  });
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

if (failures.length) {
  for (const f of failures) {
    console.log(`\n${'='.repeat(72)}\n${f.rel} — ${f.reason}\n${'='.repeat(72)}`);
    if (f.output.trim()) console.log(f.output.trimEnd());
  }
  console.log(
    `\n${files.length - failures.length}/${files.length} test files passed in ${elapsed}s — ` +
    `${failures.length} FAILED:`
  );
  failures.forEach((f) => console.log(`  ${f.rel}`));
  process.exit(1);
}

console.log(`\n${files.length}/${files.length} test files passed in ${elapsed}s`);

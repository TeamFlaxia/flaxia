#!/usr/bin/env node
// File-size ratchet: large files may shrink but must not grow, and new files
// must stay under the limit. Regenerate the baseline only after a reviewed
// split or move:
//
//   node scripts/check-file-size.mjs --update
//
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts/file-size-baseline.json');
const LIMIT = 500;
const ROOTS = ['src', 'functions'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.wrangler', '.git', 'coverage']);
const SKIP_SUFFIXES = ['.d.ts', '.generated.ts'];

function collect(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...collect(join(dir, entry.name)));
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name)) continue;
    if (SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
    files.push(join(dir, entry.name));
  }
  return files;
}

function countLines(source) {
  if (source.length === 0) return 0;
  return source.replace(/\n$/, '').split('\n').length;
}

function scan() {
  const sizes = {};
  for (const root of ROOTS) {
    for (const absolute of collect(join(ROOT, root))) {
      const path = relative(ROOT, absolute).replaceAll('\\', '/');
      sizes[path] = countLines(readFileSync(absolute, 'utf8'));
    }
  }
  return Object.fromEntries(Object.entries(sizes).sort(([a], [b]) => a.localeCompare(b)));
}

function overLimit(sizes) {
  return Object.fromEntries(Object.entries(sizes).filter(([, lines]) => lines > LIMIT));
}

const sizes = scan();
const large = overLimit(sizes);

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(large, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(large).length} files over ${LIMIT} lines to scripts/file-size-baseline.json`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error('Missing scripts/file-size-baseline.json. Run: node scripts/check-file-size.mjs --update');
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const violations = [];

for (const [file, lines] of Object.entries(large)) {
  if (!(file in baseline)) {
    violations.push(`${file}: ${lines} lines (new file over ${LIMIT}; split it or update the baseline deliberately)`);
    continue;
  }
  if (lines > baseline[file]) {
    violations.push(`${file}: ${lines} lines (baseline ${baseline[file]}; files may shrink, not grow)`);
  }
}

for (const file of Object.keys(baseline)) {
  if (!(file in sizes)) {
    violations.push(`${file}: listed in baseline but no longer exists; remove it to tighten the ratchet`);
  }
}

if (violations.length > 0) {
  console.error(`File-size guardrail failed (limit ${LIMIT} lines):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(`File-size guardrail passed (${Object.keys(large).length} baselined files over ${LIMIT} lines)`);

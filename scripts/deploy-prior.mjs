#!/usr/bin/env node
// Deploy a trained LinUCB prior (and optionally the bandit config) to a KV
// namespace. Run with the flag used by the test suite so it can reuse the
// canonical validator from functions/lib/linucb.ts:
//
//   node --experimental-strip-types scripts/deploy-prior.mjs \
//     --kv flaxia --file prior.json
//
//   node --experimental-strip-types scripts/deploy-prior.mjs \
//     --kv flaxia --file prior.json --config bandit-config.json
//
// If run without --experimental-strip-types it falls back to an inline
// validator, so a prior that differs from serving-side expectations still
// blocks deployment.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const BANDIT_PRIOR_KEY = 'arcade:bandit:prior';
const BANDIT_CONFIG_KEY = 'arcade:bandit:config';

let parseBanditPrior;
let parseBanditConfig;
try {
  ({ parseBanditPrior, parseBanditConfig } = await import('../functions/lib/linucb.ts'));
} catch {
  parseBanditPrior = inlineParsePrior;
  parseBanditConfig = inlineParseConfig;
}

function inlineParsePrior(raw) {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (p?.v !== 1 || typeof p.dim !== 'number' || !Array.isArray(p.theta)) return null;
    if (p.theta.length !== p.dim) return null;
    if (!p.theta.every((x) => Number.isFinite(x))) return null;
    return { ...p, lambda0: Math.max(Number(p.lambda0) || 1, 1e-6) };
  } catch {
    return null;
  }
}

function inlineParseConfig(raw) {
  if (!raw) return { enabled: false, dim: 64, alpha: 0.6, lambda: 0.6, seed: 20260701, srcDim: 1024 };
  try {
    const c = JSON.parse(raw);
    return { ...c, enabled: c.enabled !== false };
  } catch {
    return null;
  }
}

function put(namespace, key, value, ttl) {
  const dir = mkdtempSync(join(tmpdir(), 'flaxia-prior-'));
  const path = join(dir, 'value');
  writeFileSync(path, value, 'utf-8');
  const args = ['wrangler', 'kv', 'key', 'put', key, '--path', path, '--namespace-id', namespace];
  if (ttl) args.push('--ttl', String(ttl));
  return new Promise((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn('npx', args, { stdio: 'inherit' });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`wrangler kv put exited ${code}`))));
      child.on('error', reject);
    });
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      kv: { type: 'string' },
      file: { type: 'string' },
      config: { type: 'string' },
      ttl: { type: 'string' },
    },
  });
  if (!values.kv || !values.file) {
    console.error(
      'Usage: deploy-prior.mjs --kv <namespace-id> --file <prior.json> [--config <config.json>] [--ttl <sec>]',
    );
    process.exit(1);
  }

  const priorRaw = readFileSync(values.file, 'utf-8');
  const prior = parseBanditPrior(priorRaw);
  if (!prior) {
    console.error(`Rejected: ${values.file} is not a valid BanditPrior`);
    process.exit(1);
  }
  console.log(
    `Prior OK: dim=${prior.dim} seed=${prior.seed} srcDim=${prior.srcDim} lambda0=${prior.lambda0} theta=${prior.theta.length} records=${prior.records ?? '?'}`,
  );

  await put(values.kv, BANDIT_PRIOR_KEY, priorRaw, values.ttl);
  console.log(`Deployed ${BANDIT_PRIOR_KEY} (${priorRaw.length} bytes)`);

  if (values.config) {
    const configRaw = readFileSync(values.config, 'utf-8');
    const config = parseBanditConfig(configRaw);
    if (!config) {
      console.error(`Rejected: ${values.config} is not a valid bandit config`);
      process.exit(1);
    }
    await put(values.kv, BANDIT_CONFIG_KEY, configRaw, values.ttl);
    console.log(`Deployed ${BANDIT_CONFIG_KEY} (${configRaw.length} bytes)`);
  } else {
    console.log(
      `Note: bandit config (${BANDIT_CONFIG_KEY}) left unchanged; the prior is only active when it matches the enabled config.`,
    );
  }
}

main().catch((err) => {
  console.error('Deploy failed:', err);
  process.exit(1);
});

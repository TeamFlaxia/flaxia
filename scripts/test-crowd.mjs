#!/usr/bin/env node
import { AuthenticationError, FlaxiaClient, FlaxiaError } from '@flaxia/sdk';

const DEFAULT_ORCHESTRATOR = 'https://crowd.flaxia.app';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

function getApiKey() {
  const argIndex = process.argv.indexOf('--api-key');
  if (argIndex !== -1 && process.argv[argIndex + 1]) return process.argv[argIndex + 1];
  if (process.env.CROWD_API_KEY) return process.env.CROWD_API_KEY;
  return null;
}

function buildClient(apiKey, orchestrator) {
  const baseUrl = `${orchestrator.replace(/\/+$/, '')}/crowd`;
  return new FlaxiaClient({ apiKey, baseUrl });
}

async function main() {
  const apiKey = getApiKey();
  const orchestrator = process.env.CROWD_ORCHESTRATOR_URL || DEFAULT_ORCHESTRATOR;

  if (!apiKey) {
    console.error('CROWD_API_KEY が未設定です。使用法:');
    console.error('  CROWD_API_KEY=fc_live_xxx node scripts/test-crowd.mjs');
    console.error('  node scripts/test-crowd.mjs --api-key fc_live_xxx');
    process.exit(2);
  }

  const started = Date.now();
  const client = buildClient(apiKey, orchestrator);

  // --- 1) Auth negative check: invalid key must be rejected (401) ---
  console.log('1) 認証チェック: 無効キーが 401 で拒否されるか検証');
  const bad = buildClient('fc_live_invalid_status_check', orchestrator);
  try {
    await bad.submit({ workload: 'vector-embed', payload: { text: 'status' } });
    console.log('    ✗ 無効キーが受理された（認証が機能していない）');
    process.exit(1);
  } catch (e) {
    if (e instanceof AuthenticationError) {
      console.log(`    ✓ 認証拒否 OK (AuthenticationError, status=${e.status ?? 'unknown'})`);
    } else if (e instanceof FlaxiaError) {
      console.error(`    ✗ 予期しない FlaxiaError: code=${e.code} status=${e.status} message=${e.message}`);
      process.exit(1);
    } else {
      console.error(`    ✗ 未知のエラー: ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof Error && 'cause' in e && e.cause) {
        console.error(`      cause: ${e.cause}`);
      }
      console.error('      ※ オーケストレーターに到達できていない可能性があります');
      process.exit(1);
    }
  }

  // --- 2) Main roundtrip: submit vector-embed and poll until done ---
  console.log('2) 実タスク投入: vector-embed（生産フロー embedPost と同一ペイロード）');
  let taskId;
  try {
    const res = await client.submit({
      workload: 'vector-embed',
      payload: { text: 'Is the Flaxia crowd network operational?' },
      timeoutMs: 600_000,
    });
    taskId = res.taskId ?? res.id;
    console.log(`    submitted: taskId=${taskId}, status=${res.status}`);
  } catch (e) {
    if (e instanceof FlaxiaError) {
      console.error(`    ✗ submit 失敗: code=${e.code} status=${e.status} message=${e.message}`);
    } else {
      console.error(`    ✗ submit 失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(1);
  }

  console.log(`    polling ${taskId} (interval=${POLL_INTERVAL_MS}ms, timeout=${POLL_TIMEOUT_MS}ms)`);
  const pollStarted = Date.now();
  let lastStatus = '';
  let record;
  while (Date.now() - pollStarted < POLL_TIMEOUT_MS) {
    try {
      record = await client.getTask(taskId);
    } catch (e) {
      if (e instanceof FlaxiaError) {
        console.error(`    ✗ ポーリング失敗: code=${e.code} status=${e.status} message=${e.message}`);
      } else {
        console.error(`    ✗ ポーリング失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
      process.exit(1);
    }
    if (record.status !== lastStatus) {
      lastStatus = record.status;
      const ageSec = Math.round((Date.now() - pollStarted) / 1000);
      console.log(`    status → ${record.status} (${ageSec}s)`);
    }
    if (record.status === 'done' || record.status === 'failed') break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (record.status !== 'done') {
    const timedOut = Date.now() - pollStarted >= POLL_TIMEOUT_MS;
    console.error(`    ✗ 完了せず終了: status=${record.status}, error=${record.error ?? 'なし'}`);
    if (timedOut) console.error(`      ※ ポーリングが ${POLL_TIMEOUT_MS / 1000}s でタイムアウト`);
    if (record.status === 'pending' || record.status === 'assigning') {
      console.error('      ※ ブラウザノードがオンラインでない可能性があります');
    }
    process.exit(1);
  }

  const resultObj = record.result;
  const output = resultObj?.output ?? resultObj ?? {};
  const vector = output.vector;
  const valid =
    Array.isArray(vector) && vector.length > 0 && output.dimensions && typeof output.dimensions === 'number';
  console.log(
    `    結果: model=${output.model ?? 'unknown'}, dimensions=${output.dimensions ?? 'none'}, vector_len=${Array.isArray(vector) ? vector.length : 0}`,
  );

  const elapsedMs = Date.now() - started;
  if (!valid) {
    console.error('    ✗ タスクは完了したが結果が不正（vector が空 or 欠落）');
    console.error(`      result: ${JSON.stringify(record.result).slice(0, 500)}`);
    process.exit(1);
  }

  console.log('3) 判定: Crowd 動作確認 OK');
  console.log(`    認証: 正常, 実タスク: done, 所要時間: ${elapsedMs}ms`);
  process.exit(0);
}

main().catch((e) => {
  console.error('予期しないエラー:', e);
  process.exit(1);
});

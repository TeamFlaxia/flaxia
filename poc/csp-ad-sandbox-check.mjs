#!/usr/bin/env node
// PoC 3: 静的チェック (サーバ不要) — CSP/Ad-iframe/sandbox postMessage。
// 使い方: node poc/csp-ad-sandbox-check.mjs
import fs from 'node:fs';

let vuln = 0;
const check = (label, cond, evidence) => {
  console.log(`[${cond ? 'VULN' : 'OK'}] ${label}`);
  if (cond) {
    vuln++;
    console.log(`  -> ${evidence}`);
  }
};

const headers = fs.readFileSync('public/_headers', 'utf8');
check(
  'CSP script-srcに bare https:/unsafe-inline/unsafe-eval/blob:',
  /script-src[^;]*https:/.test(headers) && headers.includes('unsafe-inline'),
  headers
    .split('\n')
    .find((l) => l.includes('script-src'))
    ?.trim()
    .slice(0, 220),
);

const ad = fs.readFileSync('src/components/AdCard.ts', 'utf8');
check(
  'AdCard iframeにsandbox属性なし+document.writeで広告script',
  ad.includes("createElement('iframe')") && !/\.sandbox/.test(ad) && ad.includes('iframeDoc.write'),
  'mountAdmax: createElement(iframe), sandbox設定なし, iframeDoc.write(...)',
);

const zip = fs.readFileSync('public/sandbox/index.html', 'utf8');
check(
  'sandbox EXECUTE_ZIPがorigin無検証+attacker originへ返信',
  zip.includes('EXECUTE_ZIP') && zip.includes("event.data.origin || '*'"),
  "addEventListener(message) -> EXECUTE_ZIP, postMessage(..., event.data.origin || '*')",
);

const doc = fs.readFileSync('src/components/DocumentViewer.ts', 'utf8');
check(
  'DOCUMENT_DATAを`*`へpostMessage',
  doc.includes("postMessage({ type: 'DOCUMENT_DATA'") || doc.includes('DOCUMENT_DATA'),
  doc
    .split('\n')
    .find((l) => l.includes('DOCUMENT_DATA'))
    ?.trim()
    .slice(0, 200) ?? '',
);

console.log(vuln ? `\nRESULT: ${vuln}件 VULNERABLE` : '\nRESULT: not reproduced');
process.exit(vuln ? 1 : 0);

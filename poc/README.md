# PoC (ローカル検証専用)

**本番 (flaxia.app / sandbox.flaxia.app) には絶対に実行しないこと。**

前提: 別シェルで `npm run dev:test` (http://localhost:8788) 起動。

```bash
node poc/csp-ad-sandbox-check.mjs  # サーバ不要の静的3点チェック
node poc/ssrf-link-preview.mjs     # 終了コード1=VULN再現
node poc/ssrf-inbox.mjs            # 終了コード1=VULN再現
BASE_URL=http://localhost:8788 node poc/ssrf-link-preview.mjs  # 別ポート指定例
```

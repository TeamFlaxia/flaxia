# Flaxia

[![CI](https://github.com/RemydreScarlet/flaxia/actions/workflows/ci.yml/badge.svg)](https://github.com/RemydreScarlet/flaxia/actions/workflows/ci.yml)
[![Deploy](https://github.com/RemydreScarlet/flaxia/actions/workflows/deploy.yml/badge.svg)](https://github.com/RemydreScarlet/flaxia/actions/workflows/deploy.yml)
[![Release](https://github.com/RemydreScarlet/flaxia/actions/workflows/release.yml/badge.svg)](https://github.com/RemydreScarlet/flaxia/actions/workflows/release.yml)

Chronological SNS where posts are living, interactive applications.

ZIP (HTML5 ゲーム), SWF (Flash), 画像, 音声を投稿に添付でき、サンドボックス環境で安全に実行できます。

## Development

### Deployment
```bash
npm run build && npm run deploy
```

### Debuging
```bash
wrangler pages deployment tail
```

### Worker Deployment
```bash
npx wrangler deploy functions/queue-worker.ts --config wrangler.toml.worker --name flaxia-ap-delivery --compatibility-date 2024-01-01
```

## Architecture

- **Runtime**: Cloudflare Pages + Workers
- **API**: Hono framework
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2

---

## Flaxia 用語集

Flaxia には独自の用語があります。コードを読む前に把握しておきましょう。

| 用語 | 意味 | 対応するコードや概念 |
|------|------|-------------------|
| **Fresh** | いいね/ライク | `fresh_count`, `is_freshed`, `/api/fresh` |
| **Freshed** | いいねされた状態 | `Post.is_freshed` |
| **Arcade** | ゲーム一覧ページ | `ArcadePage.ts` |
| **Flake** | 投稿で得られるスコア/通貨 | `POST_SCORE` メッセージ |
| **Stage** | 投稿のインタラクティブ表示エリア | `PostStage.ts` |
| **Payload** | ZIP ファイルの添付データ | `Post.payload_key` |
| **Sandbox** | 信頼できないコードを実行する隔離環境 | `sandbox.flaxia.app` |
| **Bridge** | サンドボックス↔メインの型安全通信 | `bridge.ts`, `sandbox-bridge.ts` |
| **WVFS** | WebAssembly Virtual File System | `wvfs-zip-*.ts` |
| **Timeline** | メインの投稿一覧フィード | `Timeline.ts` |
| **Thread** | 投稿＋返信ツリーの詳細ページ | `ThreadPage.ts` |
| **D1** | Cloudflare の SQLite データベース | バックエンドの DB バインディング |
| **R2** | Cloudflare のオブジェクトストレージ | 画像/ZIP/SWF の保存先 |
| **KV** | Cloudflare のキーバリューストア | レート制限など |
| **DO** | Durable Object（ステートフル Worker） | `NotificationStream` |
| **Queue** | Cloudflare のメッセージキュー | ActivityPub 配送 |
| **Composer** | 投稿作成フォーム | `PostComposer.ts` |

---

# Flaxia 初学者ガイド

## 目次

1. [必要なソフトウェアのインストール](#1-必要なソフトウェアのインストール)
2. [Git の使い方](#2-git-の使い方)
3. [opencode の入れ方](#3-opencode-の入れ方)
4. [プロジェクトのセットアップ](#4-プロジェクトのセットアップ)
5. [開発サーバーの起動](#5-開発サーバーの起動)
6. [テストの仕方](#6-テストの仕方)
7. [ビルドの仕方](#7-ビルドの仕方)
8. [文法チェック・型チェック・エラー対応](#8-文法チェック型チェックエラー対応)
9. [フロントエンドコード全解説](#9-フロントエンドコード全解説)
10. [翻訳（i18n）の追加方法](#910-翻訳i18nの追加方法)
11. [データベースマイグレーションの追加方法](#911-データベースマイグレーションの追加方法)
12. [依存関係の追加方法](#912-依存関係の追加方法)
13. [コード規約・命名規則](#913-コード規約命名規則)
14. [CSS の設計思想](#914-css-の設計思想)
15. [デバッグのコツ](#915-デバッグのコツ)
16. [知っておくべき重要コンセプト](#916-知っておくべき重要コンセプト)
17. [参考リンク](#参考リンク)

---

## 1. 必要なソフトウェアのインストール

### Node.js + npm

Flaxia は **Node.js 22** と **npm**（Node.js に同梱）を使います。
`pnpm` や `yarn` は使わず、必ず `npm` を使用してください。

---

#### Windows

推奨: **Node.js 公式インストーラー** を使う方法（最も簡単）。

1. [Node.js 公式サイト](https://nodejs.org/) にアクセス
2. **22.x.x LTS** の欄にある `Windows インストーラー (.msi)` をクリックしてダウンロード
3. ダウンロードした `.msi` ファイルを実行
4. インストーラーの指示に従う（デフォルト設定のまま次へ進んで OK）
   - 「Add to PATH」にチェックが入っていることを確認
5. インストール完了後、**コマンドプロンプトまたは PowerShell を再起動**

```powershell
# バージョン確認
node --version   # v22.x.x
npm --version    # 10.x.x
```

> **PowerShell 実行ポリシーについて**: npm でインストールしたグローバルコマンド（`wrangler` など）を実行する際、`Execution Policy` が原因でブロックされることがあります。その場合は PowerShell を**管理者として実行**し、以下のコマンドでポリシーを変更してください（RemoteSigned が一般的な推奨設定です）:
> ```powershell
> Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```

> **nvm-windows を使う場合**: 複数の Node バージョンを切り替えたい場合は [nvm-windows](https://github.com/coreybutler/nvm-windows/releases) の `nvm-setup.exe` をインストールしてください。インストール後、管理者 PowerShell で:
> ```powershell
> nvm install 22
> nvm use 22
> ```

---

#### macOS

推奨: **Homebrew + nodenv**（または fnm） でバージョン管理する方法。

```bash
# オプション A: nodenv（推奨）
brew install nodenv
nodenv init
# ~/.zshrc に eval "$(nodenv init -)" が追加されるのを確認
exec $SHELL -l
nodenv install 22.0.0
nodenv global 22.0.0

# オプション B: fnm（高速）
brew install fnm
# ~/.zshrc に eval "$(fnm env --use-on-cd)" を追加
exec $SHELL -l
fnm install 22
fnm use 22

# オプション C: 公式インストーラー（バージョン管理不要なら）
# https://nodejs.org/ から macOS インストーラー (.pkg) をダウンロードして実行

# 確認
node --version   # v22.x.x
npm --version    # 10.x.x
```

---

#### Linux

推奨: **nvm**（Node Version Manager） を使う方法。

```bash
# nvm のインストール
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

# シェルを再読み込み
exec $SHELL -l

# nvm で Node.js 22 をインストール
nvm install 22
nvm use 22

# 確認
node --version   # v22.x.x
npm --version    # 10.x.x
```

プロジェクトルートに `.nvmrc` が置いてあるので、`nvm use` で自動的にバージョンが切り替わります。

> **パッケージマネージャーでもインストール可能**:
> ```bash
> # Debian/Ubuntu
> sudo apt install nodejs npm
>
> # Arch Linux
> sudo pacman -S nodejs npm
> ```
> ただしパッケージマネージャーの Node.js はバージョンが古い場合があるので注意してください。

---

### Git

```bash
# Windows
# https://git-scm.com から Git for Windows インストーラーをダウンロードして実行
# インストール時の推奨設定:
#   - 「Git Bash」はデフォルトのまま
#   - 「Choosing the default editor」→ Visual Studio Code があればそれを選択
#   - 「Adjusting your PATH environment」→ 「Git from the command line and also from 3rd-party software」
#   - 「Configuring the line ending conversions」→ 「Checkout Windows-style, commit Unix-style line endings」
# インストール後、コマンドプロンプトまたは Git Bash を再起動

# macOS
brew install git

# Linux (Debian/Ubuntu)
sudo apt install git
```

### GitHub CLI (任意)

```bash
# Windows
# https://cli.github.com/ からインストーラーをダウンロードして実行
# または: winget install --id GitHub.cli

# macOS
brew install gh

# Linux (Debian/Ubuntu)
sudo apt install gh

# 認証（全OS共通）
gh auth login
```

### コードエディタ

#### 1. Visual Studio Code（推奨）

[code.visualstudio.com](https://code.visualstudio.com/) から各OSのインストーラーをダウンロード。

**おすすめ拡張機能**:

| 拡張機能 | 説明 | 理由 |
|---------|------|------|
| **[Biome](https://marketplace.visualstudio.com/items?itemName=biomejs.biome)** | リンター/フォーマッター | 保存時に自動フォーマット。Flaxia の標準リンター |
| **[GitLens](https://marketplace.visualstudio.com/items?itemName=eamodio.gitlens)** | Git 履歴の可視化 | 各行の最終コミットを表示、ブランチ比較 |
| **[Cloudflare Workers](https://marketplace.visualstudio.com/items?itemName=cloudflare.cloudflare-workers)** | Wrangler 統合 | `wrangler.toml` のシンタックスハイライト、デプロイ操作 |
| **[Error Lens](https://marketplace.visualstudio.com/items?itemName=usernamehw.errorlens)** | インラインエラー表示 | 編集中にエラーをその場で確認可能 |
| **[Pretty TypeScript Errors](https://marketplace.visualstudio.com/items?itemName=yoavbls.pretty-ts-errors)** | 型エラーを見やすく | TypeScript の複雑な型エラーを人間可読に |
| **[Japanese Language Pack](https://marketplace.visualstudio.com/items?itemName=MS-CEINTL.vscode-language-pack-ja)** | UI の日本語化 | VS Code のメニューや設定を日本語に。Ctrl+Shift+P → `Configure Display Language` で切り替え |

**VS Code 設定 (`settings.json`)** の推奨設定:

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "biomejs.biome",
  "editor.codeActionsOnSave": {
    "source.organizeImports.biome": "explicit"
  },
  "files.associations": {
    "*.toml": "ini"
  },
  "[typescript]": {
    "editor.defaultFormatter": "biomejs.biome"
  },
  "typescript.preferences.importModuleSpecifierEnding": "js",
  "typescript.tsdk": "node_modules/typescript/lib"
}
```

> `importModuleSpecifierEnding: "js"` の設定により、`import` の補完が自動的に `.js` 拡張子付きになります（Flaxia の規約）。

#### 2. WebStorm (有料)

JetBrains 製の TypeScript 特化 IDE。Biome のプラグインもあり。VS Code と比べてリファクタリング機能が強力。

#### 3. Neovim / Vim (中級者以上)

`.editorconfig` と Biome の LSP を設定すれば CLI ベースの開発も可能。

```lua
-- lazy.nvim の場合
{
  "biomejs/biome",
  build = "npm run build:edged",
  init = function()
    vim.g.biome_lsp = true
  end,
}
```

---

## 2. Git の使い方

### クローン

```bash
git clone https://github.com/RemydreScarlet/flaxia.git
cd flaxia
```

### ブランチ戦略

- `main` — 本番ブランチ。常にデプロイ可能な状態を保つ
- 機能追加やバグ修正は `feature/xxx` ブランチを作って作業する

```bash
# 新しいブランチを作成
git checkout -b feature/your-feature-name

# 作業が終わったら main にマージ
git checkout main
git merge feature/your-feature-name
```

### コミットの作法

```bash
# 変更を確認
git status
git diff

# ステージング
git add <ファイル>
# または全部まとめて
git add .

# コミット
git commit -m "簡潔でわかりやすいコミットメッセージ"

# プッシュ
git push origin feature/your-feature-name
```

**husky + lint-staged** が pre-commit フックとして設定されているので、コミット時に自動で `biome check` が走ります。エラーがあるとコミットがブロックされます。

### .gitignore に含まれる主なもの

- `node_modules/`
- `dist/`
- `.env`
- `.wrangler/`
- IDE 設定ファイル (`.vscode/`, `.idea/`)
- OS のゴミファイル (`.DS_Store`, `Thumbs.db`)
- `android/`, `ios/` (Capacitor のネイティブコード)
- `src-tauri/target/` (Rust のビルド成果物)

---

## 3. opencode の入れ方

opencode は AI アシスタントを使ってコードベースと対話するための CLI ツールです。自然言語で指示を出すと、コードの読み取り・編集・実行を自動で行います。

### インストール

```bash
# npm でグローバルインストール
npm install -g @opencode/cli

# 確認
opencode --version
```

アップデートする場合:

```bash
npm update -g @opencode/cli
```

### 使い方: 対話モード（推奨）

opencode は **対話モード** での使用を強く推奨します。対話モードでは、一度に1つのタスクを依頼し、結果を見ながら追加の指示を出す、という自然な開発フローで作業できます。

```bash
# プロジェクトルートで対話モード起動（引数なし）
opencode
```

起動するとプロンプト（`>`）が表示され、以下のように対話しながら作業を進めます:

```
> このプロジェクトの技術スタックを教えて
（AI が回答）
> src/components/Timeline.ts の役割を説明して
（AI が回答）
> 今の変更をコミットして
（AI が git 操作を実行）
```

ワンショットモード（対話せずに1回だけ実行）も可能です:

```bash
opencode "src/main.ts の役割を解説して"
```

### 使用するモデルの変更

対話モード起動中に **`/model` コマンド** を使うと、使用する AI モデルを切り替えられます。

```
> /model
使用可能なモデル一覧:
- deepseek-v4-flash-free
- claude-sonnet-4-20250514
- gemini-2.5-flash-preview-04-2025
...

> /model deepseek-v4-flash-free
モデルを deepseek-v4-flash-free に変更しました
```

Flaxia の開発では **DeepSeek V4 Flash Free** の使用をおすすめします（無料で高速、コード生成に優れる）。

| 項目 | DeepSeek V4 Flash Free |
|------|----------------------|
| 料金 | **無料** |
| 速度 | 高速（Flash モデル） |
| コード品質 | TypeScript / Rust / Python に強い |
| コンテキスト長 | 非常に長い（大規模コードベース対応） |

### opencode にできること

| カテゴリ | 指示例 |
|---------|--------|
| **コード解説** | 「PostCard.ts の役割を説明して」「データフローを教えて」 |
| **コード生成** | 「新しいコンポーネントを作成して」「API エンドポイントを追加して」 |
| **コード修正** | 「このバグを修正して」「変数名をリネームして」 |
| **リファクタリング** | 「この関数を分割して」「共通処理を utility に抽出して」 |
| **テスト** | 「テストを書いて」「テストを実行して」 |
| **レビュー** | 「このコードをレビューして」「問題点を指摘して」 |
| **Git 操作** | 「変更をコミットして」「ブランチを作成して」 |
| **ドキュメント** | 「README に使い方を追加して」「JSDoc を生成して」 |
| **デバッグ** | 「このエラーの原因を調べて」「ログを分析して」 |

### プロジェクト固有の設定

Flaxia プロジェクトには既に以下の設定ファイルが用意されているため、opencode はプロジェクトの構造や技術スタックを理解した上でアシストします:

| ファイル | 役割 |
|---------|------|
| `.opencode/` | opencode の設定ディレクトリ（パーミッションルール、スキルなど） |
| `AGENT.MD` | プロジェクトの技術スタック・アーキテクチャ・コーディング規約を定義 |
| `CLAUDE.MD` | Claude Code 用のプロジェクトガイド（互換性あり） |

### 便利な使い方のコツ

#### ファイルを指定して質問する

```bash
# 対話モードで特定のファイルについて聞く
> src/main.ts の parseCurrentRoute 関数の役割は？

# 「このファイル」と指示する
> このファイルの責務を教えて
```

#### エラーのデバッグを依頼する

```bash
> npm run build が通らない。エラーを調べて修正して
> テストが失敗している。原因を特定して修正案を出して
```

#### コードレビューを依頼する

```bash
> 直近のコミットの差分をレビューして
```

#### 複数ファイルにまたがるタスク

```bash
> 新しい設定ページを作りたい。既存の SettingsPage.ts を参考にして作成して
```

#### 段階的に依頼する（推奨）

対話モードでは、大きなタスクを段階的に依頼することで品質が向上します:

```
> まず src/components/ のファイル構成を確認して
(構成を把握)
> 次に PostCard.ts の構造を教えて
(構造を理解)
> 最後に PostCard に新しいプロパティを追加して
(実際の編集)
```

---

## 4. プロジェクトのセットアップ

```bash
# 1. 依存関係のインストール
npm install

# 2. 環境変数の設定
cp .env.example .env
# .env を編集して必要な値を設定（最低限 CLOUDFLARE_ACCOUNT_ID）

# 3. ローカルデータベースのマイグレーション
npm run migrate:local

# 4. 開発サーバーの起動
npm run dev
```

`http://localhost:8787` で起動します。

### ローカルテストアカウント

`local-test-accounts.md` にテスト用アカウントが記載されています。

### 環境変数

| 変数名 | 説明 | デフォルト値 |
|--------|------|-------------|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID | （必須） |
| `VITE_SANDBOX_ORIGIN` | サンドボックスオリジンの URL | `https://flaxia.app` |
| `VITE_CONTENT_ORIGIN` | コンテンツオリジンの URL | （空文字列） |

---

## 5. 開発サーバーの起動

Flaxia には複数の dev モードがあります:

```bash
# フルスタック開発サーバー（Vite ビルド + Wrangler Pages）
npm run dev

# ホットリロード（Vite の watch モード）
npm run dev:hot

# API のみ（既存の dist/ を使って Wrangler だけ起動）
npm run dev:api

# フロントエンドのみ（Vite の dev サーバー、API は proxy）
npm run dev:local

# フロントエンド + API を同時起動
npm run dev:all
```

### Vite のプロキシ設定

`vite.config.ts` で以下が設定されています:

- `/api` → `http://localhost:8787` (Wrangler の API)
- `/sw.js` → `http://localhost:8787` (Service Worker)
- `/api/crowd` → unpkg (Flaxia Node の CDN)

開発時は Vite (`:3000`) と Wrangler (`:8787`) の2つが動きます。Vite が API リクエストを Wrangler にプロキシするので、ブラウザは `:3000` だけ見れば OK です。

---

## 6. テストの仕方

Flaxia は **Node.js ネイティブテストランナー** (`node --test`) を使っています。

```bash
# 全テスト実行
npm test

# 特定のテストスイートのみ
npm run test:auth
npm run test:posts
npm run test:users
npm run test:notifications
npm run test:tags
npm run test:rate-limit
```

### テストファイルの場所

`tests/` ディレクトリにあります。

```text
tests/
├── auth.test.ts           # 認証テスト
├── notifications.test.ts  # 通知テスト
├── posts.test.ts          # 投稿 CRUD テスト
├── rate-limit.test.ts     # レート制限テスト
├── signature.test.ts      # HTTP Signature テスト
├── tags.test.ts           # ハッシュタグテスト
├── users.test.ts          # ユーザー管理テスト
└── helpers/
    └── setup.ts           # テストのセットアップヘルパー
```

### テストの書き方

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('機能名', () => {
  it('具体的な振る舞い', () => {
    const result = someFunction();
    assert.strictEqual(result, expectedValue);
  });
});
```

### テスト実行の仕組み

`package.json` のスクリプト:
```
"test": "node --test --experimental-strip-types tests/**/*.test.ts"
```

`--experimental-strip-types` フラグによって TypeScript をトランスパイルせずに直接実行できます。

---

## 7. ビルドの仕方

### プロダクションビルド

```bash
# Vite でビルド（dist/ に出力）
npm run build
```

ビルド時に以下の処理が自動で行われます:

1. Vite が TypeScript をバンドルして `dist/` に出力
2. 手動チャンク分割（`katex`, `jszip`, `markdown-it`, `vendor`）
3. `js-dos` のファイルを `dist/js-dos/` にコピー
4. `@flaxia/node` のアセットを `dist/assets/` にコピー

### デプロイ

```bash
# Cloudflare Pages にデプロイ
npm run deploy

# サンドボックス Worker のデプロイ
npm run deploy:sandbox

# Durable Object Worker のデプロイ
npm run deploy:do
```

### 各種デスクトップ/モバイルビルド

```bash
# Tauri（デスクトップアプリ）
npm run tauri:build          # 現在のプラットフォーム
npm run tauri:build:linux    # Linux
npm run tauri:build:macos    # macOS
npm run tauri:build:windows  # Windows

# Capacitor（モバイルアプリ）
npm run cap:sync             # Capacitor 同期
npm run cap:build:android    # Android APK
npm run cap:build:ios        # iOS
```

---

## 8. 文法チェック・型チェック・エラー対応

### リンター/フォーマッター

Flaxia は **Biome** を使っています（ESLint + Prettier の代わり）。

```bash
# 全ファイルのチェック
npm run lint

# 自動修正
npm run lint:fix

# フォーマットのみ
npm run format
```

Biome の設定は `biome.jsonc` にあります。バージョン 2.4.16 を使用。

### 型チェック

```bash
npm run typecheck
```

内部では `tsc --noEmit` が実行されます。`tsconfig.json` は strict モードです。

### pre-commit フック

husky + lint-staged により、コミット時にステージングされたファイルに対して自動で `biome check` が実行されます。

設定は `package.json` の `lint-staged` セクション:
```json
"lint-staged": {
  "*.{ts,tsx,js,jsx,json,html,css,md}": [
    "biome check --write --no-errors-on-unmatched"
  ]
}
```

### エラーが発生した場合の対応フロー

```text
1. npm run lint を実行 → Biome のエラーを確認
2. npm run lint:fix で自動修正を試みる
3. npm run typecheck で型エラーがないか確認
4. npm test でテストが通るか確認
5. npm run build でビルドが通るか確認
```

#### よくあるエラーと対処

| エラー | 原因 | 対処 |
|--------|------|------|
| `biome check` が失敗 | コードスタイル違反 | `npm run lint:fix` で自動修正 |
| `tsc --noEmit` が失敗 | 型エラー | 型定義を確認、import パスが `.js` で終わっているか確認 |
| `wrangler` のエラー | Cloudflare 認証 or 設定ミス | `wrangler login` で認証、`wrangler.toml` の設定を確認 |
| `D1` 関連のエラー | マイグレーション未実行 | `npm run migrate:local` を実行 |
| `npm install` で競合 | ロックファイルの不整合 | `node_modules/` と `npm-lock.yaml` を削除して再インストール |

### TypeScript の注意点

- すべての import パスは `.js` 拡張子で終わる（例: `'./components/Timeline.js'`）
- これは ESM + Vite の制約で、トランスパイル後も `.js` のまま参照するため
- Wrangler/Cloudflare の型は `@cloudflare/workers-types` から自動補完される
- 型定義の自動生成は `worker-configuration.d.ts`

---

## 9. フロントエンドコード全解説

### 9.1. アーキテクチャ概要

Flaxia のフロントエンドは **Vanilla TypeScript SPA**（React/Vue などのフレームワークなし）です。
Vite でビルドし、Cloudflare Pages で配信されます。

```
index.html  ← SPA のエントリーポイント（critical CSS はインライン）
  └── src/main.ts  ← アプリ起動、ルーティング、レイアウト管理
        ├── src/lib/        ← ユーティリティライブラリ
        └── src/components/ ← UI コンポーネント（47ファイル）
```

#### 画面レイアウト（デスクトップ）

```
┌─────────────┬──────────────────┬─────────────────┐
│  Left Nav   │   Main Feed      │   Right Panel   │
│  (240px)    │   (600px)        │   (350px)       │
└─────────────┴──────────────────┴─────────────────┘
```

モバイルでは Left Nav がハンバーガーメニューになり、Right Panel は非表示になります。

#### 2オリジンアーキテクチャ（重要）

Flaxia の最も重要な設計の1つが **2オリジンモデル** です。

| オリジン | 役割 | 技術 |
|---------|------|------|
| `flaxia.app` | SNS の UI、API、データベース | Cloudflare Pages + Hono |
| `sandbox.flaxia.app` | 信頼できない ZIP/SWF/HTML5 を実行 | Cloudflare Worker (サンドボックス) |

**なぜ2オリジンが必要か？**

投稿に添付された ZIP ファイルの中には任意の JavaScript が含まれています。これをメインオリジンで実行すると、ユーザーのセッション情報が盗まれたり、API に不正なリクエストが送られたりする可能性があります。

そこで、**別オリジンの iframe** の中でコンテンツを実行し、`postMessage` による型安全な通信のみを許可することで、セキュリティを確保しています。

`allow-same-origin` はすべての iframe で恒久的に禁止されています。

```
┌──────────────────────────────────────────────┐
│  flaxia.app (メイン)                          │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │  <iframe src="sandbox.flaxia.app/...">│    │
│  │  ┌────────────────────────────────┐  │    │
│  │  │  投稿の ZIP/SWF/HTML5          │  │    │
│  │  │  （任意のコード）              │  │    │
│  │  │  ・ window.parent.postMessage  │  │    │
│  │  │    で通信                      │  │    │
│  │  └────────────────────────────────┘  │    │
│  │  sandbox origin: sandbox.flaxia.app  │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  通信は typed postMessage bridge のみ許可    │
└──────────────────────────────────────────────┘
```

**通信プロトコル (`src/lib/bridge.ts`)**:

```typescript
// サンドボックス → メイン（ParentMessage）
type ParentMessage =
  | { type: 'REQUEST_FULLSCREEN' }           // フルスクリーン要求
  | { type: 'REQUEST_FRESH' }                // Fresh（いいね）要求
  | { type: 'POST_SCORE'; score: number; label: string };  // スコア送信

// メイン → サンドボックス（SandboxMessage）
type SandboxMessage =
  | { type: 'FULLSCREEN_GRANTED' }
  | { type: 'FULLSCREEN_DENIED' }
  | { type: 'FRESH_GRANTED' }
  | { type: 'FRESH_DENIED' }
  | { type: 'SCORE_SUBMITTED'; score: number; label: string };
```

### 9.2. ファイル構成

```
src/
├── index.ts                   # モジュールのエントリーポイント（エクスポート定義）
├── main.ts                    # SPA のエントリーポイント（2612行）
├── vite-env.d.ts              # Vite 環境変数の型定義
├── sandbox-worker.ts          # サンドボックス Worker（ZIP を R2 から配信）
├── styles/
│   └── main.css               # メインスタイルシート（4249行）
├── types/
│   ├── post.ts                # 投稿関連の型定義
│   ├── game.ts                # ゲーム関連の型定義
│   ├── env.d.ts               # 環境変数の型定義
│   ├── global.d.ts            # グローバル型の拡張
│   └── capacitor.d.ts         # Capacitor の型定義
├── lib/                       # ユーティリティライブラリ（15ファイル）
│   ├── auth-cache.ts          # 認証キャッシュ（/api/me の結果を5分間キャッシュ）
│   ├── bridge.ts              # postMessage の型定義とバリデーション
│   ├── sandbox-bridge.ts      # サンドボックス iframe との通信管理
│   ├── i18n.ts                # 国際化（日本語/英語）
│   ├── format.ts              # 数値フォーマット
│   ├── db.ts                  # データベースクエリヘルパー
│   ├── r2.ts                  # R2 ストレージクライアント
│   ├── dom-utils.ts           # DOM 操作ユーティリティ
│   ├── modal-state.ts         # モーダル状態管理
│   ├── post-modal.ts          # 投稿モーダル管理
│   ├── impression-tracker.ts  # インプレッション計測
│   ├── inject-ads.ts          # 広告注入ロジック
│   ├── toast.ts               # トースト通知
│   ├── share.ts               # シェア機能
│   ├── thread.ts              # スレッド管理
│   ├── settings.ts            # ユーザー設定
│   ├── confirm-dialog.ts      # 確認ダイアログ
│   ├── admin.ts               # 管理者チェック
│   ├── is-crawler.ts          # クローラー検出
│   ├── og-html.ts             # OGP HTML 生成
│   ├── performance.ts         # パフォーマンス監視
│   ├── rate-limit.ts          # レート制限クライアント
│   ├── render-html.ts         # HTML レンダリング（サニタイズ）
│   ├── zip-manager.ts         # ZIP 実行管理
│   ├── zip-executor.ts        # ZIP 実行（レガシー）
│   ├── wvfs-zip-client.ts     # WebAssembly VFS ZIP クライアント
│   ├── wvfs-zip-executor.ts   # WVFS ZIP 実行
│   ├── wvfs-zip-server.ts     # WVFS ZIP サーバー
│   └── file-extensions.ts     # ファイル拡張子ヘルパー
└── components/               # UI コンポーネント（47ファイル）
```

### 9.3. エントリーポイント: `index.html` → `src/main.ts`

#### `index.html`

- `index.html` が SPA のエントリーポイント
- 初期表示用の spinner（`initial-loader`）がインライン
- **Critical CSS** はインラインで記述（初回レンダリングをブロックしない）
- メインの CSS は `main.css` を `media="print" onload="this.media='all'"` で非同期読み込み
- Noto Sans フォントも同様に非同期読み込み
- Google AdSense, Google Analytics のスクリプトを含む
- `<script type="module" src="/src/main.ts">` で SPA を起動
- 言語自動判定（`?lang=ja` パラメータまたはブラウザ設定で `ja` / `en` を切り替え）

#### `src/main.ts` (2612行) — SPA の心臓部

`main.ts` は以下の責務を持ちます:

1. **アプリ初期化** — i18n の初期化、パフォーマンス監視の開始
2. **ルーティング** — URL パスを解析して適切なビューを表示
3. **レイアウト管理** — 3カラムレイアウトの組み立て
4. **認証管理** — セッション確認、認証ガード
5. **通知管理** — WebSocket プッシュ通知、バッジ更新
6. **モバイル対応** — ハンバーガーメニューの開閉制御

主要な流れ:

```typescript
document.addEventListener('DOMContentLoaded', async () => {
  // 1. i18n 初期化
  await initI18n();

  // 2. URL を解析して初期ルートを特定
  const initialRoute = parseCurrentRoute();

  // 3. ナビゲーション実行
  await safeNavigate(initialRoute.view, ...);

  // 4. 非同期で重い初期化（Flaxia Node SDK）
  deferInit(async () => {
    const { initFlaxiaNode } = await import('/api/crowd/index.js');
    initFlaxiaNode({ ... });
  });
});
```

#### ルーティング (`main.ts:812-977`)

`parseCurrentRoute()` は URL パスを解析して以下のビューを返します:

| パス | ビュー | 認証 | 説明 |
|------|--------|------|------|
| `/` or `/home` | `timeline` | 不要 | メインタムライン |
| `/thread/:id` | `thread` | 不要 | スレッド詳細 |
| `/login` | `login` | 不要 | ログインページ |
| `/register` | `register` | 不要 | 登録ページ |
| `/users/:name` | `profile` | 不要 | ユーザープロフィール |
| `/profile/:name` | `profile` | 不要 | （エイリアス） |
| `/explore` | `explore` | 不要 | 探すページ |
| `/search` | `search` | 不要 | 検索ページ |
| `/arcade` | `arcade` | 不要 | ゲームアーケード |
| `/arcade/:id` | `arcade` | 不要 | 個別ゲーム |
| `/notifications` | `notifications` | 必要 | 通知一覧 |
| `/bookmarks` | `bookmarks` | 必要 | ブックマーク |
| `/messages` | `messages` | 必要 | DM一覧 |
| `/messages/:id` | `messages` | 必要 | DM会話 |
| `/settings` | `settings` | 必要 | 設定 |
| `/admin/:tab` | `admin` | 必要 | 管理画面 |
| `/terms` | `terms` | 不要 | 利用規約 |
| `/privacy` | `privacy` | 不要 | プライバシー |
| `/about` | `about` | 不要 | このサイトについて |
| `/whitepaper` | `whitepaper` | 不要 | ホワイトペーパー |

認証が必要なルートには `requireAuth()` でガードがかかります。
未認証の場合は `/login` または `/arcade` にリダイレクトされます。

#### ビューのライフサイクル

各ビューは以下のインターフェースに従います:

```typescript
interface PageComponent {
  getElement(): HTMLElement;  // DOM 要素を返す
  destroy(): void;           // クリーンアップ
}
```

ナビゲーション時:
1. 現在のビューを `destroy()` する
2. `app.innerHTML = ''` でクリア
3. 新しいビューのコンポーネントを作成し `app.appendChild()` する

一部のビュー（timeline, profile, explore, search, arcade, bookmarks）は **キャッシュ** されます。別のビューに移動して戻ってきたときにスクロール位置を維持できます。

```typescript
// キャッシュの仕組み
if (view === 'thread' || view === 'arcade' || view === 'messages') {
  // 現在のビューをキャッシュに保存
  cachedContentComponent = { view: 'timeline', component: timeline, scrollY: window.scrollY };
  timeline = null; // timeline 変数は解放（二重管理防止）
}
```

#### 3カラムレイアウトの組み立て

各ビューのレンダリング関数で共通するパターン:

```typescript
// 1. main-container を作成
const mainContainer = document.createElement('div');
mainContainer.className = 'main-container';

// 2. Left Nav を作成（認証状態に応じて表示が変わる）
const leftNav = createLeftNav({
  activeItem: 'home',
  unreadCount: unreadNotificationCount,
  currentUser: currentUser || undefined,
  onNavigate: async (item) => { /* 画面遷移 */ },
  onSignIn: () => { /* ログイン画面へ */ },
  onSignUp: () => { /* 登録画面へ */ },
});

// 3. メインコンテンツを作成（view によって異なる）
const timeline = createTimeline({ sandboxOrigin, currentUser });

// 4. Right Panel を作成
const rightPanel = createRightPanel({
  onSearch: (query) => { /* 検索 */ },
  onFollowUser: (userId) => { /* フォロー */ },
});

// 5. 組み立て
mainContainer.appendChild(leftNav.getElement());
mainContainer.appendChild(timeline.getElement());
mainContainer.appendChild(rightPanel.getElement());
app.appendChild(mainContainer);

// 6. モバイル用 Left Nav 設定
setupMobileLeftNav(leftNav.getElement());
```

`LeftNav` と `RightPanel` はほぼ全ページで共通して使われますが、`thread` ビューだけは `ThreadPage` コンポーネントが自分自身で Left Nav を持ちます。

### 9.4. コンポーネント一覧と解説

#### `src/components/LeftNav.ts` (942行) — 左サイドバーナビゲーション

ロゴ（🌿）、ナビゲーションアイテム（ホーム、探索、アーケード、メッセージなど）、投稿ボタン、ユーザー情報を表示します。

- 未認証時は「ログイン」「新規登録」ボタンを表示
- 認証時はフルナビゲーション + ユーザー情報を表示
- 未読通知数と未読 DM 数をバッジ表示
- `Set<LeftNav>` で全インスタンスを管理し、どこからでも未読数を更新できる

```typescript
export class LeftNav {
  private element: HTMLElement;
  private activeItem: string;

  // 未読数更新（外部から呼ばれる）
  setUnreadCount(count: number): void { ... }
  setUnreadDmCount(count: number): void { ... }
}
```

#### `src/components/RightPanel.ts` — 右サイドパネル

検索ボックス、トレンド、おすすめユーザー、広告を表示。

#### `src/components/Timeline.ts` (714行) — メインタイムライン

タイムラインは **3つのモード** を持ちます:

| モード | 説明 |
|--------|------|
| `global` | 全ユーザーの投稿（デフォルト）|
| `following` | フォロー中のユーザーの投稿のみ |
| `foryou` | おすすめ投稿 |

内部状態:

```typescript
interface TimelineState {
  mode: 'following' | 'foryou' | 'global';
  hashtag: string;          // ハッシュタグフィルター
  posts: TimelineItem[];     // 投稿 + 広告の配列
  ads: Ad[];                // 広告設定
  everyN: number;           // N件ごとに広告を挿入
  cursor?: string;          // ページネーションカーソル
  loading: boolean;
  hasMore: boolean;
  error: string | null;
  retryCount: number;
  maxRetries: number;
}
```

- Intersection Observer を使って無限スクロール
- `loadAdConfig()` → `loadInitialPosts()` の順で読み込み
- 投稿と広告を `TimelineItem[]` として統一的に扱い、`isAd()` で判別
- スワイプ操作で LeftNav を開く機能も内蔵

#### `src/components/PostCard.ts` (1970行) — 投稿カード

投稿表示の中心コンポーネント。以下のサブコンポーネントで構成:

```
PostCard
├── PostHeader (avatar, username, timestamp)
├── PostText (markdown レンダリング)
├── PostStage (ZIP/SWF/GIF/画像の表示エリア)
├── PostActions (Fresh/Bookmark/Reply/Share/Impression)
├── ReplyComposer (返信フォーム、展開式)
└── ShareModal (シェアモーダル)
```

2つのモード:

| モード | 説明 |
|--------|------|
| `PREVIEW` | サムネイル表示（未実行）|
| `EXECUTING` | ZIP/SWF を実行中 |

#### `src/components/PostStage.ts` (456行) — 投稿のインタラクティブステージ

投稿の添付ファイルに応じて異なる UI を表示:

| 添付タイプ | 表示 | 実行環境 |
|-----------|------|---------|
| ZIP | 実行ボタン → iframe サンドボックス | 別オリジン iframe |
| SWF | 実行ボタン → Ruffle (Flash エミュレーター) | 同一ページ |
| GIF/画像 | ImagePreview | ライトボックス |
| 音声 | AudioPlayer | 埋め込みプレイヤー |
| なし | 何も表示しない | - |

#### `src/components/SandboxFrame.ts` — サンドボックス iframe

```typescript
export function createSandboxFrame(props: SandboxFrameProps): HTMLElement {
  // <iframe> を作成
  // sandbox 属性: allow-scripts allow-pointer-lock allow-forms allow-popups
  // allow-same-origin はなし！
  // src = sandboxOrigin + "/sandbox/" + postId
}
```

#### `src/components/PostHeader.ts` — 投稿ヘッダー

アバター画像、ユーザー名、表示名、投稿日時を表示。アバターをクリックするとユーザープロフィールへ遷移。

#### `src/components/PostText.ts` — 投稿テキスト

`markdown-it` で Markdown を HTML に変換し、`dompurify` で XSS を防止。
メンション（`@username`）やハッシュタグ、数式（KaTeX）もレンダリング。

#### `src/components/PostActions.ts` (105行) — アクションボタン

| ボタン | 機能 |
|--------|------|
| Fresh! | いいね（カウント+トグル）|
| Bookmark | ブックマーク（カウント+トグル）|
| Reply | 返信フォームを開く |
| Share | シェアモーダル |
| Impressions | 閲覧数（表示のみ）|

#### `src/components/PostComposer.ts` — 投稿作成フォーム

テキスト入力 + ファイル添付（ZIP, SWF, 画像, 音声）が可能。
ハッシュタグ、メンション、アンケートにも対応。

#### `src/components/ReplyComposer.ts` — 返信作成フォーム

PostComposer と似ているが、親投稿への返信として機能。

#### `src/components/ThreadPage.ts` — スレッド詳細ページ

特定の投稿とその返信ツリーを表示。`ThreadView` を使ってツリー構造を描画。

#### `src/components/ThreadView.ts` / `ReplyNode.ts` — スレッドビュー

返信のツリー構造を表示。各返信は `ReplyNode` として再帰的にレンダリング。

#### `src/components/ProfilePage.ts` — ユーザープロフィール

ユーザー情報（アバター、自己紹介、フォロワー/フォロー数）と投稿一覧を表示。
自分自身のプロフィールの場合は編集ボタンが表示される。

#### `src/components/EditProfileModal.ts` — プロフィール編集

アバター、表示名、自己紹介、ヘッダー画像を編集。

#### `src/components/LoginPage.ts` — ログインページ

メールアドレス + パスワードでログイン。

#### `src/components/RegisterPage.ts` — 登録ページ

ユーザー名、メールアドレス、パスワードで新規登録。

#### `src/components/ExplorePage.ts` — 探索ページ

話題の投稿や特定のハッシュタグの投稿を一覧表示。

#### `src/components/SearchPage.ts` / `SearchResults.ts` — 検索

投稿、ユーザー、アーケードゲームを横断検索。

#### `src/components/ArcadePage.ts` — ゲームアーケード

投稿された ZIP/SWF ゲームを一覧表示。ゲームを選んでプレイ可能。

#### `src/components/FlashPlayer.ts` — Flash プレイヤー

Ruffle (WebAssembly Flash エミュレーター) で SWF ファイルを実行。

#### `src/components/DosPlayer.ts` — DOS プレイヤー

js-dos (DOSBox の WebAssembly ポート) で DOS ゲームを実行。

#### `src/components/AudioPlayer.ts` / `AudioVisualizer.ts` — オーディオ

R2 に保存された音声ファイルを再生 + ビジュアライザー表示。

#### `src/components/ImagePreview.ts` — 画像プレビュー

画像/ GIF のライトボックス表示。

#### `src/components/NotificationsPage.ts` — 通知一覧

Fresh（いいね）、返信、メンション、フォローなどの通知を表示。全既読ボタンあり。

#### `src/components/MessagesPage.ts` / `ConversationView.ts` — DM

ダイレクトメッセージの一覧と個別会話ビュー。

#### `src/components/BookmarksPage.ts` — ブックマーク一覧

ブックマークした投稿の一覧。

#### `src/components/SettingsPage.ts` — 設定ページ

プロフィール編集、パスワード変更、言語設定、テーマ設定など。

#### `src/components/AdminLayout.ts` + 各種 Admin タブ — 管理画面

管理者向け画面。以下のタブで構成:

| タブ | 機能 |
|------|------|
| Alerts | 通報された投稿の管理 |
| Hidden | 非表示投稿の管理 |
| Users | ユーザー管理 |
| Ads | 広告管理 |
| Counter | 統計カウンター |

#### `src/components/AdCard.ts` — 広告カード

タイムラインに挿入される広告。ZIP/SWF/GIF の実行も可能。

#### `src/components/CurrentTopic.ts` — トレンド話題

現在トレンドのハッシュタグを表示。

#### `src/components/SkeletonCard.ts` — スケルトンローディング

投稿読み込み中のプレースホルダー。

#### `src/components/ShareModal.ts` — シェアモーダル

投稿の URL をコピー、または外部サービスにシェア。

#### `src/components/SignInPrompt.ts` — サインイン促し

未認証ユーザーがアクションを起こそうとしたときに表示。

#### `src/components/FollowerListModal.ts` — フォロワー一覧

ユーザーのフォロワー/フォロー中リストをモーダル表示。

#### `src/components/LegalPage.ts` — 法務ページ

利用規約、プライバシーポリシー、アバウト、ホワイトペーパーを表示。

#### `src/components/SimilarPosts.ts` — 類似投稿

現在の投稿に類似した投稿を表示。

### 9.5. ライブラリ (`src/lib/`) 解説

#### `src/lib/bridge.ts` — postMessage ブリッジ

サンドボックス iframe とメインウィンドウの間の通信プロトコルを定義。
すべてのメッセージは型安全で、バリデーション関数 `isParentMessage()` / `isSandboxMessage()` でチェックされます。

#### `src/lib/sandbox-bridge.ts` (203行) — サンドボックス通信管理

`SandboxBridge` クラスがサンドボックス iframe とのやり取りを管理:

- `REQUEST_FULLSCREEN` → フルスクリーンオーバーレイを表示
- `REQUEST_FRESH` → Fresh を実行（楽観的更新）
- `POST_SCORE` → スコアをトースト表示

```typescript
export class SandboxBridge {
  private iframe: HTMLIFrameElement;
  private post: Post;

  handleMessage(event: MessageEvent) {
    // オリジンチェック（必須！）
    const allowedOrigins = [sandboxOrigin, 'https://sandbox.flaxia.app'];
    if (!allowedOrigins.includes(event.origin)) return;

    const data = event.data;
    if (!isParentMessage(data)) return;

    // メッセージの種類に応じて処理
    switch (data.type) {
      case 'REQUEST_FULLSCREEN': ...
      case 'REQUEST_FRESH': ...
      case 'POST_SCORE': ...
    }
  }
}
```

#### `src/lib/auth-cache.ts` (49行) — 認証キャッシュ

`/api/me` の結果を5分間キャッシュ。重複リクエスト（同一 Promise の共有）も防止。

```typescript
export async function getMe() {
  // キャッシュ有効 → キャッシュを返す
  // 既に fetch 中 → 同じ Promise を返す
  // それ以外 → fetch
}
export function clearMeCache() { ... }
export function updateMeCache(data) { ... }
```

#### `src/lib/i18n.ts` (68行) — 国際化

`/locales/ja.json` / `/locales/en.json` から翻訳文字列を読み込み。`t()` 関数でキーに対応する文字列を取得。パラメータ置換も可能。

```typescript
await setLocale('ja');
const label = t('nav.home'); // "ホーム"
const msg = t('post.count', { count: 5 }); // "5件の投稿"
```

#### `src/lib/zip-manager.ts` (89行) — ZIP 実行管理

ZIP の実行方式を統一的に管理:

| モード | 説明 |
|--------|------|
| `legacy` | 従来の iframe 実行 |
| `wvfs` | WebAssembly VFS を使用（新しい方式）|

`executeUniversalZip()` はアクティブな ZIP 実行を1つだけ許可し、切り替え時に自動クリーンアップします。

#### `src/lib/performance.ts` — パフォーマンス監視

`PerformanceObserver` を使って Core Web Vitals を計測・ログ出力。

#### `src/lib/modal-state.ts` — モーダル状態管理

モーダルの開閉状態を管理。モーダルが開いているときはページスクロールを無効化。
`modalchange` カスタムイベントを発行して他のコンポーネントに通知。

#### `src/lib/impression-tracker.ts` — インプレッション計測

Intersection Observer を使って投稿が画面に表示された回数を計測。

#### `src/lib/inject-ads.ts` — 広告注入

タイムラインの N 件ごとに広告を挿入。

#### `src/lib/toast.ts` — トースト通知

画面上部に一時的な通知を表示。

#### `src/lib/format.ts` — フォーマット

数値のフォーマット（例: `1234` → `"1.2K"`）。

#### `src/lib/render-html.ts` — HTML レンダリング

`markdown-it` + `dompurify` で安全な HTML を生成。

### 9.6. 型定義 (`src/types/`)

#### `src/types/post.ts` (171行) — 投稿型

主要な型:

```typescript
interface Post {
  id: string;            // 投稿ID
  user_id: string;       // ユーザーID
  username: string;      // ユーザー名
  display_name?: string; // 表示名
  avatar_key?: string;   // アバター画像の R2 キー
  text: string;          // 投稿本文 (Markdown)
  hashtags: string;      // ハッシュタグ（カンマ区切り）
  gif_key?: string;      // 画像/GIF の R2 キー
  payload_key?: string;  // ZIP ファイルの R2 キー
  swf_key?: string;      // SWF ファイルの R2 キー
  thumbnail_key?: string;// サムネイルの R2 キー
  fresh_count: number;   // Fresh（いいね）数
  bookmark_count: number;// ブックマーク数
  reply_count: number;   // 返信数
  impressions: number;   // インプレッション数
  parent_id?: string;    // 親投稿ID（返信の場合）
  root_id?: string;      // ルート投稿ID（返信の場合）
  depth: number;         // 返信の深さ
  created_at: string;    // 作成日時（ISO8601）
  is_freshed?: boolean;  // 自分がFreshしたか
  is_bookmarked?: boolean;// 自分がブックマークしたか
  poll?: Poll;           // アンケート（任意）
}

type TimelineItem = Post | Ad;

enum PostCardMode {
  PREVIEW = 'preview',     // プレビューモード
  EXECUTING = 'executing', // 実行中モード
}
```

### 9.7. データフロー

#### 投稿表示の流れ

```text
1. ユーザーが / にアクセス
2. parseCurrentRoute() → 'timeline'
3. createTimeline() が Timeline クラスをインスタンス化
4. Timeline が /api/timeline に GET リクエスト
5. API が D1 から投稿を取得し JSON で返却
6. Timeline が各投稿に対して createPostCard() を呼ぶ
7. PostCard が PostHeader + PostText + PostStage + PostActions を生成
8. PostStage が gif_key/payload_key/swf_key に応じて適切な表示
9. IntersectionObserver で画面下端に近づくと次のページを自動読み込み
```

#### Fresh（いいね）の流れ

```text
1. ユーザーが Fresh ボタンをクリック
2. PostCard が楽観的更新（即座に UI を反映）
3. POST /api/fresh にリクエスト
4. API が D1 の likes テーブルにレコード追加/削除
5. 失敗した場合は UI をロールバック
```

#### ZIP 実行の流れ

```text
1. ユーザーが投稿の「実行」ボタンをクリック
2. PostStage が mode を EXECUTING に変更
3. createSandboxFrame() が iframe を作成
4. iframe.src = sandboxOrigin + "/sandbox/" + postId
5. サンドボックス Worker が R2 から ZIP を取得
6. ZIP を展開し、HTML を sandbox iframe 内で実行
7. サンドボックス内の JS は window.parent.postMessage で通信
8. メインウィンドウの SandboxBridge が postMessage を受信
9. オリジンチェック → 型バリデーション → 適切な処理
```

### 9.8. バックエンド API

フロントエンドと対話する API は `functions/api/[[route]].ts`（8637行）に集約されています。
認証は `functions/lib/auth.ts` で管理され、D1 の sessions テーブルでセッション管理。

主なエンドポイント:

| エンドポイント | メソッド | 説明 |
|---------------|---------|------|
| `/api/me` | GET | 現在のユーザー情報 |
| `/api/auth/login` | POST | ログイン |
| `/api/auth/register` | POST | 新規登録 |
| `/api/auth/logout` | POST | ログアウト |
| `/api/timeline` | GET | タイムライン取得 |
| `/api/post` | POST | 投稿作成 |
| `/api/post/:id` | GET | 投稿詳細 |
| `/api/fresh` | POST | Fresh トグル |
| `/api/bookmark` | POST | ブックマークトグル |
| `/api/notifications` | GET | 通知一覧 |
| `/api/search` | GET | 検索 |

### 9.9. 開発のコツ

#### 新しいページ/コンポーネントを追加するには

1. `src/components/` に新しいファイルを作成
2. `createXxx()` 関数と `Xxx` クラス（または `PageComponent` インターフェース）を実装
3. `main.ts` の `parseCurrentRoute()` にルートを追加
4. `main.ts` の `navigateTo()` にレンダリングロジックを追加
5. 必要に応じて `LeftNav` にナビゲーション項目を追加

#### 新しい API エンドポイントを追加するには

`functions/api/[[route]].ts` にルートハンドラーを追加するか、新しいファイルを `functions/api/` 以下に作成。
Hono のルーターを使ってパスを定義する。

#### CI/CD

GitHub Actions が以下の自動チェックを行います:

- **CI** (`.github/workflows/ci.yml`): lint → typecheck → test → build
- **Deploy** (`.github/workflows/deploy.yml`): main ブランチにプッシュで自動デプロイ
- **Release** (`.github/workflows/release.yml`): タグをプッシュでリリース作成 + Tauri/Capacitor ビルド

### 9.10. 翻訳（i18n）の追加方法

Flaxia は日本語と英語に対応しています。翻訳システムは `src/lib/i18n.ts` で実装されています。

#### 翻訳ファイルの場所

```
public/locales/
├── index.json    # 利用可能な言語の一覧
├── ja.json       # 日本語（618行）
└── en.json       # 英語（618行）
```

#### 新しい翻訳キーを追加する

1. `ja.json` と `en.json` の両方に同じキーを追加する
2. キーはドット区切りの名前空間を使う（例: `nav.home`, `post.delete_title`）
3. コード内で `t()` 関数を使って参照する

```typescript
import { t } from '../lib/i18n.js';

// 引数なし
const label = t('nav.home'); // → "ホーム" / "Home"

// パラメータ置換（{variable} 形式）
const msg = t('notifications.fresh', { actor: '@user' });
// ja: "{actor} が投稿にいいねしました"
// → "@user が投稿にいいねしました"
```

#### 対応言語を追加する

1. `public/locales/` に `fr.json` などの新しいファイルを作成
2. `public/locales/index.json` にエントリを追加
3. コード上は何も変更不要（`i18n.ts` が自動で読み込む）

#### 注意点

- `t()` に存在しないキーを渡すとキー名がそのまま表示される（フォールバック）
- 英語 (`en.json`) が最終フォールバックとして常に読み込まれる
- パラメータは `{variableName}` 形式。型安全ではないので実行時に確認

### 9.11. データベースマイグレーションの追加方法

Flaxia は Cloudflare D1 (SQLite) を使用しています。マイグレーションファイルは `migrations/` に時系列で保存されています（現在46ファイル）。

#### 新しいマイグレーションを作成する

```bash
# マイグレーションファイルを生成
npx wrangler d1 migrations create flaxia <名前>

# 例
npx wrangler d1 migrations create flaxia add_pinned_posts
# → migrations/0047_add_pinned_posts.sql が生成される
```

生成された SQL ファイルに ALTER TABLE / CREATE TABLE などを記述:

```sql
-- migrations/0047_add_pinned_posts.sql
ALTER TABLE posts ADD COLUMN is_pinned INTEGER DEFAULT 0;
```

#### マイグレーションを適用する

```bash
# ローカル
npm run migrate:local

# 本番
npm run migrate:prod
```

#### 注意点

- D1 は SQLite ベース。ALTER TABLE の制限（ADD COLUMN のみ、DROP COLUMN 不可）に注意
- マイグレーションは一度適用するとロールバックできない（追加のマイグレーションで打ち消す）
- ローカルでは `.wrangler/state/v3/d1/` に SQLite ファイルが作成される
- マイグレーションは `wrangler.toml` の `[[d1_databases]]` で指定された DB に適用される

### 9.12. 依存関係の追加方法

```bash
# 通常の依存関係
npm add パッケージ名

# 開発用依存関係
npm add -D パッケージ名

# 型定義
npm add -D @types/パッケージ名
```

#### ルール

- すべて `npm install` で行う（`pnpm` や `yarn` は使わない）
- 大規模なライブラリを追加する場合は `vite.config.ts` の `manualChunks` に分割設定を追加する
- 型定義が必要なライブラリは `@types/*` も必ず追加する
- `packageManager` フィールドに注意（npm を使う場合は `npm` に変更することも検討）

### 9.13. コード規約・命名規則

#### ファイル命名

| 種類 | 規則 | 例 |
|------|------|----|
| コンポーネント | `PascalCase.ts` | `PostCard.ts`, `Timeline.ts` |
| ライブラリ | `kebab-case.ts` | `auth-cache.ts`, `sandbox-bridge.ts` |
| 型定義 | `kebab-case.d.ts` | `post.ts`, `env.d.ts` |
| テスト | `kebab-case.test.ts` | `auth.test.ts` |

#### クラスと関数の命名

- コンポーネントクラスは `PascalCase`（例: `class Timeline`）
- コンポーネントを生成するファクトリ関数は `createPascalCase`（例: `createTimeline()`）
- ライブラリの関数は `camelCase`（例: `getMe()`, `setLocale()`）
- 型・インターフェースは `PascalCase`（例: `Post`, `TimelineProps`）

#### コンポーネントのパターン

すべてのコンポーネントはファクトリ関数 + クラスのパターンに従います:

```typescript
// 1. Props の型定義（必要な場合）
export interface MyComponentProps {
  someValue: string;
}

// 2. クラス（PageComponent インターフェースに準拠推奨）
export class MyComponent {
  private element: HTMLElement;

  constructor(props: MyComponentProps) {
    this.element = this.createElement();
  }

  private createElement(): HTMLElement {
    // DOM を組み立てて返す
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy(): void {
    // イベントリスナーなどを削除
  }
}

// 3. ファクトリ関数
export function createMyComponent(props: MyComponentProps): MyComponent {
  return new MyComponent(props);
}
```

#### TypeScript のコーディング規約

- すべての import パスは `.js` 拡張子で終わる（例: `'./components/Timeline.js'`）
- `any` 型の使用は Biome で許可されているが、可能な限り避ける
- プライベートフィールドは `private` キーワードを使う
- オプショナルは `undefined` ではなく `?` を使う（例: `name?: string`）
- Biome の auto-format / organize-imports に従う

### 9.14. CSS の設計思想

Flaxia の CSS は **Vanilla CSS**（CSS フレームワークなし）です。

#### CSS ファイル構成

| ファイル | 役割 |
|---------|------|
| `index.html` の `<style>` 内 | Critical CSS（初回表示に必要な最小限のスタイル） |
| `src/styles/main.css` (4249行) | 全ページのスタイル |

#### 命名規則

- クラス名は `kebab-case`（例: `.post-card`, `.left-nav`）
- 状態は `--` で修飾（例: `.nav-item--active`, `.left-nav--open`）
- コンポーネント固有のクラスはコンポーネント名をプレフィックスにする（例: `.timeline-header`, `.post-actions`）

#### CSS 変数（カスタムプロパティ）

ルート要素で定義されたカラーパレット:

```css
:root {
  --bg-primary:    #ffffff;
  --bg-secondary:  #f0fdf4;
  --bg-input:      #f1f5f9;
  --border:        #e2e8f0;
  --text-primary:  #0f172a;
  --text-muted:    #64748b;
  --accent:        #22c55e;
  --accent-dark:   #16a34a;
  --danger:        #ef4444;
}
```

#### レスポンシブデザイン

| ブレークポイント | 挙動 |
|-----------------|------|
| `> 1024px` | 3カラム（Left Nav + メイン + Right Panel）|
| `768px – 1024px` | 2カラム（Right Panel 非表示）|
| `< 768px` | 1カラム（Left Nav はハンバーガーメニュー）|

#### CSS の編集指針

- 新しいコンポーネントを作ったら対応する CSS を `main.css` に追加する
- Critical CSS（`index.html` のインライン）は本当に初期表示に必要なものだけにする
- Tailwind や CSS-in-JS は使わない。Vanilla CSS を維持する

### 9.15. デバッグのコツ

#### ブラウザ開発者ツール

```javascript
// コンソールで現在の認証状態を確認
await fetch('/api/me', { credentials: 'include' }).then(r => r.json());

// ローカルストレージのセッショントークン
localStorage.getItem('flaxia_session');

// i18n のデバッグ
import.meta.env.VITE_SANDBOX_ORIGIN;
```

#### Wrangler のログ

```bash
# デプロイ済み環境のログをリアルタイム表示
wrangler pages deployment tail

# ローカル開発時の Wrangler ログ（dev サーバーのコンソールに出力）
# npm run dev を実行したターミナルで確認
```

#### ネットワークデバッグ

- Vite (`:3000`) と Wrangler (`:8787`) の2プロセスが動いていることを意識する
- API リクエストは Vite が Wrangler にプロキシしている
- ブラウザのネットワークタブで `/api/*` のリクエストを確認すると、すべて `localhost:3000` に見える
- 400/500 エラーは Wrangler 側のログを確認

#### よく使うデバッグ手法

```bash
# Biome のチェックだけ実行（コミット前に）
npm run lint

# 特定のファイルだけフォーマット
npx biome format --write src/components/MyComponent.ts

# 型エラーの詳細を表示
npm run typecheck 2>&1 | head -50

# テストを1ファイルだけ実行
npm run test:auth

# テストを verbose モードで実行
node --test --experimental-strip-types --test-verbose tests/auth.test.ts
```

### 9.16. 知っておくべき重要コンセプト

#### 楽観的更新（Optimistic Update）

Fresh（いいね）やブックマークは、API の応答を待たずに先に UI を更新します。失敗した場合はロールバックします。

```typescript
// PostCard 内の楽観的更新
private async handleFresh() {
  const wasFreshed = this.isFreshed;
  // 先に UI を更新
  this.isFreshed = !this.isFreshed;
  this.freshCount += this.isFreshed ? 1 : -1;
  this.updateActions();

  try {
    // API リクエスト
    await fetch('/api/fresh', { ... });
  } catch {
    // 失敗したらロールバック
    this.isFreshed = wasFreshed;
    this.freshCount -= this.isFreshed ? 1 : -1;
    this.updateActions();
  }
}
```

#### 型安全な postMessage 通信

サンドボックス iframe との通信はすべて `bridge.ts` の型定義を通して行われます。未知のメッセージは `isParentMessage()` / `isSandboxMessage()` で弾かれます。

#### コンポーネントのキャッシュ戦略

一部のビュー（timeline, profile, explore, search, arcade, bookmarks）は `cachedContentComponent` に保存され、戻る際に復元されます。これにより:
- スクロール位置が維持される
- API の再取得が不要
- コンポーネントの再生成コストが削減される

#### 2オリジンセキュリティモデル

```
メインオリジン (flaxia.app)
  ├── ユーザーのセッション情報
  ├── API へのアクセス権限
  └── ローカルストレージ

サンドボックスオリジン (sandbox.flaxia.app)
  ├── 任意の JavaScript を実行可能
  ├── メインオリジンの Cookie にアクセス不可
  └── postMessage で限定された通信のみ許可
```

---

## 参考リンク

| リソース | 場所 |
|---------|------|
| セットアップ手順 | `docs/setup.md` |
| API ドキュメント | `docs/api.md` |
| データベーススキーマ | `docs/database.md` |
| アーキテクチャ解説 | `docs/architecture.md` |
| ActivityPub 連携 | `docs/activitypub.md` |
| デプロイ手順 | `docs/deployment.md` |
| サンドボックス解説 | `docs/sandbox.md` |
| AI エージェント用ガイド | `AGENT.MD` |
| ローカルテストアカウント | `local-test-accounts.md` |
| セキュリティ監査レポート | `vulnerability-report.md` |
| 未訳機能の TODO | `TODO.md` |

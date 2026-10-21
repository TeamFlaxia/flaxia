# Flaxia へのコントリビューションガイド

Flaxia の開発に興味を持っていただき、ありがとうございます。
このドキュメントでは、バグ報告・機能提案・コード寄稿に関するルールと手順を説明します。

## 前提

- 本プロジェクトには [CLA.md](./CLA.md)（コントリビューターライセンス契約）が適用されます。PR を提出する前に必ずお読みください。
- 本プロジェクトは OSS です。コントリビューションを行う前に [LICENSE](./LICENSE) を確認してください。

## バグ報告・機能提案

Issue は GitHub の [Issues](https://github.com/RemydreScarlet/flaxia/issues) から報告してください。

- バグ報告では、再現手順・期待される動作・実際の動作・環境（ブラウザ、OS など）を明記してください。
- 機能提案では、その機能が解決する問題と、ユースケースを説明してください。
- 重複を避けるため、投稿前に既存の Issue を検索してください。

## 開発環境のセットアップ

必要なソフトウェア:

- Node.js **22**（`.nvmrc` 推奨）
- npm（Node.js に同梱）

```bash
# 1. 依存関係のインストール
npm install

# 2. 環境変数の設定（最低限 CLOUDFLARE_ACCOUNT_ID）
cp .env.example .env

# 3. ローカルデータベースのマイグレーションを実行
npm run migrate:local

# 4. 開発サーバーを起動（http://localhost:8787）
npm run dev
```

> 注意: 依存関係の操作は必ず `npm` で行ってください。`pnpm` や `yarn` は使わないでください。
> 詳細は [docs/setup.md](./docs/setup.md) と [Before_implementing.md](./Before_implementing.md) の「プロジェクトのセットアップ」を参照してください。

## コーディングの前に

**実装を始める前に、必ず [Before_implementing.md](./Before_implementing.md) を最初から最後まで読んでください。**
このドキュメントには用語集、開発環境の構築手順、フロントエンドコードの全解説、コード規約、i18n・マイグレーション・依存関係の追加方法など、Flaxia を理解するために必要な情報がすべてまとめられています。

あわせて以下のドキュメントも確認してください:

- [docs/architecture.md](./docs/architecture.md) — アーキテクチャ概要
- [docs/database.md](./docs/database.md) — データベース設計
- [docs/api.md](./docs/api.md) — API 仕様
- [AGENTS.md](./AGENTS.md) — プロジェクト構成とコーディング規約

## 作業フロー

1. リポジトリをフォークし、`main` からトピックブランチを切ります。
   ```bash
   git checkout -b feature/your-feature
   ```
2. 変更を実装します。
3. 変更内容に応じてテストを追加または更新します。
4. ローカルで lint・typecheck・テストを実行し、すべて通ることを確認します。
5. 変更をコミットし、`main` へプルリクエストを作成します。

> コミット時に husky + lint-staged の pre-commit フックが実行され、ステージングされたファイルで `biome check` が自動実行されます。エラーがあるとコミットがブロックされます。

## コーディング規約

[Before_implementing.md](./Before_implementing.md) の「コード規約・命名規則」と [AGENTS.md](./AGENTS.md) の内容に従ってください。主な規約:

- TypeScript strict モード — `any` の使用は可能な限り避ける
- すべての import パスは `.js` 拡張子で終わる（例: `'./components/Timeline.js'`）
- コンポーネントは「ファクトリ関数（`createPascalCase()`）+ クラス」のパターンに従う
- クラス・型は `PascalCase`、ライブラリ関数は `camelCase`、ファイル名は `kebab-case`
- クラスコンポーネントではなく関数ベースの設計を維持する
- D1 クエリは常にプリペアドステートメントを使用
- サンドボックス描画・R2 アップロードなどは共有モジュールを使用し、重複を作らない
- CSS は Vanilla CSS（Tailwind / CSS-in-JS は使わない）

## 重要制約

変更時は以下の制約に違反しないよう注意してください:

- 投稿本文: 200 文字以下
- ペイロードサイズ: 投稿 10MB 以下 / 広告 200MB 以下
- タイムラインは時系列のみ（アルゴリズムソートなし）
- すべての iframe で `allow-same-origin` は**恒久的に禁止**
- CSP は `<meta>` タグではなく HTTP ヘッダーで適用
- 3 カラムレイアウト（240px / 600px / 350px）

## 品質チェック

PR を提出する前に、ローカルで以下を実行してください:

```bash
# リント（Biome）
npm run lint

# 型チェック
npm run typecheck

# 全テスト
npm test

# 必要に応じてビルド
npm run build
```

CI（[.github/workflows/ci.yml](./.github/workflows/ci.yml)）では lint・typecheck・test・build のすべてが実行されます。

## コミットメッセージ

- 変更内容を簡潔に説明するメッセージを使用してください。
- 可能であれば Conventional Commits 形式（`feat:` / `fix:` / `refactor:` / `docs:` / `test:` など）を推奨します。

## プルリクエスト

- PR は `main` ブランチを対象に作成してください。
- PR の説明には、変更の目的と、テスト結果を含めてください。
- 1 つの PR は 1 つの論理的な変更にしてください。大きすぎる変更はレビューしづらくなるため、分割を検討してください。
- マージ前に CLA に同意している必要があります。

## ライセンス

コントリビューションを提出すると、本プロジェクトはあなたのコントリビューションを [CLA.md](./CLA.md) に従って利用・再ライセンスすることができます。詳細は CLA をお読みください。

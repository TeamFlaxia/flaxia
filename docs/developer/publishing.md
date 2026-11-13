# ゲームの公開

Flaxia のゲームは **投稿の添付ファイル（ZIP）** として公開します。
ZIP の中身は `sandbox.flaxia.app` の隔离環境で実行されます。

---

## 1. 公開フロー

```
ZIP 作成 → 投稿作成（prepare）→ アップロード（upload）→ 確定（commit）→ 審査・配信
```

### 1. ZIP を作成する

- ルートに `index.html` が必須です。
- 相対パスでアセットを参照してください（`./js/main.js` など）。
- 外部 HTTP(S) の読み込みも可能です（サンドボックス CSP が許可）。

### 2. 投稿を作成する

`POST /api/posts/prepare`（[REST API](rest-api.md#8-メディア--アップロード)）で
投稿IDとアップロード用URLを発行します。

### 3. アップロードする

`PUT /api/upload/:key` に ZIP のバイナリを送ります。

### 4. 確定する

`POST /api/posts/commit` に `postId` と `zipKey` を指定します。

### 5. 審査・配信

- ファイルスキャン（ClamAV / 構造チェック）を通過すると公開されます。
- 公開後はタイムライン・アーケードに表示され、ゲームが実行できます。

---

## 2. ZIP 仕様

### サーバー側（アップロード時）

| 項目 | 制限 |
|---|---|
| Content-Length | 10 MB 以下 |
| Content-Type | `application/zip` |

### クライアント側（実行前）

| 項目 | 制限 |
|---|---|
| ファイル数 | 255 以下 |
| パス長 | エントリごとに 255 文字以下 |
| ディレクトリ深度 | 10 階以下 |
| 展開後サイズ | 100 MB 以下 |
| 入れ子 ZIP | 不可 |
| シンボリックリンク | 不可 |
| パス traversal（`..`） | 不可 |
| 絶対パス | 不可 |
| `index.html` | ルートに必須 |

### 許可される拡張子

```
.html .css .js .wasm .png .jpg .jpeg .gif .webp .svg
.mp3 .wav .ogg .mp4 .webm .json .txt .glsl .wgsl
.woff .woff2 .ttf .otf .eot .ico .xml .map .dat .bin
```

---

## 3. 実行環境

- ゲームは `sandbox.flaxia.app` の WVFS 経由で配信されます。
- `allow-same-origin` はなく、opaque origin で実行されます。
- `localStorage` / `sessionStorage` は互換シム経由でブラウザローカルに保存されます。
- Cookie は読み書きできません。
- キャプチャブリッジが自動注入されます（ゲーム側の実装不要）。
- Flaxia Game SDK は `/sdk/game.js` から読み込めます。

詳しくは [../sandbox.md](../sandbox.md) と [Game API](game-api.md) を参照してください。

---

## 4. 審査・スキャン

- アップロード時にファイルスキャンが実行されます。
- ブロックリスト一致・構造異常・タイプ不一致は `400` で拒否されます。
- 公開後の NSFW スクリーニングは別途行われ、問題があれば非表示になります。
- ゲーム内の外部リソースはサンドボックス CSP の許可範囲に依存します。

---

## 5. バージョン管理

投稿を編集すると新しいバージョンとして保存できます。

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/posts/:id/versions` | バージョン一覧 |
| POST | `/api/posts/:id/versions/prepare` | 新バージョン用アップロードURL |
| POST | `/api/posts/:id/versions/commit` | 新バージョン確定 |

プレイヤーは通常最新バージョンを実行します。

---

## 6. 公開前チェックリスト

- [ ] `index.html` がルートにある
- [ ] 相対パスでアセットを参照している
- [ ] 拡張子が許可リストにある
- [ ] 10 MB 以下・255 ファイル以下
- [ ] `..` や絶対パスを含まない
- [ ] Flaxia Game SDK を読み込んでいる（`/sdk/game.js`）
- [ ] `gameId` を安定した値にしている
- [ ] マルチプレイを使う場合、2人前提のUIになっている
- [ ] スコア・フルスクリーン・Fresh を適切なタイミングで呼んでいる
- [ ] 外部リソースに依存しすぎていない

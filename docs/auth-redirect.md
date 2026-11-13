# ログイン画面の Auth 移行（リダイレクト方式）

## 目的

ログイン・登録・復旧の画面を `auth.flaxia.app` に移し、Flaxia 本体から
パスワードを扱うコードを無くす。Flaxia は「Auth のログイン画面へ送る」ことと、
「戻ってきたセッションが有効かを毎回確認する」ことだけを担当する。

## Web の流れ

1. `/login`（または `/register`）に来た利用者を、SPA の画面ではなく
   `GET /api/auth/start` へ送る。
2. `/api/auth/start` は PKCE の verifier / challenge と `state` を生成し、
   HttpOnly・`SameSite=Lax` の `flaxia_oauth` Cookie に保存して
   `https://auth.flaxia.app/login?...` へ 302 する。
3. Auth のログイン画面で SRP-6a 認証（旧方式・復旧コード・新規登録も同じ画面）
   を行う。ログインの識別子はユーザー名でもメールアドレスでもよく、`POST
   /api/auth/flaxia/authorize` で一度限りの `code` を取得する。
4. Auth は `return_uri`（`https://flaxia.app/api/auth/callback`）へ
   `code` と `state` を付けて戻す。
5. `GET /api/auth/callback` は Cookie の `state` を照合し、`AUTH_SERVICE`
   binding 経由で `/api/flaxia/exchange` を呼んで grant を得る。プロフィールの
   作成・リンク・旧資格情報の削除は既存の `/flaxia/exchange` と同じ処理を共有する。
6. `session=<grant>` Cookie を発行し、`return_to`（既定 `/home`）へ 302 する。

Flaxia のプロフィールに実在のメールアドレスがある場合、リンク完了・移行時に Auth へ
コピーする（`@users.flaxia.invalid` のプレースホルダは除外）。これにより、移行済みの
アカウントもメールアドレスでログインできる。

## セッションの有効性

grant（43文字）をセッション Cookie にした後は、`functions/lib/auth.ts` の
`getSession` / `getMeWithSession` が毎リクエスト `introspectAuthGrant` で Auth に
問い合わせる。Auth が失効・凍結・credential stamp の変化を返せば、Flaxia は
即座に未認証として扱う。`isSessionAuthorized` は移行期間の D1 セッション向けの
追加チェックで、Auth セッションでは introspect が同じ役割を果たす。

## ネイティブアプリ

ネイティブの WebView は `capacitor://localhost` / `tauri://localhost` で動くため、
`https://flaxia.app/api/auth/callback` へ戻すとアプリのシェルから外れてしまう。
そのため次の経路を使う。

1. アプリが PKCE verifier と `state` を端末内（`localStorage`）に保存し、
   `return_uri=flaxia://auth/callback` を付けて Auth のログイン画面を
   **システムブラウザ**で開く（Capacitor は AppLauncher 経由、カスタム
   タブでは `flaxia://` の復帰が拒否される場合があるため）。
2. ログイン後、Auth が `flaxia://auth/callback?code=...&state=...` へ 302。
3. OS がアプリを起動し、アプリが URL を受け取る。
4. アプリが native fetch で `POST /api/auth/flaxia/exchange` に `code` と
   `verifier` を送り、grant をネイティブの Cookie ジャーに保存する。

`flaxia://` スキームの登録は Tauri の deep-link プラグイン設定と、
Capacitor の Android/iOS プロジェクトへの追記（`scripts/patch-native-deeplink.mjs`）
で行う。

## リダイレクト先の制限

Flaxia 側の `return_to` は `/` で始まる同一オリジンのパスのみ許可し、
`//`・バックスラッシュ・制御文字を含む値は `/home` に落とす
（`functions/lib/auth-redirect.ts`）。Auth 側も `return_uri` を完全一致の
許可リストで検証する。

## ロールアウト

1. `TeamFlaxia/flaxia-auth` の変更（`/login` と復旧コード登録）を先にデプロイ。
2. 本リポジトリをデプロイし、`/login`・`/register` をリダイレクトへ切り替える。
3. 問題時は Flaxia 側だけを戻せる。Auth 側の追加はそのままでも無害。

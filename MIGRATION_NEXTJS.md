# Vite → Next.js 完全移行計画書

## 概要

**プロジェクト**: Flaxia - Chronological SNS where posts are living, interactive applications  
**現状**: Vanilla TypeScript SPA (Vite 5) → Cloudflare Pages Functions (Hono) の構成  
**目標**: Next.js 14+ App Router + React に完全移行。SSR を導入して SEO を最大改善。  
**API レイヤー**: Cloudflare Pages Functions (Hono) は現状維持  
**プラットフォーム**: Web (Next.js SSR) + Tauri Desktop + Capacitor Mobile を維持

---

## 現状アーキテクチャ

```
index.html (SPA entry)
└── src/main.ts (SPA router + global state)
    ├── src/components/*.ts (45 components)
    │   ├── Class-based: LeftNav, RightPanel, Timeline, PostCard, ThreadPage,
    │   │               ExplorePage, NotificationsPage, BookmarksPage, ArcadePage
    │   └── Factory-function: PostStage, SandboxFrame, ProfilePage, SearchPage,
    │                        SettingsPage, LoginPage, RegisterPage, LegalPage
    ├── src/lib/*.ts (30 utility modules)
    ├── src/types/*.ts (type definitions)
    └── src/styles/main.css (3127 lines, global CSS)

functions/api/[[route]].ts (Hono ✕ Cloudflare Pages = 8264 lines, all API routes)
```

### 現在のルーティング（main.ts の SPA ルーター）

| パス | ビュー | 認証 |
|------|--------|------|
| `/`, `/home` | timeline | 不要 |
| `/login` | login | 不要 |
| `/register` | register | 不要 |
| `/explore` | explore | 不要 |
| `/search?q=&type=` | search | 不要 |
| `/arcade` | arcade | 不要 |
| `/arcade/:gameId` | arcade (game) | 不要 |
| `/thread/:postId` | thread | 不要 |
| `/users/:username` | profile | 不要 |
| `/profile/:username` | profile | 不要 |
| `/terms`, `/privacy`, `/about`, `/whitepaper` | legal | 不要 |
| `/notifications` | notifications | 必要 |
| `/bookmarks` | bookmarks | 必要 |
| `/settings` | settings | 必要 |
| `/admin/:tab` | admin | 必要 (admin権限) |

### 現在のコンポーネント一覧

| ファイル | パターン | 役割 |
|----------|----------|------|
| `LeftNav.ts` | Class + Factory | 左ナビゲーション (240px) |
| `RightPanel.ts` | Class + Factory | 右パネル (350px, トレンド/フォロー候補) |
| `Timeline.ts` | Class + Factory | メインタイムライン |
| `PostCard.ts` | Class + Factory | 投稿カード (1970行の巨大コンポーネント) |
| `PostStage.ts` | Pure Function | 投稿メディア表示 (GIF/ZIP/SWF/Flash) |
| `PostActions.ts` | Pure Function | Fresh/Bookmark/Reply/Share ボタン |
| `PostComposer.ts` | Class | 投稿作成フォーム (1744行) |
| `PostHeader.ts` | Pure Function | 投稿ヘッダー (アバター/名前/時間) |
| `PostText.ts` | Pure Function | 投稿テキスト描画 (Markdown/数式/ハッシュタグ) |
| `SandboxFrame.ts` | Pure Function | サンドボックス iframe |
| `ThreadPage.ts` | Class + Factory | スレッド詳細ページ |
| `ThreadView.ts` | (要確認) | スレッドビュー |
| `ReplyComposer.ts` | (要確認) | 返信作成フォーム |
| `ReplyNode.ts` | (要確認) | 返信ツリー表示 |
| `ProfilePage.ts` | Factory function | プロフィールページ |
| `ExplorePage.ts` | Class + Factory | 探すページ |
| `SearchPage.ts` | Factory function | 検索ページ |
| `ArcadePage.ts` | Class + Factory | アーケード (フルスクリーンゲームビューア) |
| `NotificationsPage.ts` | Class + Factory | 通知一覧 |
| `BookmarksPage.ts` | Class + Factory | ブックマーク一覧 |
| `SettingsPage.ts` | Factory function | 設定ページ |
| `LoginPage.ts` | Factory function | ログインページ |
| `RegisterPage.ts` | Factory function | 登録ページ |
| `LegalPage.ts` | Factory function | 規約/プライバシー/About/Whitepaper |
| `AdCard.ts` | Pure Function | 広告カード |
| `AdminLayout.ts` | Factory function | 管理画面レイアウト |
| `AdminAlertsTab.ts` | Factory function | 管理画面: アラート |
| `AdminHiddenTab.ts` | Factory function | 管理画面: 非表示投稿 |
| `AdminUsersTab.ts` | Factory function | 管理画面: ユーザー管理 |
| `AdminAdsTab.ts` | Factory function | 管理画面: 広告管理 |
| `AdminCounterTab.ts` | Factory function | 管理画面: カウンター |
| `AudioPlayer.ts` | Pure Function | 音声プレイヤー |
| `AudioVisualizer.ts` | Pure Function | 音声ビジュアライザー |
| `DosPlayer.ts` | (要確認) | DOS エミュレーター (js-dos) |
| `FlashPlayer.ts` | (要確認) | Flash プレイヤー (ruffle) |
| `ImagePreview.ts` | Pure Function | 画像プレビュー |
| `ShareModal.ts` | Pure Function | シェアモーダル |
| `SignInPrompt.ts` | Pure Function | サインイン促し |
| `SkeletonCard.ts` | Pure Function | スケルトンローディング |
| `CurrentTopic.ts` | Pure Function | 現在のトピック表示 |
| `SimilarPosts.ts` | (要確認) | 類似投稿 |
| `EditProfileModal.ts` | (要確認) | プロフィール編集モーダル |
| `FollowerListModal.ts` | (要確認) | フォロワー一覧モーダル |
| `UserPostList.ts` | (要確認) | ユーザー投稿一覧 |
| `SearchResults.ts` | (要確認) | 検索結果 |

---

## 全体計画（全9フェーズ）

### [ ] Phase 0: プロジェクトセットアップ
- [ ] Next.js 14+ と React 18+ の依存関係をインストール
- [ ] `next.config.ts` の作成 (output: standalone, image domains, etc.)
- [ ] `tsconfig.json` の更新 (Next.js 用の調整)
- [ ] `src/app/` ディレクトリ構造の作成
- [ ] 現在の `vite.config.ts` を維持（移行完了まで両立可能に）

### [ ] Phase 1: ルートレイアウトとグローバル設定
- [ ] `src/app/layout.tsx` - ルートレイアウト
  - 現在の `index.html` から以下を移行:
    - `<head>`: メタタグ, font preconnect, Google Analytics, AdSense
    - インライン critical CSS (`:root`変数, ベーススタイル, ローダー, レイアウト)
    - `<body>`: 初期ローダー要素, `#app` コンテナ
    - Service Worker (`/sw.js`) 登録
  - 現在の `main.ts` DOMContentLoaded ロジックは layout の `useEffect` またはクライアントコンポーネントに
- [ ] `src/app/globals.css` - グローバルスタイル
  - `src/styles/main.css` (3127行) をそのまま移行
  - 将来的に Tailwind CSS 移行を検討しても良い
- [ ] `src/lib/performance.ts` の `initPerformanceMonitoring` を layout の `useEffect` で呼び出し

### [ ] Phase 2: プロバイダーとコンテキスト

Next.js の SSR ではグローバルな `main.ts` 状態を React Context に置き換える。以下の Context を作成:

#### AuthContext (`src/app/_providers/AuthContext.tsx`)
- 現在の `main.ts` の認証状態 (`currentUser`, `checkAuth()`, `getMe()`) を置き換え
- 初期ロード時に `getMe()` を呼び出し
- `login()`, `logout()`, `refreshUser()` メソッドを提供
- クライアントコンポーネント (`'use client'`)

#### NotificationContext (`src/app/_providers/NotificationContext.tsx`)
- 現在の通知ポーリングロジック (`fetchNotifications()`, `refreshNotificationBadges()`) を置き換え
- WebSocket 接続 (`connectPushWebSocket()`) の管理
- 未読カウントの管理
- Tauri/Capacitor のネイティブ通知統合
- クライアントコンポーネント

#### I18nContext (`src/app/_providers/I18nContext.tsx`)
- 現在の `src/lib/i18n.ts` の `initI18n()`, `t()`, `setLocale()`, `getLocale()` を React Context 化
- 翻訳ファイルのロードとキャッシュ
- SSR ではデフォルト locale を返し、クライアントで hydrate

#### Providers (`src/app/_providers/Providers.tsx`)
- 上記のプロバイダーをまとめるコンポーネント
- `src/app/layout.tsx` で使用

### [ ] Phase 3: 共通コンポーネントの React 化

#### 3a: レイアウトコンポーネント
- [ ] `src/components/LeftNav.tsx` - 左ナビゲーション (React, 'use client')
- [ ] `src/components/RightPanel.tsx` - 右パネル (React, 'use client')

#### 3b: 基本投稿コンポーネント
- [ ] `src/components/PostCard.tsx` - **最重要コンポーネント** (1970行)
  - サブコンポーネント化推奨:
    - `PostCardHeader.tsx`
    - `PostCardText.tsx`
    - `PostCardActions.tsx`
    - `PostCardStage.tsx`
    - `PostCardPoll.tsx`
    - `PostCardMenu.tsx`
  - Impression tracking は IntersectionObserver + カスタムフック
- [ ] `src/components/PostComposer.tsx` - 投稿作成
- [ ] `src/components/PostStage.tsx` - 投稿メディア表示
- [ ] `src/components/PostActions.tsx` - アクションボタン
- [ ] `src/components/PostHeader.tsx` - 投稿ヘッダー
- [ ] `src/components/PostText.tsx` - 投稿テキスト
- [ ] `src/components/SandboxFrame.tsx` - サンドボックスiframe
- [ ] `src/components/ImagePreview.tsx` - 画像プレビュー

#### 3c: インタラクションコンポーネント
- [ ] `src/components/ReplyComposer.tsx` - 返信作成
- [ ] `src/components/ReplyNode.tsx` - 返信ツリー
- [ ] `src/components/ThreadView.tsx` - スレッドビュー
- [ ] `src/components/ShareModal.tsx` - シェアモーダル
- [ ] `src/components/SignInPrompt.tsx` - サインイン促し
- [ ] `src/components/SkeletonCard.tsx` - スケルトンローディング

#### 3d: メディアプレーヤー
- [ ] `src/components/AudioPlayer.tsx`
- [ ] `src/components/AudioVisualizer.tsx`
- [ ] `src/components/DosPlayer.tsx`
- [ ] `src/components/FlashPlayer.tsx`

#### 3e: 広告/管理
- [ ] `src/components/AdCard.tsx`
- [ ] `src/components/AdminLayout.tsx`
- [ ] `src/components/AdminAlertsTab.tsx`
- [ ] `src/components/AdminHiddenTab.tsx`
- [ ] `src/components/AdminUsersTab.tsx`
- [ ] `src/components/AdminAdsTab.tsx`
- [ ] `src/components/AdminCounterTab.tsx`

#### 3f: モーダル
- [ ] `src/components/EditProfileModal.tsx`
- [ ] `src/components/FollowerListModal.tsx`
- [ ] `src/components/CurrentTopic.tsx`
- [ ] `src/components/SimilarPosts.tsx`
- [ ] `src/components/UserPostList.tsx`
- [ ] `src/components/SearchResults.tsx`

### [ ] Phase 4: ページコンポーネント移行

各 SPA ルートを Next.js App Router のページファイルに変換:

| パス | ファイル | 備考 |
|------|----------|------|
| `/` | `src/app/page.tsx` | タイムラインページ（SSR + Client Components） |
| `/home` | `src/app/home/page.tsx` | 同上 (リダイレクトまたは alias) |
| `/login` | `src/app/login/page.tsx` | クライアント専用 (CSR) |
| `/register` | `src/app/register/page.tsx` | クライアント専用 (CSR) |
| `/explore` | `src/app/explore/page.tsx` | SSR + Client Components |
| `/search` | `src/app/search/page.tsx` | SSR + Client Components |
| `/arcade` | `src/app/arcade/page.tsx` | CSR (client-heavy) |
| `/arcade/[gameId]` | `src/app/arcade/[gameId]/page.tsx` | SSR metadata + CSR content |
| `/thread/[postId]` | `src/app/thread/[postId]/page.tsx` | **SSR重要** - 動的OGP生成 |
| `/users/[username]` | `src/app/users/[username]/page.tsx` | **SSR重要** - プロフィールOGP |
| `/profile/[username]` | `src/app/profile/[username]/page.tsx` | 同上 (redirect) |
| `/notifications` | `src/app/notifications/page.tsx` | 認証必須 (middlewareで保護) |
| `/bookmarks` | `src/app/bookmarks/page.tsx` | 認証必須 (middlewareで保護) |
| `/settings` | `src/app/settings/page.tsx` | 認証必須 |
| `/terms` | `src/app/terms/page.tsx` | SSR (Markdown取得) |
| `/privacy` | `src/app/privacy/page.tsx` | SSR |
| `/about` | `src/app/about/page.tsx` | SSR |
| `/whitepaper` | `src/app/whitepaper/page.tsx` | SSR |
| `/admin/:tab` | `src/app/admin/[tab]/page.tsx` | 認証+権限必須 |

#### 4a: タイムラインページ (`src/app/page.tsx`, `src/app/home/page.tsx`)
- サーバーコンポーネントで初期データを取得し Props として渡す
- クライアントコンポーネントの Timeline に Props を引き継ぐ
- 3カラムレイアウト (LeftNav + Timeline + RightPanel)
- CSP メタタグ設定

#### 4b: スレッドページ (`src/app/thread/[postId]/page.tsx`) - **SEO最重要**
- `generateMetadata()` で動的 OGP 生成
- サーバーサイドで投稿データを取得
- クライアントコンポーネントに Props として渡す
- 現在の main.ts の ThreadPage ロジックを `ThreadPageClient.tsx` に

#### 4c: プロフィールページ (`src/app/users/[username]/page.tsx`) - **SEO重要**
- `generateMetadata()` で動的 OGP 生成
- サーバーサイドでユーザーデータ取得
- 現在の `ProfilePage.ts` を React 化

#### 4d: 認証ページ (`src/app/login/page.tsx`, `src/app/register/page.tsx`)
- `'use client'` のみ
- 現在の `LoginPage.ts`, `RegisterPage.ts` を React 化
- 認証成功時に Next.js ルーターでリダイレクト

#### 4e: 静的ページ (`src/app/terms/page.tsx`, etc.)
- SSR (サーバーコンポーネント)
- 現在の `LegalPage.ts` の Markdown 取得ロジックをサーバーサイドに
- `generateMetadata()` で固定 OGP

#### 4f: その他のページ
- 探索/検索/アーケード/通知/ブックマーク/設定/管理画面
- 各ページの React コンポーネントを作成
- 管理画面は専用レイアウト (`src/app/admin/layout.tsx`)

### [ ] Phase 5: lib/ ユーティリティの React 対応

多くの lib ファイルは純粋関数のためそのまま利用可能。一部は React Hook / Context との統合が必要:

| ファイル | 対応 |
|----------|------|
| `auth-cache.ts` | AuthContext に統合するため不要に |
| `i18n.ts` | I18nContext に統合 |
| `modal-state.ts` | React では state + portal で管理 |
| `toast.ts` | `useToast()` hook または react-hot-toast に置き換え |
| `confirm-dialog.ts` | React Portal + state |
| `post-modal.ts` | React Portal + state |
| `share.ts` | そのまま利用可能 (pure functions) |
| `format.ts` | そのまま利用可能 |
| `performance.ts` | カスタム hook (`usePerformanceMonitoring`) |
| `impression-tracker.ts` | カスタム hook (`useImpressionTracker`) |
| `ad-impression-tracker.ts` | カスタム hook |
| `inject-ads.ts` | そのまま利用可能 |
| `thread.ts` | そのまま利用可能 |
| `settings.ts` | カスタム hook (`useReplyStyle`) |
| `sandbox-bridge.ts` | カスタム hook (`useSandboxBridge`) |
| `bridge.ts` | そのまま (types) |
| `dom-utils.ts` | React では不要なケースが多い |
| `file-extensions.ts` | そのまま利用可能 |
| `og-html.ts` | SSR の `generateMetadata` で代替 |
| `is-crawler.ts` | サーバーサイドの user-agent チェックで代替 |
| `admin.ts` | API 呼び出しで代替 |
| `db.ts` | API サーバーサイドのみ (functions/ 側) |
| `r2.ts` | API サーバーサイドのみ |
| `rate-limit.ts` | API サーバーサイドのみ |
| `wvfs-zip-*.ts` | そのまま利用可能 (ブラウザAPI) |
| `zip-executor.ts` | そのまま利用可能 |
| `zip-manager.ts` | そのまま利用可能 |
| `crowd.d.ts` | 型定義のみ |
| `ad-impression-tracker.ts` | カスタム hook |

### [ ] Phase 6: next.config.ts と環境設定

```typescript
// next.config.ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone', // または 'export' を Cloudflare Pages に合わせる
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.flaxia.app' },
      { protocol: 'https', hostname: 'pub-*.r2.dev' },
    ],
  },
  transpilePackages: ['hono'], // 現在の ssr.noExternal 相当
  experimental: {
    serverActions: {
      // API は CF Pages Functions のまま使うので server actions は不要か
    },
  },
  // Vite の define 相当 → .env.local と public runtime config
};

export default nextConfig;
```

#### 環境変数 (.env.local → Next.js へ)
現在 `vite.config.ts` の `define` で設定されているものを `.env.local` + `next.config` に移行:
- `NEXT_PUBLIC_SANDBOX_ORIGIN`
- `NEXT_PUBLIC_CONTENT_ORIGIN`
- `NEXT_PUBLIC_CLOUDFLARE_ACCOUNT_ID`
- `NEXT_PUBLIC_CF_TEAM_DOMAIN`
- `NEXT_PUBLIC_CF_ACCESS_AUD`
- `NEXT_PUBLIC_CF_ACCESS_LOGIN_URL`

### [ ] Phase 7: package.json スクリプト更新

移行前のスクリプト:
```json
{
  "dev": "npm run migrate:local && vite build && wrangler pages dev dist ...",
  "build": "vite build",
  "dev:local": "vite --host",
  "deploy": "CONTENT_ORIGIN=https://sandbox.flaxia.app wrangler pages deploy dist"
}
```

移行後のスクリプト (両立期間):
```json
{
  "dev": "next dev -p 3000",  // Next.js dev server
  "build": "next build",
  "build:vite": "vite build", // 従来のViteビルドも維持
  "export": "next build && next export",
  "dev:full": "next dev & wrangler pages dev dist --port 8787 ...", // API と共存
  "dev:pages": "...", // 従来の dev スクリプト
  "typecheck": "tsc --noEmit" // そのまま
}
```

### [ ] Phase 8: 移行の検証とクリーンアップ

- [ ] 各ページの SSR が正しく動作することを確認
- [ ] SPA ナビゲーション (Client-side transitions) が正しく動作
- [ ] API 通信 (Cloudflare Functions) が正しく動作
- [ ] Tauri デスクトップアプリが正しく動作
- [ ] Capacitor モバイルアプリが正しく動作
- [ ] OGP が検索エンジンに正しく表示されることの確認
- [ ] Lighthouse/Web Vitals の改善確認
- [ ] 古い Vite 設定ファイルと main.ts の後片付け

---

## 重要な移行パターン

### パターン1: Class Component → React Function Component

```typescript
// Before (Class-based)
export class LeftNav {
  private element: HTMLElement;
  constructor(private props: LeftNavProps) {
    this.element = this.createElement();
    this.setupEventListeners();
  }
  createElement(): HTMLElement { /* ... */ }
  setupEventListeners(): void { /* ... */ }
  destroy(): void { /* ... */ }
  getElement(): HTMLElement { return this.element; }
}
export function createLeftNav(props: LeftNavProps): LeftNav {
  return new LeftNav(props);
}

// After (React)
'use client';
export function LeftNav({ activeItem, unreadCount, currentUser, onNavigate, onSignIn, onSignUp }: LeftNavProps) {
  useEffect(() => {
    // setupEventListeners equivalent
    return () => { /* destroy equivalent */ };
  }, []);
  return <nav className="left-nav">{/* ... */}</nav>;
}
```

### パターン2: Factory Function → React Function Component

```typescript
// Before
export function createPostStage(props: PostStageProps): HTMLElement { /* ... */ }
export function updatePostStage(container: HTMLElement, props: PostStageProps): void { /* ... */ }

// After
export function PostStage({ post, mode, sandboxOrigin, onModeChange }: PostStageProps) {
  // useState for mode, useEffect for DOM manipulation
  return <div className="post-stage">{/* ... */}</div>;
}
```

### パターン3: SPA ルーター → App Router

```typescript
// Before (in main.ts)
window.history.pushState({}, '', `/thread/${postId}`);
navigateTo('thread', postId);

// After (React)
import { useRouter } from 'next/navigation';
const router = useRouter();
router.push(`/thread/${postId}`);
```

### パターン4: Custom Events → React Props/Callbacks

```typescript
// Before
element.dispatchEvent(new CustomEvent('navigateToThread', { detail: { postId } }));
element.addEventListener('navigateToThread', handler);

// After
<PostCard onNavigateToThread={(postId) => router.push(`/thread/${postId}`)} />
```

### パターン5: 動的インポート → Next.js Dynamic/Lazy

```typescript
// Before
const { createThreadPage } = await import('./components/ThreadPage.js');

// After
import dynamic from 'next/dynamic';
const ThreadPageClient = dynamic(() => import('@/components/ThreadPageClient'), { ssr: false });
```

### パターン6: IntersectionObserver → useInView / カスタムフック

```typescript
// Before
const observer = new IntersectionObserver(handler, { rootMargin: '300px' });
observer.observe(sentinel);

// After
import { useInView } from 'react-intersection-observer';
const { ref, inView } = useInView({ rootMargin: '300px' });
useEffect(() => { if (inView) loadMore(); }, [inView]);
```

---

## SSR による SEO 改善戦略

### ページごとの Metadata 生成

```typescript
// src/app/thread/[postId]/page.tsx
export async function generateMetadata({ params }: { params: { postId: string } }): Promise<Metadata> {
  const post = await fetchPost(params.postId); // API call
  return {
    title: `${post.username} on Flaxia: ${post.text.slice(0, 50)}...`,
    description: post.text.slice(0, 160),
    openGraph: {
      title: `Flaxia - ${post.username}'s post`,
      description: post.text.slice(0, 160),
      images: post.gif_key ? [`/api/images/${post.gif_key}`] : ['/og-default-v2.png'],
    },
    twitter: {
      card: 'summary_large_image',
      title: `Flaxia - ${post.username}'s post`,
      description: post.text.slice(0, 160),
    },
  };
}
```

### クローラー向け最適化

現在 `functions/pages/_index.ts` で行っているクローラー検出 + OGP HTML レンダリングは、Next.js SSR では不要になる（全ページが静的な HTML を返すため）。ただし完全移行までは既存の `functions/pages/_index.ts` は残す。

### 注意点

- `'use client'` コンポーネントは SSR されるが hydrate されるだけ。**本当に動的な部分**（タイムラインのリアルタイム更新、ユーザーインタラクション）だけを Client Component に。
- サーバーコンポーネントでは `useEffect`, `useState`, ブラウザAPI (`window`, `document`, `localStorage`) は使えない。
- API クライアントはサーバー/クライアント両方で使えるよう、fetch の base URL を環境変数で切り替え。

---

## ファイルマッピング一覧（Vite → Next.js）

| 現在のパス (Vite) | 移行先パス (Next.js) | 種別 |
|---|---|---|
| `index.html` | `src/app/layout.tsx` (head/body内容) | レイアウト |
| `src/main.ts` | 廃止 (Context + Pages に分散) | ルーター/状態 |
| `src/vite-env.d.ts` | 廃止 | 型定義 |
| `src/components/*.ts` | `src/components/*.tsx` | コンポーネント |
| `src/lib/*.ts` | `src/lib/*.ts` (一部は hooks/) | ユーティリティ |
| `src/lib/i18n.ts` | `src/lib/i18n/` + `src/app/_providers/I18nContext.tsx` | i18n |
| `src/types/*.ts` | `src/types/*.ts` (そのまま) | 型定義 |
| `src/styles/main.css` | `src/app/globals.css` | スタイル |
| `src/index.ts` | `src/index.ts` (そのまま, 露出API) | エントリー |
| `vite.config.ts` | `next.config.ts` (移行後削除) | 設定 |
| `tsconfig.json` | `tsconfig.json` (更新) | TypeScript設定 |

---

## 進捗状況

### Phase 0: プロジェクトセットアップ ✅ 完了
**完了日**: 2026-06-06

| # | タスク | 状態 | ファイル |
|---|-------|------|---------|
| 0.1 | Next.js 14.2.35 + React 18 インストール | ✅ | `package.json` |
| 0.2 | @types/react, @types/react-dom, @types/node インストール | ✅ | `package.json` |
| 0.3 | tsconfig.json 更新 (Next.js plugin, @/ paths) | ✅ | `tsconfig.json` |
| 0.4 | next-env.d.ts 自動生成 | ✅ | `next-env.d.ts` |

### Phase 1: ルートレイアウトとグローバル設定 ✅ 完了
**完了日**: 2026-06-06

| # | タスク | 状態 | ファイル |
|---|-------|------|---------|
| 1.1 | ルートレイアウト (metadata, viewport) | ✅ | `src/app/layout.tsx` |
| 1.2 | グローバルCSS (main.css → globals.css) | ✅ | `src/app/globals.css` |
| 1.3 | FontLoader: フォント + GTM + AdSense | ✅ | `src/components/client/FontLoader.tsx` |
| 1.4 | ローディングページ | ✅ | `src/app/loading.tsx` |
| 1.5 | 404 ページ | ✅ | `src/app/not-found.tsx` |

### Phase 2: プロバイダーとコンテキスト ⏳ 進行中

| # | タスク | 状態 | ファイル |
|---|-------|------|---------|
| 2.1 | AuthContext (getMe, login, logout, refreshUser) | ✅ | `src/app/_providers/AuthContext.tsx` |
| 2.2 | I18nContext (翻訳, locale切替) | ✅ | `src/app/_providers/I18nContext.tsx` |
| 2.3 | Providers ラッパー | ✅ | `src/app/_providers/Providers.tsx` |
| 2.4 | **NotificationContext** (通知ポーリング, WebSocket, Tauri/Capacitor) | ⬜ | `src/app/_providers/NotificationContext.tsx` |

### Phase 3: 共通コンポーネントの React 化 ⏳ 進行中

凡例: ✅=完了, 🔧=作成中, ⬜=未着手

#### 3a: レイアウトコンポーネント
| # | 元ファイル (Vanilla TS) | 移行先 (React TSX) | 状態 |
|---|------------------------|-------------------|------|
| 3.1 | `src/components/LeftNav.ts` | `src/components/client/LeftNav.tsx` | ✅ |
| 3.2 | `src/components/RightPanel.ts` | `src/components/client/RightPanel.tsx` | ✅ |

#### 3b: 基本投稿コンポーネント
| # | 元ファイル (Vanilla TS) | 移行先 (React TSX) | 状態 |
|---|------------------------|-------------------|------|
| 3.3 | `src/components/PostCard.ts` (1970行) | `src/components/client/PostCard.tsx` | ✅ (2142行) |
| 3.4 | `src/components/PostComposer.ts` (1744行) | `src/components/client/PostComposer.tsx` | ⬜ |
| 3.5 | `src/components/PostStage.ts` | `src/components/client/PostStage.tsx` | ⬜ |
| 3.6 | `src/components/PostActions.ts` | (PostCard に内包) | ✅ |
| 3.7 | `src/components/PostHeader.ts` | (PostCard に内包) | ✅ |
| 3.8 | `src/components/PostText.ts` | (PostCard に内包) | ✅ |
| 3.9 | `src/components/SandboxFrame.ts` | `src/components/client/SandboxFrame.tsx` | ⬜ |

#### 3c: インタラクションコンポーネント
| # | 元ファイル (Vanilla TS) | 移行先 (React TSX) | 状態 |
|---|------------------------|-------------------|------|
| 3.10 | `src/components/ReplyComposer.ts` | `src/components/client/ReplyComposer.tsx` | ⬜ |
| 3.11 | `src/components/ReplyNode.ts` | `src/components/client/ReplyNode.tsx` | ⬜ |
| 3.12 | `src/components/ThreadView.ts` | `src/components/client/ThreadView.tsx` | ⬜ |
| 3.13 | `src/components/ShareModal.ts` | (PostCard に内包) | ✅ |
| 3.14 | `src/components/SignInPrompt.ts` | (PostCard に内包) | ✅ |
| 3.15 | `src/components/SkeletonCard.ts` | (Timeline に内包) | ✅ |

#### 3d: メディアプレーヤー
| # | 元ファイル (Vanilla TS) | 移行先 (React TSX) | 状態 |
|---|------------------------|-------------------|------|
| 3.16 | `src/components/AudioPlayer.ts` | `src/components/client/AudioPlayer.tsx` | ⬜ |
| 3.17 | `src/components/AudioVisualizer.ts` | `src/components/client/AudioVisualizer.tsx` | ⬜ |
| 3.18 | `src/components/DosPlayer.ts` | `src/components/client/DosPlayer.tsx` | ⬜ |
| 3.19 | `src/components/FlashPlayer.ts` | `src/components/client/FlashPlayer.tsx` | ⬜ |

#### 3e: 広告/管理
| # | 元ファイル (Vanilla TS) | 移行先 (React TSX) | 状態 |
|---|------------------------|-------------------|------|
| 3.20 | `src/components/AdCard.ts` | `src/components/client/AdCard.tsx` | ⬜ |
| 3.21 | `src/components/AdminLayout.ts` | `src/components/client/AdminLayout.tsx` | ⬜ |
| 3.22 | `src/components/AdminAlertsTab.ts` | `src/components/client/AdminAlertsTab.tsx` | ⬜ |
| 3.23 | `src/components/AdminHiddenTab.ts` | `src/components/client/AdminHiddenTab.tsx` | ⬜ |
| 3.24 | `src/components/AdminUsersTab.ts` | `src/components/client/AdminUsersTab.tsx` | ⬜ |
| 3.25 | `src/components/AdminAdsTab.ts` | `src/components/client/AdminAdsTab.tsx` | ⬜ |
| 3.26 | `src/components/AdminCounterTab.ts` | `src/components/client/AdminCounterTab.tsx` | ⬜ |

#### 3f: モーダル/その他
| # | 元ファイル (Vanilla TS) | 移行先 (React TSX) | 状態 |
|---|------------------------|-------------------|------|
| 3.27 | `src/components/EditProfileModal.ts` | `src/components/client/EditProfileModal.tsx` | ⬜ |
| 3.28 | `src/components/FollowerListModal.ts` | `src/components/client/FollowerListModal.tsx` | ⬜ |
| 3.29 | `src/components/CurrentTopic.ts` | `src/components/client/CurrentTopic.tsx` | ⬜ |
| 3.30 | `src/components/SimilarPosts.ts` | `src/components/client/SimilarPosts.tsx` | ⬜ |
| 3.31 | `src/components/UserPostList.ts` | `src/components/client/UserPostList.tsx` | ⬜ |
| 3.32 | `src/components/SearchResults.ts` | `src/components/client/SearchResults.tsx` | ⬜ |

#### 3g: 認証/ページコンポーネント
| # | 元ファイル (Vanilla TS) | 移行先 (React TSX) | 状態 |
|---|------------------------|-------------------|------|
| 3.33 | `src/components/LoginPage.ts` | `src/components/client/LoginPage.tsx` | ✅ |
| 3.34 | `src/components/RegisterPage.ts` | `src/components/client/RegisterPage.tsx` | ✅ |
| 3.35 | `src/components/LegalPage.ts` | `src/components/LegalContent.tsx` (SSR, Server Component) | ✅ |
| 3.36 | `src/components/ProfilePage.ts` (549行) | `src/components/client/ProfilePage.tsx` | ✅ |
| 3.37 | `src/components/SettingsPage.ts` (755行) | `src/components/client/SettingsPage.tsx` | ✅ |
| 3.38 | `src/components/NotificationsPage.ts` (460行) | `src/components/client/NotificationsPage.tsx` | ✅ |
| 3.39 | `src/components/BookmarksPage.ts` (311行) | `src/components/client/BookmarksPage.tsx` | ✅ |
| 3.40 | `src/components/ExplorePage.ts` (847行) | `src/components/client/ExplorePage.tsx` | ✅ |
| 3.41 | `src/components/SearchPage.ts` (791行) | `src/components/client/SearchPage.tsx` | ✅ |
| 3.42 | `src/components/ArcadePage.ts` (2222行) | `src/components/client/ArcadePage.tsx` | ⬜ |
| 3.43 | `src/components/ThreadPage.ts` (698行) | `src/components/client/ThreadPageClient.tsx` | ✅ |
| 3.44 | `src/components/Timeline.ts` (714行) | `src/components/client/Timeline.tsx` | ✅ |
| 3.45 | `src/components/ImagePreview.ts` | (PostStage に内包) | ⬜ |

**Phase 3 進捗サマリー**: 17/45 完了 (38%) — 残り 28 コンポーネント

### Phase 4: ページコンポーネント移行 ⏳ 進行中

| # | ルート | ファイル | ステータス | 備考 |
|---|-------|---------|-----------|------|
| 4.1 | `/` (home) | `src/app/page.tsx` | ✅ | Timeline component (force-dynamic SSR) |
| 4.2 | `/home` | `src/app/home/page.tsx` | ✅ | redirect → `/` |
| 4.3 | `/login` | `src/app/login/page.tsx` | ✅ | LoginPage Component 呼び出し |
| 4.4 | `/register` | `src/app/register/page.tsx` | ✅ | RegisterPage Component 呼び出し |
| 4.5 | `/explore` | `src/app/explore/page.tsx` | ✅ | ExplorePage (tags, search, trending, infinite scroll) |
| 4.6 | `/search` | `src/app/search/page.tsx` | ✅ | SearchPage (4 filters, autocomplete) |
| 4.7 | `/arcade` | `src/app/arcade/page.tsx` | ⬜ | プレースホルダー |
| 4.8 | `/arcade/[gameId]` | `src/app/arcade/[gameId]/page.tsx` | ⬜ | プレースホルダー |
| 4.9 | `/thread/[postId]` | `src/app/thread/[postId]/page.tsx` | ✅ | SSR + ThreadPageClient (tree/2ch replies) |
| 4.10 | `/users/[username]` | `src/app/users/[username]/page.tsx` | ✅ | SSR + ProfilePage (bio, follow, logout) |
| 4.11 | `/profile/[username]` | `src/app/profile/[username]/page.tsx` | ✅ | redirect → /users/ |
| 4.12 | `/notifications` | `src/app/notifications/page.tsx` | ✅ | NotificationsPage (11 types, mark all read) |
| 4.13 | `/bookmarks` | `src/app/bookmarks/page.tsx` | ✅ | BookmarksPage (infinite scroll, FAB) |
| 4.14 | `/settings` | `src/app/settings/page.tsx` | ✅ | SettingsPage (account, display, lang, email, password) |
| 4.15 | `/terms` | `src/app/terms/page.tsx` | ✅ | SSG (LegalContent + markdown from public/) |
| 4.16 | `/privacy` | `src/app/privacy/page.tsx` | ✅ | SSG (LegalContent + markdown from public/) |
| 4.17 | `/about` | `src/app/about/page.tsx` | ✅ | SSG (LegalContent + markdown from public/) |
| 4.18 | `/whitepaper` | `src/app/whitepaper/page.tsx` | ✅ | SSG (LegalContent + markdown from public/) |
| 4.19 | `/admin/:tab` | `src/app/admin/[tab]/page.tsx` | ⬜ | プレースホルダー |

**進捗**: 16/19 完了 (84%), 3/19 未着手 (16%)

### Phase 5: lib/ ユーティリティの React 対応 ⬜ 未着手

| # | 元ファイル | 移行方法 | 状態 |
|---|----------|---------|------|
| 5.1 | `i18n.ts` | I18nContext に統合済み | ✅ |
| 5.2 | `auth-cache.ts` | AuthContext に統合済み | ✅ |
| 5.3 | `modal-state.ts` | React Portal + state で代替 | ⬜ |
| 5.4 | `toast.ts` | カスタム Hook (useToast) | ⬜ |
| 5.5 | `confirm-dialog.ts` | React Portal + state | ⬜ |
| 5.6 | `post-modal.ts` | React Portal + state | ⬜ |
| 5.7 | `share.ts` | そのまま利用可 (pure functions) | ✅ |
| 5.8 | `format.ts` | そのまま利用可 | ✅ |
| 5.9 | `performance.ts` | useEffect + カスタム Hook | ⬜ |
| 5.10 | `impression-tracker.ts` | useImpressionTracker Hook | ⬜ |
| 5.11 | `ad-impression-tracker.ts` | カスタム Hook | ⬜ |
| 5.12 | `inject-ads.ts` | そのまま利用可 | ✅ |
| 5.13 | `thread.ts` | そのまま利用可 | ✅ |
| 5.14 | `settings.ts` | useReplyStyle Hook | ⬜ |
| 5.15 | `sandbox-bridge.ts` | useSandboxBridge Hook | ⬜ |
| 5.16 | `bridge.ts` | 型定義のみ → そのまま | ✅ |
| 5.17 | `dom-utils.ts` | React では不要 | ✅ |
| 5.18 | `file-extensions.ts` | そのまま利用可 | ✅ |
| 5.19 | `og-html.ts` | SSR generateMetadata で代替 | ⬜ |
| 5.20 | `zip-executor.ts` | そのまま利用可 (ブラウザAPI) | ✅ |
| 5.21 | `zip-manager.ts` | そのまま利用可 | ✅ |
| 5.22 | `wvfs-zip-*.ts` | そのまま利用可 | ✅ |

### Phase 6: next.config と環境設定 ✅ 完了
**完了日**: 2026-06-06

| # | タスク | 状態 |
|---|-------|------|
| 6.1 | next.config.mjs (standalone, images, transpilePackages, webpack extensionAlias) | ✅ |
| 6.2 | .env.local (NEXT_PUBLIC_* 環境変数) | ✅ |
| 6.3 | .env.example 維持 | ✅ |

### Phase 7: package.json スクリプト ✅ 完了
**完了日**: 2026-06-06

| # | スクリプト | 内容 | 状態 |
|---|----------|------|------|
| 7.1 | `dev` | `next dev -p 3000` | ✅ |
| 7.2 | `build` | `next build` | ✅ |
| 7.3 | `dev:api` | Cloudflare Pages dev (API サーバー) | ✅ |
| 7.4 | `dev:full` | Next.js + wrangler 同時起動 | ✅ |
| 7.5 | `build:vite` | 従来の Vite ビルド (互換性維持) | ✅ |
| 7.6 | `dev:vite` | Vite dev server (互換性維持) | ✅ |
| 7.7 | `dev:pages` | 従来の Pages 開発環境 | ✅ |
| 7.8 | `lint / format / typecheck` | 従来通り維持 | ✅ |

### Phase 8: 移行の検証とクリーンアップ ⏳ 進行中

| # | タスク | 状態 | 備考 |
|---|-------|------|------|
| 8.1 | Next.js build 成功 | ✅ | 全20ルート, Timeline component 動的SSR, PostCard の hoisting 問題修正 |
| 8.2 | 各ページ SSR 動作確認 | ⬜ | dev server 起動が必要 |
| 8.3 | SPA ナビゲーション確認 | ⬜ | |
| 8.4 | API 通信確認 | ⬜ | Cloudflare Functions との連携 |
| 8.5 | Tauri 動作確認 | ⬜ | |
| 8.6 | Capacitor 動作確認 | ⬜ | |
| 8.7 | Biome lint 設定 (.tsx 追加) | ⬜ | `biome.jsonc` |
| 8.8 | 古い Vite 設定/resources 整理 | ⬜ | 移行完了後 |

---

## 注意事項・制約

1. **2-origin アーキテクチャ**: `flaxia.app` (メイン) と `sandbox.flaxia.app` (サンドボックス) の分離は維持。iframe の `allow-same-origin` は永久禁止。
2. **CSP**: HTTP ヘッダーで強制。`<meta>` タグでは設定しない。
3. **Cloudflare バインディング**: API レイヤー (functions/) は Cloudflare Pages Functions に依存。D1, R2, KV, Queues, Durable Objects は functions/ 側で引き続き使用。
4. **Tauri**: `@tauri-apps/api` と `@tauri-apps/plugin-notification` はブラウザ非互換。`__TAURI__` / `__TAURI_INTERNALS__` のチェックは `useEffect` 内で行う。
5. **Capacitor**: `@capacitor/*` パッケージはネイティブ専用。`window.Capacitor` のチェックは `useEffect` 内で行う。
6. **Service Worker**: `/sw.js` の登録は layout の `useEffect` で行う。
7. **js-dos**: `node_modules/js-dos/dist` からのファイルコピーは、移行後は Next.js の `public/` ディレクトリに配置。
8. **@flaxia/node**: `node_modules/@flaxia/node/dist/assets` からのファイルコピーも同様に `public/` に。
9. **biome**: フォーマッター/lint は引き続き使用。`.tsx` ファイルも対象に追加。

---

## 参考: 現在の main.ts が行っていること（移行漏れ防止）

`src/main.ts` (2406行) は以下の責務を持つ。各責務の移行先を明記:

1. **ルーティング** (parseCurrentRoute, navigateTo, popstate/spaNavigate) → App Router
2. **認証状態管理** (checkAuth, getMe, currentUser) → AuthContext
3. **通知ポーリング** (fetchNotifications, refreshNotificationBadges) → NotificationContext
4. **プッシュ通知** (WebSocket, Service Worker, Tauri, Capacitor) → NotificationContext
5. **ページローダー** (showPageLoader, hidePageLoader) → React Suspense + loading.tsx
6. **モバイルレイアウト** (openLeftNav, closeLeftNav, setupMobileLeftNav) → Local state + CSS
7. **i18n 初期化** (initI18n) → I18nProvider
8. **パフォーマンス監視** (initPerformanceMonitoring) → Client Component useEffect
9. **crowd node 初期化** (initFlaxiaNode, deferInit) → Client Component useEffect
10. **Tauri/Capacitor 初期化** (initTauriNotifications, etc.) → Client Component useEffect

---

## 開発サーバーの起動方法（移行後）

```bash
# フロントエンドのみ (Next.js dev server)
npm run dev
# → http://localhost:3000

# API サーバー (Cloudflare Pages Functions)
npm run dev:api
# → http://localhost:8787

# 両方同時 (API + Next.js)
npm run dev:full
```

```json
{
  "scripts": {
    "dev": "next dev -p 3000",
    "dev:api": "npm run migrate:local && wrangler pages dev dist --port 8787 --binding BASE_URL=http://localhost:8787 --binding SANDBOX_ORIGIN=http://localhost:3000 --do NOTIFICATION_STREAM=NotificationStream@do-worker",
    "dev:full": "npm run migrate:local && (trap 'kill 0 2>/dev/null' EXIT; next dev -p 3000 & wrangler pages dev dist --port 8787 --binding BASE_URL=http://localhost:8787 --binding SANDBOX_ORIGIN=http://localhost:3000 --do NOTIFICATION_STREAM=NotificationStream@do-worker & wait)",
    "build": "next build",
    "typecheck": "tsc --noEmit"
  }
}
```

---

*作成日: 2026-06-06*  
*最終更新: 2026-06-06*  
*次に作業を継続する AI はこのファイルの「進捗状況」セクションを更新すること*

## 修正ログ

| 日付 | # | 内容 |
|------|---|------|
| 2026-06-06 | - | Next.js build 初回成功 (全17ルート, SSR/SSG混在) |
| 2026-06-06 | 3.44 | Timeline.ts → React Timeline.tsx 変換完了 (714行, infinite scroll, 3-mode feed toggle, FAB, 広告注入) |
| 2026-06-06 | 6.1 | webpack resolve.extensionAlias 追加 (.js → .ts/.tsx) - 既存vanilla TSとの互換性確保 |
| 2026-06-06 | - | PostCard.tsx の hoisting 問題修正 (showSignInPrompt, createShareModal, showToast, submitReport, submitCounterNotice を const → function に変更) |
| 2026-06-06 | 4.1 | `/` ルートを force-dynamic + Timeline コンポーネント実装 (window is not defined 回避) |
| 2026-06-06 | 3.43 | ThreadPage.ts → React ThreadPageClient.tsx 変換完了 (698行, tree/2ch reply styles) |
| 2026-06-06 | 3.36 | ProfilePage.ts → React ProfilePage.tsx 変換完了 (549行, follow/unfollow, logout, FAB) |
| 2026-06-06 | 3.40 | ExplorePage.ts → React ExplorePage.tsx 変換完了 (847行, tag search, trending, infinite scroll) |
| 2026-06-06 | 3.41 | SearchPage.ts → React SearchPage.tsx 変換完了 (791行, 4-filter tabs, autocomplete, arcade) |
| 2026-06-06 | 3.38 | NotificationsPage.ts → React NotificationsPage.tsx 変換完了 (460行, 11 types, mark all read) |
| 2026-06-06 | 3.39 | BookmarksPage.ts → React BookmarksPage.tsx 変換完了 (311行, infinite scroll, postUpdated listener) |
| 2026-06-06 | 3.37 | SettingsPage.ts → React SettingsPage.tsx 変換完了 (755行, account/display/lang/email/password) |
| 2026-06-06 | 4.15-18 | Legal pages (terms/privacy/about/whitepaper) → SSG + LegalContent + public/legal/*.md |

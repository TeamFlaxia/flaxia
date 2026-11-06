// Design-preview data for the Mail UI. Loaded only when the page is opened
// with ?mail_preview=1 (or the flag is already in sessionStorage), so real
// mailboxes never render fabricated messages.
import type { MailFolder, MailThreadDetail, MailThreadSummary } from './api.js';

const PREVIEW_KEY = 'flaxia.mail.preview';

export function isMailPreview(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('mail_preview') === '1') {
      sessionStorage.setItem(PREVIEW_KEY, '1');
      return true;
    }
    return sessionStorage.getItem(PREVIEW_KEY) === '1';
  } catch {
    return false;
  }
}

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const THREADS: MailThreadSummary[] = [
  {
    id: 'preview-welcome',
    folder: 'inbox',
    subject: 'Flaxia Mail へようこそ',
    snippet: 'あなたの @flaxia.app メールボックスの準備ができました。大切な連絡を、ここでひとつに。',
    from_name: 'Flaxia Team',
    from_address: 'team@flaxia.app',
    date: ago(12),
    unread: true,
    starred: true,
    has_attachment: true,
    message_count: 2,
    security: 'e2ee',
  },
  {
    id: 'preview-arcade',
    folder: 'inbox',
    subject: '今週の注目ゲーム: Neon Drift',
    snippet: 'Arcade 編集部が選ぶ今週のピックアップ。ブラウザで遊べる新しいゲームをチェック。',
    from_name: 'Flaxia Arcade',
    from_address: 'arcade@flaxia.app',
    date: ago(96),
    unread: true,
    starred: false,
    has_attachment: false,
    message_count: 1,
    security: 'e2ee',
  },
  {
    id: 'preview-design',
    folder: 'inbox',
    subject: 'Mail UI design review',
    snippet: '新しいメール画面の余白とフォルダタブを確認しました。いくつかコメントを残しています。',
    from_name: 'Saiba',
    from_address: 'saiba@flaxia.app',
    date: ago(320),
    unread: false,
    starred: false,
    has_attachment: true,
    message_count: 3,
    security: 'e2ee',
  },
  {
    id: 'preview-security',
    folder: 'inbox',
    subject: '新しい端末からログインがありました',
    snippet: '見覚えのない端末の場合は、Personal Vault のデバイス一覧からすぐに取り消してください。',
    from_name: 'Flaxia Security',
    from_address: 'security@flaxia.app',
    date: ago(1_580),
    unread: false,
    starred: false,
    has_attachment: false,
    message_count: 1,
    security: 'e2ee',
  },
  {
    id: 'preview-digest',
    folder: 'inbox',
    subject: 'Your weekly Flaxia digest',
    snippet: 'フォロー中のクリエイターの新着投稿と、今週の Fresh をまとめました。',
    from_name: 'Flaxia',
    from_address: 'hello@flaxia.app',
    date: ago(2_880),
    unread: false,
    starred: false,
    has_attachment: false,
    message_count: 1,
    security: 'e2ee',
  },
  {
    id: 'preview-sent-1',
    folder: 'sent',
    subject: 'Re: Mail UI design review',
    snippet: 'ありがとうございます。フォルダタブの件、次版で反映します。',
    from_name: 'You',
    from_address: 'preview@flaxia.app',
    date: ago(280),
    unread: false,
    starred: false,
    has_attachment: false,
    message_count: 1,
    security: 'e2ee',
  },
  {
    id: 'preview-sent-2',
    folder: 'sent',
    subject: 'Arcade の新作について',
    snippet: '来週のピックアップ候補を送ります。フィードバックをお待ちしています。',
    from_name: 'You',
    from_address: 'preview@flaxia.app',
    date: ago(4_320),
    unread: false,
    starred: false,
    has_attachment: false,
    message_count: 1,
    security: 'at_rest',
  },
  {
    id: 'preview-draft',
    folder: 'drafts',
    subject: '週次アップデートの下書き',
    snippet: '今週の変更点: メール UI、Vault セッション、推奨フィードの改善…',
    from_name: 'You',
    from_address: 'preview@flaxia.app',
    date: ago(45),
    unread: false,
    starred: false,
    has_attachment: false,
    message_count: 1,
    security: 'e2ee',
  },
  {
    id: 'preview-archive',
    folder: 'archive',
    subject: 'Welcome to Flaxia (archived)',
    snippet: '以前のウェルカムメールです。',
    from_name: 'Flaxia Team',
    from_address: 'team@flaxia.app',
    date: ago(15_000),
    unread: false,
    starred: false,
    has_attachment: false,
    message_count: 1,
    security: 'e2ee',
  },
  {
    id: 'preview-spam',
    folder: 'spam',
    subject: 'You have won a prize',
    snippet: 'This message was quarantined as spam.',
    from_name: 'Unknown Sender',
    from_address: 'noreply@example.com',
    date: ago(980),
    unread: true,
    starred: false,
    has_attachment: false,
    message_count: 1,
    security: 'tls',
  },
];

const DETAILS: Record<string, MailThreadDetail> = {
  'preview-welcome': {
    id: 'preview-welcome',
    subject: 'Flaxia Mail へようこそ',
    security: 'e2ee',
    labels: ['Flaxia'],
    messages: [
      {
        id: 'preview-welcome-1',
        from_name: 'Flaxia Team',
        from_address: 'team@flaxia.app',
        to: ['preview@flaxia.app'],
        date: ago(12),
        security: 'e2ee',
        body_text:
          'こんにちは。Flaxia Mail へようこそ。\n\n@flaxia.app のアドレスができました。Flaxia のメンバーとのやりとりは、Personal Vault の鍵でエンドツーエンドに暗号化されます。\n\n外部の相手とのメールは TLS で送受信され、サーバーでは暗号化して保存されます。画面上のセキュリティ表示で、どの保護が適用されているか確認できます。',
        body_html:
          '<p>こんにちは。Flaxia Mail へようこそ。</p><p>@flaxia.app のアドレスができました。Flaxia のメンバーとのやりとりは、Personal Vault の鍵で<strong>エンドツーエンド</strong>に暗号化されます。</p><p>外部の相手とのメールは TLS で送受信され、サーバーでは暗号化して保存されます。画面上のセキュリティ表示で、どの保護が適用されているか確認できます。</p><p><a href="https://flaxia.app">Flaxia を開く</a></p>',
        attachments: [
          {
            id: 'preview-welcome-pdf',
            filename: 'Flaxia Mail ガイド.pdf',
            content_type: 'application/pdf',
            size_bytes: 248_000,
          },
        ],
      },
      {
        id: 'preview-welcome-2',
        from_name: 'Saiba',
        from_address: 'saiba@flaxia.app',
        to: ['preview@flaxia.app'],
        date: ago(8),
        security: 'e2ee',
        body_text: 'ようこそ！まずは Settings から Vault を有効にして、メールアドレスを activate してみてください。',
      },
    ],
  },
  'preview-arcade': {
    id: 'preview-arcade',
    subject: '今週の注目ゲーム: Neon Drift',
    security: 'e2ee',
    messages: [
      {
        id: 'preview-arcade-1',
        from_name: 'Flaxia Arcade',
        from_address: 'arcade@flaxia.app',
        to: ['preview@flaxia.app'],
        date: ago(96),
        security: 'e2ee',
        body_text:
          '今週のピックアップは Neon Drift。\n\n短いセッションで遊べるレーシングゲームです。Arcade の「今週の注目」からどうぞ。\n\n感想はリプライで送れます。',
      },
    ],
  },
  'preview-design': {
    id: 'preview-design',
    subject: 'Mail UI design review',
    security: 'e2ee',
    messages: [
      {
        id: 'preview-design-1',
        from_name: 'Saiba',
        from_address: 'saiba@flaxia.app',
        to: ['preview@flaxia.app'],
        date: ago(340),
        security: 'e2ee',
        body_text:
          '新しいメール画面のレビューです。\n\nフォルダタブは横スクロールで、未読数はアクセントカラーに。行の密度は Timeline と同じくらいで問題ないと思います。\n\n添付のスクリーンショットも確認してください。',
        attachments: [
          {
            id: 'preview-design-shot',
            filename: 'mail-list.png',
            content_type: 'image/png',
            size_bytes: 482_000,
          },
        ],
      },
      {
        id: 'preview-design-2',
        from_name: 'You',
        from_address: 'preview@flaxia.app',
        to: ['saiba@flaxia.app'],
        date: ago(300),
        security: 'e2ee',
        body_text: 'ありがとうございます。返信の導線と、空状態のコピーも見てもらえると助かります。',
      },
      {
        id: 'preview-design-3',
        from_name: 'Saiba',
        from_address: 'saiba@flaxia.app',
        to: ['preview@flaxia.app'],
        date: ago(290),
        security: 'e2ee',
        body_text: '確認しました。空状態は「受信箱は静かです」でいいと思います。',
        quoted_text: '> ありがとうございます。返信の導線と、空状態のコピーも見てもらえると助かります。',
      },
    ],
  },
  'preview-security': {
    id: 'preview-security',
    subject: '新しい端末からログインがありました',
    security: 'e2ee',
    messages: [
      {
        id: 'preview-security-1',
        from_name: 'Flaxia Security',
        from_address: 'security@flaxia.app',
        to: ['preview@flaxia.app'],
        date: ago(1_580),
        security: 'e2ee',
        body_text:
          '新しい端末から Flaxia にログインがありました。\n\n心当たりがある場合は、このメールを無視してください。心当たりがない場合は、Settings → Personal Vault のデバイス一覧から該当する端末を取り消してください。',
      },
    ],
  },
  'preview-digest': {
    id: 'preview-digest',
    subject: 'Your weekly Flaxia digest',
    security: 'e2ee',
    messages: [
      {
        id: 'preview-digest-1',
        from_name: 'Flaxia',
        from_address: 'hello@flaxia.app',
        to: ['preview@flaxia.app'],
        date: ago(2_880),
        security: 'e2ee',
        body_text:
          'フォロー中のクリエイターの新着投稿と、今週の Fresh をまとめました。\n\nFlaxia を開いて、続きをチェックしてください。',
      },
    ],
  },
  'preview-sent-1': {
    id: 'preview-sent-1',
    subject: 'Re: Mail UI design review',
    security: 'e2ee',
    messages: [
      {
        id: 'preview-sent-1-m',
        from_name: 'You',
        from_address: 'preview@flaxia.app',
        to: ['saiba@flaxia.app'],
        date: ago(280),
        security: 'e2ee',
        body_text: 'ありがとうございます。フォルダタブの件、次版で反映します。',
      },
    ],
  },
  'preview-sent-2': {
    id: 'preview-sent-2',
    subject: 'Arcade の新作について',
    security: 'at_rest',
    messages: [
      {
        id: 'preview-sent-2-m',
        from_name: 'You',
        from_address: 'preview@flaxia.app',
        to: ['arcade@example.com'],
        date: ago(4_320),
        security: 'at_rest',
        body_text: '来週のピックアップ候補を送ります。フィードバックをお待ちしています。\n\nTLS で送信されました。',
      },
    ],
  },
  'preview-draft': {
    id: 'preview-draft',
    subject: '週次アップデートの下書き',
    security: 'e2ee',
    messages: [
      {
        id: 'preview-draft-m',
        from_name: 'You',
        from_address: 'preview@flaxia.app',
        to: [],
        date: ago(45),
        security: 'e2ee',
        body_text: '今週の変更点:\n- メール UI\n- Vault セッション\n- 推奨フィードの改善',
      },
    ],
  },
  'preview-archive': {
    id: 'preview-archive',
    subject: 'Welcome to Flaxia (archived)',
    security: 'e2ee',
    messages: [
      {
        id: 'preview-archive-m',
        from_name: 'Flaxia Team',
        from_address: 'team@flaxia.app',
        to: ['preview@flaxia.app'],
        date: ago(15_000),
        security: 'e2ee',
        body_text: '以前のウェルカムメールです。',
      },
    ],
  },
  'preview-spam': {
    id: 'preview-spam',
    subject: 'You have won a prize',
    security: 'tls',
    messages: [
      {
        id: 'preview-spam-m',
        from_name: 'Unknown Sender',
        from_address: 'noreply@example.com',
        to: ['preview@flaxia.app'],
        date: ago(980),
        security: 'tls',
        body_text: 'This message was quarantined as spam.',
      },
    ],
  },
};

export function demoThreads(): MailThreadSummary[] {
  return THREADS;
}

export function demoThread(id: string): MailThreadDetail | null {
  return DETAILS[id] ?? null;
}

export function demoCounts(threads: MailThreadSummary[]): Partial<Record<MailFolder, number>> {
  const counts: Partial<Record<MailFolder, number>> = {};
  for (const thread of threads) {
    if (!thread.unread) continue;
    counts[thread.folder] = (counts[thread.folder] ?? 0) + 1;
  }
  return counts;
}

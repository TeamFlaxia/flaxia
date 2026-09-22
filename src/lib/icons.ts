import {
  AlertTriangle,
  BarChart3,
  Bell,
  Bookmark,
  Copy,
  createElement,
  Eye,
  Flag,
  Gamepad2,
  Home,
  type IconNode,
  ImagePlus,
  Key,
  Leaf,
  Maximize,
  MessageCircle,
  Music2,
  Quote,
  Save,
  Search,
  Send,
  Settings,
  Share2,
  Smile,
  SmilePlus,
  StickyNote,
  Upload,
  User,
  X,
} from 'lucide';

export type IconName =
  | 'fresh'
  | 'bookmark'
  | 'reply'
  | 'share'
  | 'quote'
  | 'impressions'
  | 'attach'
  | 'poll'
  | 'emoji'
  | 'save'
  | 'drafts'
  | 'close'
  | 'copy'
  | 'send'
  | 'smile-plus'
  | 'image-video'
  | 'audio'
  | 'game'
  | 'home'
  | 'search'
  | 'key'
  | 'bell'
  | 'user'
  | 'settings'
  | 'explore'
  | 'arcade'
  | 'notifications'
  | 'profile'
  | 'maximize'
  | 'flag'
  | 'warning';

const ICON_NODES: Record<IconName, IconNode> = {
  fresh: Leaf,
  bookmark: Bookmark,
  reply: MessageCircle,
  share: Share2,
  quote: Quote,
  impressions: Eye,
  attach: Upload,
  poll: BarChart3,
  emoji: Smile,
  save: Save,
  drafts: StickyNote,
  close: X,
  copy: Copy,
  send: Send,
  'smile-plus': SmilePlus,
  'image-video': ImagePlus,
  audio: Music2,
  game: Gamepad2,
  home: Home,
  search: Search,
  key: Key,
  bell: Bell,
  user: User,
  settings: Settings,
  explore: Search,
  arcade: Gamepad2,
  notifications: Bell,
  profile: User,
  maximize: Maximize,
  flag: Flag,
  warning: AlertTriangle,
};

export function icon(name: IconName, attrs: Record<string, string> = {}): SVGElement {
  const el = createElement(ICON_NODES[name]);
  el.setAttribute('aria-hidden', 'true');
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

/**
 * Replaces `[data-icon="<name>"]` placeholder elements inside root with the
 * corresponding Lucide SVG. Used for `innerHTML`-based templates.
 */
export function attachIcons(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    if (el.childNodes.length > 0) return;
    const name = (el.getAttribute('data-icon') || '') as IconName;
    if (!(name in ICON_NODES)) return;
    el.appendChild(createElement(ICON_NODES[name]));
  });
}

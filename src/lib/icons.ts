import {
  AlertTriangle,
  BarChart3,
  Bell,
  Bookmark,
  Copy,
  createElement,
  Download,
  Eye,
  FileText,
  Flag,
  Gamepad2,
  Home,
  type IconNode,
  ImagePlus,
  Key,
  Leaf,
  Maximize,
  MessageCircle,
  Monitor,
  Music2,
  Pencil,
  Quote,
  Repeat2,
  Save,
  Search,
  Send,
  Settings,
  Share2,
  Smartphone,
  Smile,
  SmilePlus,
  StickyNote,
  Terminal,
  Upload,
  User,
  X,
} from 'lucide';

export type IconName =
  | 'fresh'
  | 'bookmark'
  | 'reply'
  | 'reload'
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
  | 'document'
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
  | 'warning'
  | 'edit'
  | 'download'
  | 'monitor'
  | 'smartphone'
  | 'terminal';

const ICON_NODES: Record<IconName, IconNode> = {
  fresh: Leaf,
  bookmark: Bookmark,
  reply: MessageCircle,
  reload: Repeat2,
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
  document: FileText,
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
  edit: Pencil,
  download: Download,
  monitor: Monitor,
  smartphone: Smartphone,
  terminal: Terminal,
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

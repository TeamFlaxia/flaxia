// Mail search query parser (docs/mail.md §10 Search).
//
// Syntax: from:, to:, subject:, label:, has:attachment, is:unread,
// before:, after:. Free text is the remaining words. This parser is shared
// by the server-side filter builder and the client-side full-text index.

export interface MailSearchQuery {
  text: string;
  from?: string;
  to?: string;
  subject?: string;
  label?: string;
  hasAttachment?: boolean;
  isUnread?: boolean;
  before?: string;
  after?: string;
}

const OP_PATTERN = /^(from|to|subject|label|has|is|before|after):(\S+)$/i;

export function parseMailSearch(input: string): MailSearchQuery {
  const query: MailSearchQuery = { text: '' };
  const words: string[] = [];
  for (const token of (input ?? '').trim().split(/\s+/).filter(Boolean)) {
    const m = token.match(OP_PATTERN);
    if (!m) {
      words.push(token);
      continue;
    }
    const [, op, value] = m as unknown as [string, string, string];
    switch (op.toLowerCase()) {
      case 'from':
        query.from = value;
        break;
      case 'to':
        query.to = value;
        break;
      case 'subject':
        query.subject = value;
        break;
      case 'label':
        query.label = value;
        break;
      case 'has':
        if (value.toLowerCase() === 'attachment') query.hasAttachment = true;
        break;
      case 'is':
        if (value.toLowerCase() === 'unread') query.isUnread = true;
        break;
      case 'before':
        query.before = value;
        break;
      case 'after':
        query.after = value;
        break;
      default:
        words.push(token);
    }
  }
  query.text = words.join(' ');
  return query;
}

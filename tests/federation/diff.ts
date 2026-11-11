// Comparison of the documents of two ActivityPub implementations.
//
// The documents of two instances never look the same: the ids, the hosts and
// the collections differ. What has to be the same is the *shape* of the
// document: the properties a peer reads to decide how it federates with the
// instance. The comparison therefore reduces a document to the properties
// that matter and reports the differences.

export interface FieldDiff {
  field: string;
  ours: unknown;
  theirs: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The properties of an actor document a peer reads. */
export function actorShape(document: Record<string, unknown>): Record<string, unknown> {
  const publicKey = isObject(document.publicKey) ? document.publicKey : null;
  const endpoints = isObject(document.endpoints) ? document.endpoints : null;
  return {
    type: document.type,
    hasId: typeof document.id === 'string',
    hasPreferredUsername: typeof document.preferredUsername === 'string',
    hasInbox: typeof document.inbox === 'string',
    hasOutbox: typeof document.outbox === 'string',
    hasFollowers: typeof document.followers === 'string',
    hasFollowing: typeof document.following === 'string',
    hasLiked: typeof document.liked === 'string',
    hasFeatured: typeof document.featured === 'string',
    hasSharedInbox: typeof endpoints?.sharedInbox === 'string',
    hasPublicKey: publicKey !== null,
    publicKeyHasId: typeof publicKey?.id === 'string',
    publicKeyHasPem: typeof publicKey?.publicKeyPem === 'string',
    publicKeyOwnerMatches: publicKey?.owner === document.id,
    contextIsArray: Array.isArray(document['@context']),
    declaresDiscoverable: document.discoverable !== undefined,
    declaresManualApproval: document.manuallyApprovesFollowers !== undefined,
  };
}

/** The properties of a WebFinger document a peer reads. */
export function webfingerShape(document: Record<string, unknown>): Record<string, unknown> {
  const links = Array.isArray(document.links) ? document.links : [];
  const self = links.find((link) => isObject(link) && link.rel === 'self');
  return {
    hasSubject: typeof document.subject === 'string',
    subjectMatchesHandle: typeof document.subject === 'string' && /^acct:[^@]+@.+$/.test(document.subject),
    linkCount: links.length,
    hasSelfLink: Boolean(self),
    selfLinkType: isObject(self) ? self.type : null,
    selfLinkIsActivityJson: isObject(self) && self.type === 'application/activity+json',
  };
}

const PUBLIC_COLLECTION = 'https://www.w3.org/ns/activitystreams#Public';

/** The audience of an object: the addresses may be a single value or a list. */
function audienceOf(document: Record<string, unknown>): string[] {
  const values = [document.to, document.cc].flatMap((value) =>
    Array.isArray(value) ? value : typeof value === 'string' ? [value] : [],
  );
  return values.filter((value): value is string => typeof value === 'string');
}

/**
 * The properties of a Note a peer reads.
 *
 * The implementations differ in the way they express the audience: some
 * address the public collection in `to`, others in `cc`. The comparison
 * therefore looks at both fields together.
 */
export function noteShape(document: Record<string, unknown>): Record<string, unknown> {
  const audience = audienceOf(document);
  const tag = Array.isArray(document.tag) ? document.tag : [];
  return {
    type: document.type,
    hasId: typeof document.id === 'string',
    hasAttributedTo: typeof document.attributedTo === 'string',
    hasContent: typeof document.content === 'string',
    hasPublished: typeof document.published === 'string',
    hasUrl: typeof document.url === 'string',
    addressedToPublic: audience.includes(PUBLIC_COLLECTION),
    addressesFollowers: audience.some((entry) => entry.includes('/followers')),
    hasMentions: tag.some((entry) => isObject(entry) && entry.type === 'Mention'),
    hasHashtags: tag.some((entry) => isObject(entry) && entry.type === 'Hashtag'),
  };
}

/**
 * The differences between two shapes.
 *
 * A property that is missing on one side is reported with `undefined`, so the
 * report shows what the other side publishes and the other side does not.
 */
export function diffShapes(
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  options: { ignore?: string[] } = {},
): FieldDiff[] {
  const ignored = new Set(options.ignore ?? []);
  const fields = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  const differences: FieldDiff[] = [];
  for (const field of fields) {
    if (ignored.has(field)) continue;
    const ourValue = ours[field];
    const theirValue = theirs[field];
    if (ourValue !== theirValue) {
      differences.push({ field, ours: ourValue, theirs: theirValue });
    }
  }
  return differences;
}

/** A readable report of the differences. */
export function formatDifferences(differences: FieldDiff[]): string {
  return differences
    .map((difference) => `${difference.field}: ours=${String(difference.ours)} peer=${String(difference.theirs)}`)
    .join('\n');
}

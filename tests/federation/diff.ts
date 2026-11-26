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

const PUBLIC_COLLECTION = 'https://www.w3.org/ns/activitystreams#Public';

/** The audience of an object: the addresses may be a single value or a list. */
function audienceOf(document: Record<string, unknown>): string[] {
  const values = [document.to, document.cc].flatMap((value) =>
    Array.isArray(value) ? value : typeof value === 'string' ? [value] : [],
  );
  return values.filter((value): value is string => typeof value === 'string');
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

/**
 * The properties of an activity a peer reads.
 *
 * An `Undo` wraps the activity it retracts. Implementations differ in the
 * exact representation of that inner object (a URL, an embedded activity,
 * different audiences), so only the type and the target of the retracted
 * activity are compared.
 */
export function activityShape(document: Record<string, unknown>): Record<string, unknown> {
  const object = isObject(document.object) ? document.object : null;
  const audience = audienceOf(document);
  return {
    type: document.type,
    hasId: typeof document.id === 'string',
    hasActor: typeof document.actor === 'string',
    hasObject: document.object !== undefined,
    objectIsString: typeof document.object === 'string',
    objectType: typeof document.object === 'string' ? null : (object?.type ?? null),
    hasTo: document.to !== undefined,
    hasCc: document.cc !== undefined,
    addressedToPublic: audience.includes(PUBLIC_COLLECTION),
    // `@context` may legally be a string or an array in JSON-LD. Implementations
    // differ here, so this is deliberately not part of the compared shape.
    undoneType: document.type === 'Undo' ? (object?.type ?? null) : null,
    undoneObjectIsString: document.type === 'Undo' && typeof object?.object === 'string',
  };
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
 * True when a difference at `path` was explicitly excluded.
 *
 * A plain name (`hasLiked`) ignores that field. A dotted name
 * (`Undo.object`) ignores the `object` subtree when the compared shape is an
 * Undo on either side; the exact path is ignored as well, which is useful for
 * nested documents that are compared without reducing them to a shape first.
 */
function ignoredPath(
  path: string,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  ignored: Set<string>,
): boolean {
  for (const pattern of ignored) {
    if (path === pattern || path.startsWith(`${pattern}.`)) return true;
    if (!pattern.includes('.')) continue;
    const [parent, ...rest] = pattern.split('.');
    const leaf = rest.join('.');
    if (ours.type !== parent && theirs.type !== parent) continue;
    if (path === leaf || path.startsWith(`${leaf}.`)) return true;
  }
  return false;
}

function collectDifferences(
  path: string,
  ours: unknown,
  theirs: unknown,
  ignored: Set<string>,
  roots: { ours: Record<string, unknown>; theirs: Record<string, unknown> },
  differences: FieldDiff[],
): void {
  if (ignoredPath(path, roots.ours, roots.theirs, ignored)) return;
  if (isObject(ours) && isObject(theirs)) {
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      collectDifferences(path ? `${path}.${key}` : key, ours[key], theirs[key], ignored, roots, differences);
    }
    return;
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    for (let index = 0; index < Math.max(ours.length, theirs.length); index++) {
      collectDifferences(`${path}.${index}`, ours[index], theirs[index], ignored, roots, differences);
    }
    return;
  }
  if (ours !== theirs) differences.push({ field: path, ours, theirs });
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
  const differences: FieldDiff[] = [];
  const fields = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  for (const field of fields) {
    collectDifferences(field, ours[field], theirs[field], ignored, { ours, theirs }, differences);
  }
  return differences;
}

/** A readable report of the differences. */
export function formatDifferences(differences: FieldDiff[]): string {
  return differences
    .map((difference) => `${difference.field}: ours=${String(difference.ours)} peer=${String(difference.theirs)}`)
    .join('\n');
}

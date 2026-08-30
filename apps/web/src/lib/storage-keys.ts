/**
 * Construction and validation of object-storage keys.
 *
 * Object keys are the tenant boundary for bucket storage: the leading segments
 * decide whose data a signed URL can reach. Caller-controlled values must
 * therefore never contribute *path structure* to a key — a caller may only
 * influence a single, charset-restricted trailing segment. A signed URL grants
 * access to the path its key resolves to, so a key has to be in resolved form
 * before it is signed for the prefix it names to mean anything.
 *
 * Every key handed to `lib/storage` is assembled here so that rule has exactly
 * one home. `storage-keys.guard.test.ts` fails the build if a call site starts
 * assembling its own.
 */

/** Object-key areas that caller-initiated uploads may write to. */
export const TENANT_KEY_PREFIXES = ['artifacts', 'attachments'] as const;

/** Longest trailing name segment we will keep from a caller-supplied name. */
export const MAX_OBJECT_FILENAME_LENGTH = 200;

/** S3/R2 object keys are capped at 1024 bytes. */
export const MAX_OBJECT_KEY_LENGTH = 1024;

const DEFAULT_OBJECT_FILENAME = 'file';

/** A single key segment: no separators, no relative navigation, no leading dot. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Reduce a caller-supplied name to a single safe key segment.
 *
 * Takes the trailing component only, restricts the charset, and drops leading
 * dots so the result can never be read as navigation or as a dotfile. Callers
 * that want to show the user their original name must keep it separately (e.g.
 * in artifact metadata) — this value is for the object key alone.
 */
export function safeObjectFilename(
  input: unknown,
  fallback: string = DEFAULT_OBJECT_FILENAME,
): string {
  if (typeof input !== 'string') return fallback;

  // Both separators: names reach us from agents on either platform.
  const trailing = input.split(/[/\\]/).pop() ?? '';

  const reduced = trailing
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, MAX_OBJECT_FILENAME_LENGTH);

  return reduced.length > 0 ? reduced : fallback;
}

/**
 * Assert that a structural segment (workspace id, upload id, role slug, hash)
 * is a single safe segment. Structural segments are never sanitised — a value
 * that does not already qualify is a programming error or an attack, and both
 * should fail loudly rather than silently land in a neighbouring prefix.
 */
export function assertSafeKeySegment(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value) || value.includes('..')) {
    throw new Error(`Invalid storage key segment: ${label}`);
  }
  return value;
}

/**
 * Assert that a fully assembled key is already normalised: relative, single
 * separator, no navigation segments, every segment charset-clean. Applied on
 * the write path so the prefix a key names is the prefix it resolves to.
 */
export function assertNormalizedObjectKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_OBJECT_KEY_LENGTH) {
    throw new Error('Invalid storage key');
  }
  if (key.includes('\\') || key.startsWith('/')) {
    throw new Error('Invalid storage key');
  }

  const segments = key.split('/');
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment) || segment.includes('..')) {
      throw new Error('Invalid storage key');
    }
  }

  return key;
}

function buildTenantKey(
  prefix: (typeof TENANT_KEY_PREFIXES)[number],
  workspaceId: unknown,
  uploadId: unknown,
  filename: unknown,
): string {
  const ws = assertSafeKeySegment(workspaceId, 'workspaceId');
  const upload = assertSafeKeySegment(uploadId, 'uploadId');
  return assertNormalizedObjectKey(`${prefix}/${ws}/${upload}/${safeObjectFilename(filename)}`);
}

/** `artifacts/<workspaceId>/<uploadId>/<name>` */
export function buildArtifactKey(
  workspaceId: unknown,
  uploadId: unknown,
  filename: unknown,
): string {
  return buildTenantKey('artifacts', workspaceId, uploadId, filename);
}

/** `attachments/<workspaceId>/<uploadId>/<name>` */
export function buildAttachmentKey(
  workspaceId: unknown,
  uploadId: unknown,
  filename: unknown,
): string {
  return buildTenantKey('attachments', workspaceId, uploadId, filename);
}

/**
 * `roles/<slug>/<configHash>.json`
 *
 * Runners fetch and load these bundles, so the slug must be a validated
 * segment rather than a sanitised one — a slug that would need rewriting is
 * rejected instead.
 */
export function buildRoleConfigKey(slug: unknown, configHash: unknown): string {
  const safeSlug = assertSafeKeySegment(slug, 'roleSlug');
  const safeHash = assertSafeKeySegment(configHash, 'configHash');
  return assertNormalizedObjectKey(`roles/${safeSlug}/${safeHash}.json`);
}

/**
 * Whether a key supplied by a caller names an object that `workspaceId` owns.
 *
 * Routes that accept a key from the request body must gate on this: a stored
 * key is later turned into a signed download URL, so an unchecked key is a read
 * of whatever it names. Only the caller-writable tenant prefixes qualify —
 * server-managed areas (role bundles and the like) are never addressable this
 * way.
 */
export function isOwnedStorageKey(
  key: unknown,
  workspaceId: string | null | undefined,
): boolean {
  if (typeof key !== 'string' || !workspaceId) return false;

  try {
    assertNormalizedObjectKey(key);
  } catch {
    return false;
  }

  const segments = key.split('/');
  if (segments.length < 3) return false;

  const [prefix, keyWorkspaceId] = segments;
  if (!(TENANT_KEY_PREFIXES as readonly string[]).includes(prefix)) return false;

  return keyWorkspaceId === workspaceId;
}

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

/**
 * Object-key areas that caller-initiated uploads may write to. `qa` holds
 * visual-audit screenshots (`buildAuditScreenshotKey`); it is a tenant area
 * like the others, so `isOwnedStorageKey` still checks its workspace segment.
 */
export const TENANT_KEY_PREFIXES = ['artifacts', 'attachments', 'qa'] as const;

/** Leading segment of every visual-audit screenshot key. */
export const AUDIT_SCREENSHOT_KEY_PREFIX = 'qa';

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

/**
 * Is `key` exactly the artifact key `buildArtifactKey` mints for this
 * workspace and upload id (one trailing name segment, nothing deeper)?
 */
export function isArtifactKeyForUpload(key: unknown, workspaceId: unknown, uploadId: unknown): boolean {
  if (typeof key !== 'string' || typeof workspaceId !== 'string' || typeof uploadId !== 'string') return false;
  const parts = key.split('/');
  return parts.length === 4
    && parts[0] === 'artifacts'
    && parts[1] === workspaceId
    && parts[2] === uploadId
    && SAFE_SEGMENT.test(parts[3]);
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
 * `qa/<workspaceId>/<uploadId>/<name>` — a visual-audit screenshot
 * (docs/design/visual-qa-auditor.md, "Decay").
 *
 * The `qa` segment leads the key so one bucket-wide R2 lifecycle rule can
 * expire every audit shot by prefix; `artifacts/<ws>/qa/...` could not be
 * matched across workspaces. It is also the marker the share refusal and the
 * prominence rule read: artifact PATCH can rewrite `metadata` wholesale but
 * never touches `storageKey`, so the key survives a metadata edit.
 */
export function buildAuditScreenshotKey(
  workspaceId: unknown,
  uploadId: unknown,
  filename: unknown,
): string {
  return buildTenantKey(AUDIT_SCREENSHOT_KEY_PREFIX, workspaceId, uploadId, filename);
}

/** True for a well-formed key in the visual-audit area. Pure; safe on the client. */
export function isAuditStorageKey(key: unknown): boolean {
  if (typeof key !== 'string' || !key.startsWith(`${AUDIT_SCREENSHOT_KEY_PREFIX}/`)) return false;
  try {
    assertNormalizedObjectKey(key);
  } catch {
    return false;
  }
  return true;
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
 * `sessions/<teamId>/<workspaceId>/<workerId>/<filename>`
 *
 * Session diagnostics keys (transcripts, session logs) are derived entirely
 * server-side from the authenticated worker row and are never accepted from a
 * client, so — like role bundle keys — every segment is validated rather than
 * sanitised: a value that doesn't already qualify as a safe segment is a
 * programming error or tampering, and either should fail loudly rather than
 * silently land in a neighbouring prefix.
 */
export function buildSessionArtifactKey(
  teamId: unknown,
  workspaceId: unknown,
  workerId: unknown,
  filename: unknown,
): string {
  const team = assertSafeKeySegment(teamId, 'teamId');
  const ws = assertSafeKeySegment(workspaceId, 'workspaceId');
  const worker = assertSafeKeySegment(workerId, 'workerId');
  const safeFilename = assertSafeKeySegment(filename, 'filename');
  return assertNormalizedObjectKey(`sessions/${team}/${ws}/${worker}/${safeFilename}`);
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

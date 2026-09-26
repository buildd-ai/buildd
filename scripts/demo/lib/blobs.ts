/**
 * Artifact bytes for the demo stack. A story artifact with `_file` (a path
 * relative to the story JSON) gets a real object behind the dashboard's
 * download route, which is what makes the visual auditor's screenshots render
 * on the mission page.
 *
 * The app is pointed at a local "S3" (serve.sh sets STORAGE_ENDPOINT): the
 * download route signs a path-style GET, `<endpoint>/<bucket>/<key>?X-Amz-…`,
 * and redirects the browser there. blob-server.ts answers those GETs from a
 * directory that seed.ts fills. It serves reads only and ignores the
 * signature: loopback-only, synthetic files, nothing to protect.
 *
 * The storage key is derived exactly the way upload-url mints it: an audit
 * screenshot lands under `qa/<workspace>/<artifact id>/<name>`, anything else
 * under `artifacts/…`, and the row id IS the key's upload id.
 */
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { assertNormalizedObjectKey, buildArtifactKey, buildAuditScreenshotKey } from '../../../apps/web/src/lib/storage-keys';
import type { Entity, IdMap, Story } from './story';

export type Blob = { key: string; file: string; contentType: string };

/** The object key for a `_file` artifact, or null when it carries no file. */
export function artifactStorageKey(a: Entity, ids: IdMap): string | null {
  if (!a._file) return null;
  const id = ids.get(a.key!);
  const ws = ids.ref(a.workspaceId);
  const name = (a.metadata?.filename as string | undefined) ?? String(a._file).split('/').pop();
  return a.type === 'screenshot' ? buildAuditScreenshotKey(ws, id, name) : buildArtifactKey(ws, id, name);
}

/** Every object the story's artifacts need, with the local file that holds its bytes. */
export function storyBlobs(story: Story, storyPath: string, ids: IdMap): Blob[] {
  const dir = dirname(resolve(storyPath));
  const out: Blob[] = [];
  for (const a of story.artifacts ?? []) {
    const key = artifactStorageKey(a, ids);
    if (!key) continue;
    const file = resolve(dir, String(a._file));
    if (!existsSync(file)) throw new Error(`[demo] artifact ${a.key}: _file not found: ${file}`);
    out.push({ key, file, contentType: (a.metadata?.mimeType as string | undefined) ?? 'application/octet-stream' });
  }
  return out;
}

/** Copy the objects into `<root>/<key>`, where blob-server.ts reads them. */
export function writeBlobs(blobs: Blob[], root: string): number {
  for (const b of blobs) {
    const dest = join(root, assertNormalizedObjectKey(b.key));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(b.file, dest);
  }
  return blobs.length;
}

/**
 * The file a request path names, or null. Path-style only: the first segment
 * must be the bucket, the rest a normalised object key, so `..`, encoded
 * separators or another bucket never resolve outside `root`.
 */
export function blobFileFor(root: string, bucket: string, pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const prefix = `/${bucket}/`;
  if (!path.startsWith(prefix)) return null;
  const key = path.slice(prefix.length);
  try {
    assertNormalizedObjectKey(key);
  } catch {
    return null;
  }
  const file = resolve(root, key);
  return file.startsWith(resolve(root) + sep) ? file : null;
}

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', webm: 'video/webm' };
export function contentTypeOf(file: string): string {
  return TYPES[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

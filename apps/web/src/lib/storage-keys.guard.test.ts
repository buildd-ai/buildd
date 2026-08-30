/**
 * Structural guard for object-storage keys.
 *
 * Object keys carry tenant isolation: the leading segments decide whose data a
 * signed URL can reach. This test does not check any single route — it checks
 * that the *only* place keys are assembled stays `lib/storage-keys.ts`, and
 * that the upload entry points stay reachable only from reviewed call sites.
 * A new route that assembles its own key, or that signs an upload directly,
 * fails here even if it never touches the files this change fixed.
 */
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

const SCAN_ROOTS = ['apps/web/src', 'packages/core', 'packages/shared'];

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'drizzle', '.turbo']);

/** The single module allowed to assemble object keys. */
const KEY_BUILDER_MODULE = 'apps/web/src/lib/storage-keys.ts';

/** Call sites reviewed for tenant scoping + a signed size ceiling. */
const UPLOAD_CALLER_ALLOWLIST = new Set([
  'apps/web/src/lib/storage.ts',
  'apps/web/src/lib/role-config.ts',
  'apps/web/src/app/api/artifacts/upload-url/route.ts',
  'apps/web/src/app/api/attachments/upload/route.ts',
]);

/** Routes that accept a storage key from the request body. */
const CALLER_SUPPLIED_KEY_ROUTES = [
  'apps/web/src/app/api/workers/[id]/artifacts/route.ts',
  'apps/web/src/app/api/tasks/route.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = SCAN_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root))).map((abs) => ({
  path: relative(REPO_ROOT, abs).split(sep).join('/'),
  text: readFileSync(abs, 'utf-8'),
}));

describe('object storage key construction', () => {
  it('has source files to scan', () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
  });

  it('assembles object keys only in the shared key module', () => {
    // A template literal that opens with a known object-key prefix is a key
    // being built by hand. Keys must come from lib/storage-keys.ts so the
    // segment rules apply everywhere.
    const pattern = /`(artifacts|attachments|roles|sessions)\//;
    const offenders = sourceFiles
      .filter((f) => f.path !== KEY_BUILDER_MODULE && pattern.test(f.text))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it('keeps upload entry points reachable only from reviewed call sites', () => {
    const pattern = /\b(generateSizedUploadUrl|uploadBuffer)\b/;
    const offenders = sourceFiles
      .filter((f) => !UPLOAD_CALLER_ALLOWLIST.has(f.path) && pattern.test(f.text))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it('exposes no upload signer that leaves the body size unbounded', () => {
    // A presigned PUT with no size bound in the signature authorises a body of
    // any length. The only signer is the one that takes a declared size.
    const offenders = sourceFiles
      .filter((f) => /\bgenerateUploadUrl\b/.test(f.text))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it('keeps the ownership check on routes that accept a key from the caller', () => {
    const missing = CALLER_SUPPLIED_KEY_ROUTES.filter((route) => {
      const file = sourceFiles.find((f) => f.path === route);
      // If the route moved, the guard must be updated rather than silently pass.
      if (!file) return true;
      return !/\bisOwnedStorageKey\b/.test(file.text);
    });

    expect(missing).toEqual([]);
  });
});

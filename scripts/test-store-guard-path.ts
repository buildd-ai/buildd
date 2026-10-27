/**
 * Whether a path is the operator's real runner home or inside it, for the
 * store guard (`test-store-guard.ts`). Pure, and separate from the guard
 * because importing the guard patches `fs`.
 *
 * Compares with the platform's own separator and, on Windows, without case:
 * `resolve` returns backslashes there, and the file system ignores case, so a
 * `${home}/` prefix check never matched and the guard refused nothing.
 */
import path from 'path';

type PathImpl = Pick<typeof path, 'resolve' | 'sep'>;

export function isUnderHome(target: string, home: string, impl: PathImpl = path): boolean {
  const fold = impl.sep === '\\' ? (s: string) => s.toLowerCase() : (s: string) => s;
  const abs = fold(impl.resolve(target));
  const root = fold(impl.resolve(home));
  return abs === root || abs.startsWith(root.endsWith(impl.sep) ? root : root + impl.sep);
}

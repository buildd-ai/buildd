import type { PathDeclaration } from '@buildd/shared';

/**
 * The manifest a reviewer should hold a PR to.
 *
 * `pathManifest` is the effective scope and shrinks when stale claims are
 * narrowed (check_path_claim release, PR-scope reconciliation). Narrowing is
 * about who may edit what now; it must not quietly lower the bar for "every
 * declared deliverable is in the diff". So conformance reads the original
 * declaration plus anything declared since: narrowed paths are still expected,
 * runtime declarations are still in scope.
 */
export function conformanceManifest(task: {
  pathManifest?: unknown;
  pathDeclaration?: unknown;
} | null | undefined): string[] | null {
  const current = Array.isArray(task?.pathManifest) ? (task!.pathManifest as unknown[]) : null;
  const declared = (task?.pathDeclaration as PathDeclaration | null | undefined)?.declared;
  const declaredList = Array.isArray(declared) ? declared : null;
  if (!current && !declaredList) return null;
  const out: string[] = [];
  for (const p of [...(declaredList ?? []), ...(current ?? [])]) {
    if (typeof p === 'string' && !out.includes(p)) out.push(p);
  }
  return out;
}

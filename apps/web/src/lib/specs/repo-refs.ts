/**
 * Repo-spec references on a Living Spec revision (D-1: repo docs/specs stay
 * Git-canonical). A revision cites a repo file as `{ path, commitSha }`: the
 * exact commit, never a branch, so what it cites cannot move. Pure parsing
 * here; the GitHub reads are ./repo-source.ts.
 */

export interface RepoRef { path: string; commitSha: string }

export const MAX_REPO_REFS = 20;
const MAX_PATH_CHARS = 500;
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * A repo-relative file path, normalized, or null when it is not one: no
 * absolute path, no `..` or empty segment, no backslash or control character.
 */
export function normalizeRepoPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  while (p.startsWith('./')) p = p.slice(2);
  if (!p || p.length > MAX_PATH_CHARS || p.startsWith('/') || p.endsWith('/')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(p)) return null;
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return p;
}

/** A full 40-hex commit SHA, lowercased; an abbreviated SHA or a branch name is null. */
export function normalizeCommitSha(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return FULL_SHA.test(s) ? s : null;
}

export type ParsedRepoRefs = { ok: true; refs: RepoRef[] } | { ok: false; error: string };

/** Validate the shape of `repoRefs` (nothing is fetched). Duplicates collapse. */
export function parseRepoRefs(input: unknown): ParsedRepoRefs {
  if (!Array.isArray(input)) return { ok: false, error: 'repoRefs must be an array of { path, commitSha }' };
  if (input.length > MAX_REPO_REFS) return { ok: false, error: `repoRefs holds at most ${MAX_REPO_REFS} references` };
  const refs: RepoRef[] = [];
  for (const [i, item] of input.entries()) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const path = normalizeRepoPath(o.path);
    if (!path) return { ok: false, error: `repoRefs[${i}].path must be a repo-relative file path (no leading /, no ..)` };
    const commitSha = normalizeCommitSha(o.commitSha);
    if (!commitSha) return { ok: false, error: `repoRefs[${i}].commitSha must be a full 40-character commit SHA, not a branch or a short SHA` };
    if (!refs.some((r) => r.path === path && r.commitSha === commitSha)) refs.push({ path, commitSha });
  }
  return { ok: true, refs };
}

const key = (r: RepoRef) => `${r.commitSha}:${r.path}`;

/** The same set of references, in any order. */
export function sameRepoRefs(a: readonly RepoRef[] | null | undefined, b: readonly RepoRef[] | null | undefined): boolean {
  const x = new Set((a ?? []).map(key));
  const y = new Set((b ?? []).map(key));
  return x.size === y.size && [...x].every((k) => y.has(k));
}

/** The references in `next` that `prev` does not already carry (already validated there). */
export function newRepoRefs(next: readonly RepoRef[], prev: readonly RepoRef[] | null | undefined): RepoRef[] {
  const seen = new Set((prev ?? []).map(key));
  return next.filter((r) => !seen.has(key(r)));
}

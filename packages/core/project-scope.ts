/**
 * Canonical project scope keys for `memories.project`.
 *
 * The same logical project used to be stored four different ways — full HTTPS
 * git URL, the same URL with a `.git` suffix, `owner/repo`, and a bare repo
 * name — which broke per-project scoping: a workspace whose `repo` is a full
 * URL matched none of the rows that stored the short form.
 *
 * The canonical form is lowercase `owner/repo`:
 *
 *   https://github.com/owner/repo      -> owner/repo
 *   https://github.com/owner/repo.git  -> owner/repo
 *   git@github.com:owner/repo.git      -> owner/repo
 *   Owner/Repo                         -> owner/repo
 *
 * Values that are not repo-shaped are deliberately left alone (modulo
 * whitespace trimming). A bare repo name, or a sentinel scope label, carries no
 * owner, and inventing one would silently merge memories into a repo the author
 * may never have meant:
 *
 *   __sentinel -> __sentinel
 *   repo       -> repo          (NOT some-owner/repo)
 *
 * `normalizeProject` is idempotent: `f(f(x)) === f(x)` for every input. The SQL
 * data migration `0132_normalize_memories_project.sql` implements the same rules
 * in Postgres; keep the two in sync.
 *
 * That migration additionally repairs bare names by joining against `workspaces`
 * (a bare name becomes `owner/repo` when — and only when — exactly one workspace
 * in the SAME team has that repo basename). That is a one-off data repair against
 * facts in the database, deliberately NOT part of this helper: normalizeProject
 * stays pure, synchronous and team-agnostic.
 */

/** Scheme-prefixed remote: `https://host/…`, `ssh://git@host/…`, `git://host/…`. */
const SCHEME_HOST = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/(?:[^@/]+@)?[^/]+\//;
/** scp-style remote: `git@github.com:owner/repo`. */
const SCP_HOST = /^[^@/\s]+@[^:/\s]+:/;
/**
 * Schemeless host: `github.com/owner/repo`. Only a segment containing a dot,
 * and only when two more segments follow it — GitHub owners and repos may not
 * contain dots in the owner position, so `example.com/repo` (one segment left)
 * stays ambiguous and is left alone.
 */
const BARE_HOST = /^[^/]+\.[^/]+\/(?=[^/]+\/)/;

/**
 * Normalizes a project/repo string to the canonical scope key.
 *
 * Returns lowercase `owner/repo` for anything repo-shaped, the trimmed input
 * for anything else, and `null` for null/undefined/blank input.
 */
export function normalizeProject(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;

  let s = input.trim();
  if (s === '') return null;

  // Trailing slashes, then a `.git` suffix, then any slashes it was hiding.
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (s === '') return null;

  // Strip the host only when one is unambiguously present. A bare `owner/repo`
  // must survive: treating `owner/` as a host would collapse it to `repo`.
  // Scheme first — collapsing slashes before this would break `https://`.
  s = s.replace(SCHEME_HOST, '').replace(SCP_HOST, '');
  s = s.replace(/\/{2,}/g, '/').replace(/^\/+/, '');
  s = s.replace(BARE_HOST, '');
  if (s === '') return null;

  const parts = s.split('/').filter((p) => p.length > 0);
  if (parts.length >= 2) {
    // First two segments, not the last two: a URL path deeper than the repo
    // (`owner/repo/tree/main`) still scopes to `owner/repo`.
    return `${parts[0]}/${parts[1]}`.toLowerCase();
  }

  // Not repo-shaped — no owner to derive. Preserve as-is (case included).
  return s;
}

/**
 * Canonical scope key for a workspace, for comparing against
 * `memories.project`. Prefers the repo (the value memories are actually keyed
 * on) and falls back to the workspace name when there is no repo yet.
 */
export function workspaceProjectKey(
  repo: string | null | undefined,
  name?: string | null | undefined,
): string | null {
  return normalizeProject(repo) ?? normalizeProject(name);
}

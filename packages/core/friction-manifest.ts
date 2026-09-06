/**
 * Manifest inference for friction tasks.
 *
 * When an agent files a friction task it typically doesn't know which source
 * files the fix will touch.  This module infers a pathManifest from two
 * sources, tried in order:
 *
 *   1. Extract repo-relative paths from the error excerpt (high-signal when
 *      the error itself names a file, e.g. ENOENT on a specific path).
 *   2. Fall back to a static component table keyed by the error-pattern slug
 *      (covers patterns whose errors never mention a file, e.g. bwrap).
 *
 * The returned paths are fed unchanged into the existing auto-dependsOn
 * machinery in POST /api/tasks — no friction-specific handling downstream.
 */

// Match absolute paths or repo-relative paths starting with apps/ or packages/.
const PATH_RE = /(?:\/[\w./-]+\.\w+|(?:apps|packages)\/[\w./-]+\.\w+)/g;

// Known repo-root markers used to normalize absolute paths.
const REPO_ROOT_MARKERS = ['/apps/', '/packages/'] as const;

function normalizePath(p: string): string {
  for (const marker of REPO_ROOT_MARKERS) {
    const idx = p.indexOf(marker);
    if (idx !== -1) {
      return p.slice(idx + 1); // "apps/..." or "packages/..."
    }
  }
  return p;
}

/**
 * Component table: maps error-pattern slugs (from error-trace-scanner.ts) to
 * the source files most likely to contain the fix.  Patterns whose errors
 * always include a file path in the excerpt can leave this empty — path
 * extraction in step 1 handles them.
 */
const PATTERN_COMPONENT_MAP: Record<string, string[]> = {
  bwrap_namespace_denied: [
    'apps/runner/src/env-scan.ts',
    'apps/runner/src/workers.ts',
  ],
  sandbox_mount_gap: [
    'apps/runner/src/bwrap-mount-allowlist.ts',
    'apps/runner/src/workers.ts',
  ],
  oom_killed: ['apps/runner/src/workers.ts'],
  git_fatal: ['apps/runner/src/git-operations.ts'],
  git_error: ['apps/runner/src/git-operations.ts'],
  enoent: [],            // path usually in excerpt
  permission_denied: [],
  cd_no_such_file: [],   // path in excerpt
  no_such_file: [],      // path in excerpt
  command_not_found: [],
  rate_limit: [],
  connection_refused: [],
  timeout: [],
};

/**
 * Step 1 on its own: paths the error excerpt actually names.
 *
 * Split out from `inferFrictionManifest` because callers that RECORD where a
 * search key came from need to distinguish "the error named this file" from
 * "a static table guessed which component owns this slug". Those are different
 * evidence, and the obvious question about them — does a named path retrieve
 * better than a guessed one — is unanswerable if both wear one label.
 */
export function extractExcerptPaths(excerpt: string): string[] {
  const rawMatches = typeof excerpt === 'string' ? excerpt.match(PATH_RE) : null;
  if (!rawMatches || rawMatches.length === 0) return [];
  return [...new Set(rawMatches.map(normalizePath))];
}

/** Step 2 on its own: the static per-slug component guess. */
export function componentTablePaths(pattern: string): string[] {
  return PATTERN_COMPONENT_MAP[pattern] ?? [];
}

/**
 * Infer a pathManifest for a friction task.
 *
 * @param pattern - The error-pattern slug (e.g. `bwrap_namespace_denied`).
 * @param excerpt - The raw error excerpt (first matching line from the trace).
 * @returns An array of repo-relative file paths, or [] if nothing can be inferred.
 */
export function inferFrictionManifest(pattern: string, excerpt: string): string[] {
  const fromExcerpt = extractExcerptPaths(excerpt);
  if (fromExcerpt.length > 0) return fromExcerpt;
  return componentTablePaths(pattern);
}

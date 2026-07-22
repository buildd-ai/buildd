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
 * Infer a pathManifest for a friction task.
 *
 * @param pattern - The error-pattern slug (e.g. `bwrap_namespace_denied`).
 * @param excerpt - The raw error excerpt (first matching line from the trace).
 * @returns An array of repo-relative file paths, or [] if nothing can be inferred.
 */
export function inferFrictionManifest(pattern: string, excerpt: string): string[] {
  // Step 1: extract paths from the excerpt text.
  const rawMatches = excerpt.match(PATH_RE);
  if (rawMatches && rawMatches.length > 0) {
    const normalized = [...new Set(rawMatches.map(normalizePath))];
    return normalized;
  }

  // Step 2: fall back to the static component table.
  return PATTERN_COMPONENT_MAP[pattern] ?? [];
}

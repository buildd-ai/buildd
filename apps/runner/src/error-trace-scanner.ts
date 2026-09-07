/**
 * Pattern matcher for agent tool output. The runner intercepts tool_result
 * messages from the Agent SDK and runs each one through this scanner; any
 * matches get buffered on the worker and flushed to the buildd server on the
 * next sync via appendErrorTraces.
 *
 * Why this exists: the 2026-05-25 incident had the agent printing
 * `cd: No such file or directory` 8 times before stuck-detector killed the
 * session. Buildd never surfaced the actual error — we only saw the
 * heartbeat timeout. With this scanner, the first occurrence becomes a
 * trace row visible in the UI.
 *
 * Throttle: same (workerId, pattern) max 1 trace per WINDOW_MS to prevent
 * a flailing agent from flooding the API.
 *
 * PRECISION IS THE HARD PART, not recall. Measured over a month of real
 * transcripts on the production runner: the patterns below fired on 1,843
 * tool results, of which only 319 were actual errors — roughly five in six
 * firings were on SUCCESSFUL output. Three causes, all now addressed here:
 *
 *   1. Read/Grep/Glob results are file *contents*, not execution output. An
 *      agent reading this very file matched `permission_denied` and
 *      `connection_refused`, because the pattern table below literally
 *      contains the strings `Permission denied` and `ECONNREFUSED`. Those
 *      tools are skipped outright — see READ_ONLY_TOOLS.
 *   2. Broad patterns caught prose and code. `rate_limit` matched 941 lines
 *      and not one was a real 429 — they were grepped TypeScript unions and
 *      comments. `git_error` (`^error: `) matched 1,105 lines, mostly bun test
 *      assertions (`error: expect(received).toBe(expected)`). Those patterns
 *      now carry `requiresError`, so they only fire when the SDK marked the
 *      result `is_error`. A follow-up audit found the same problem in
 *      `no_such_file`, `command_not_found`, and `git_fatal` — stock POSIX/git
 *      wording that shows up verbatim in this repo's own mocked-error test
 *      fixtures and fallback shell messaging (`which x || echo "not found"`),
 *      so they now carry `requiresError` too.
 *   3. Narrow, unambiguous patterns still scan unconditionally, because
 *      `is_error` is only a lower bound on failure — a Bash command can print
 *      a real error and still exit 0. `cd_no_such_file`, `oom_killed`,
 *      `bwrap_namespace_denied`, and `sandbox_mount_gap` stay ungated: each
 *      requires a compound, format-locked signal (a specific shell prefix, or
 *      an error token plus a specific non-allowlisted path) rather than a
 *      generic English phrase, so the false-positive rate is low enough to
 *      keep paying for the mid-chain-failure recall.
 *
 * Recall matters too, and the header incident above is the proof: the agent's
 * shell is zsh, which writes `(eval):cd:1: no such file or directory: apps/web`.
 * The original `cd_no_such_file` regex is anchored on bash's `cd: ` wording and
 * has therefore never once fired in production. The incident this file was
 * written for stayed invisible for months.
 */

export interface ErrorTrace {
  pattern: string;   // slug, e.g. 'cd_no_such_file'
  excerpt: string;   // truncated raw line, max 500 chars
  source?: string;   // tool that produced the output, e.g. 'bash'
}

interface PatternDef {
  slug: string;
  re: RegExp;
  /**
   * Only fire when the SDK marked this tool result `is_error`.
   *
   * For patterns broad enough to match ordinary prose, code, or test output.
   * The cost is real — a broad pattern will now miss a genuine failure that
   * exited 0 — and it is worth paying, because a slug that fires five times
   * out of six on success is not evidence of anything, and downstream this
   * feeds task subject anchors and retrieval recipe selection.
   */
  requiresError?: boolean;
  // First-match behavior on multi-line output: scan each line individually
  // so a long Bash result with a single error mid-stream is still caught.
}

/**
 * Tools whose result is file content rather than execution output.
 *
 * Never scanned. Every pattern here would otherwise match source code and
 * documentation that merely *discusses* an error, including this file.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Grep', 'Glob', 'NotebookRead', 'WebFetch', 'WebSearch',
]);

// Initial pattern list — narrow, high-signal failures we've actually seen.
// Add new patterns as they show up in production traces. Avoid catching
// warnings, deprecation notices, or normal exit-code-0 stderr.
const PATTERNS: PatternDef[] = [
  { slug: 'cd_no_such_file', re: /^cd: .+: No such file or directory/ },
  // zsh, which is what the agent's shell actually is. Emits
  // `(eval):cd:1: no such file or directory: apps/web` — lowercase, prefixed,
  // and not line-terminal, so none of the patterns below could reach it.
  { slug: 'cd_no_such_file', re: /^\(eval\):cd:\d+: no such file or directory/i },
  // Generic "No such file or directory" — but only when NOT preceded by `cd:`,
  // since cd_no_such_file already catches that more specific case. "No such
  // file or directory" is stock Node/POSIX error wording that shows up
  // verbatim in test fixtures and error-message assertions, hence requiresError.
  { slug: 'no_such_file', re: /^(?!cd: ).*No such file or directory$/, requiresError: true },
  { slug: 'permission_denied', re: /Permission denied/, requiresError: true },
  // "command not found" / "not found" are common phrasing in setup scripts and
  // fallback messaging (`which x || echo "x not found"`) that exits 0.
  { slug: 'command_not_found', re: /command not found$/, requiresError: true },
  // dash and sh word it differently: `sh: 1: tsx: not found`.
  { slug: 'command_not_found', re: /^(?:sh|dash): \d+: .+: not found$/, requiresError: true },
  { slug: 'enoent', re: /\bENOENT\b/, requiresError: true },
  { slug: 'oom_killed', re: /^Killed(:\s*9)?$/ },
  // "fatal: " is git's idiom, but appears verbatim in mocked git-error fixtures
  // and custom fail() messages across the test suite — not exclusively real failures.
  { slug: 'git_fatal', re: /^fatal: /, requiresError: true },
  // git's non-fatal errors — and also every bun test assertion failure and
  // every `error: script "x" exited with code 1`, hence requiresError.
  { slug: 'git_error', re: /^error: /, requiresError: true },
  { slug: 'rate_limit', re: /\b(rate.?limit(ed)?|429 Too Many Requests)\b/i, requiresError: true },
  { slug: 'connection_refused', re: /\bECONNREFUSED\b/, requiresError: true },
  { slug: 'timeout', re: /\bETIMEDOUT\b/, requiresError: true },
  // bwrap sandbox fails in kernels with unprivileged_userns_clone=0 — all Bash commands fail
  { slug: 'bwrap_namespace_denied', re: /bwrap: No permissions to create a new namespace/ },
  // sandbox_mount_gap: ENOENT/EACCES on paths outside the bwrap mount allowlist.
  // Conservative: only matches well-known non-allowlisted prefixes (home config files,
  // /snap/, /opt/) to avoid false-positives on in-repo code errors that also produce ENOENT.
  // False-positive on real code ENOENT is worse than a miss — keep these narrow.
  { slug: 'sandbox_mount_gap', re: /\bENOENT\b.*\.npmrc\b/ },
  { slug: 'sandbox_mount_gap', re: /\bENOENT\b.*\.gitconfig\b/ },
  { slug: 'sandbox_mount_gap', re: /(?:\bENOENT\b|\bEACCES\b).*\/snap\// },
  { slug: 'sandbox_mount_gap', re: /(?:\bENOENT\b|\bEACCES\b).*\/opt\// },
];

const WINDOW_MS = 60_000;
const throttleMap: Map<string, Map<string, number>> = new Map();

/**
 * Scan a tool result string. Returns the first match per pattern that hasn't
 * been emitted for this worker within the throttle window.
 *
 * @param source  the tool that produced this result, e.g. 'Bash'. Read-only
 *                tools are skipped entirely — see READ_ONLY_TOOLS.
 * @param opts.isError  whether the SDK marked this result as an error. Gates
 *                the `requiresError` patterns. Omitted means "unclassified",
 *                which is treated as not-an-error for those patterns, so a
 *                caller that forgets it loses the broad slugs rather than
 *                silently reinstating the false positives.
 */
export function scanToolResult(
  workerId: string,
  content: string,
  source?: string,
  opts?: { isError?: boolean },
): ErrorTrace[] {
  if (!content || typeof content !== 'string') return [];
  if (source && READ_ONLY_TOOLS.has(source)) return [];
  const isError = opts?.isError === true;

  const matches: ErrorTrace[] = [];
  const lines = content.split('\n');
  const seenThisCall = new Set<string>();
  const now = Date.now();
  let workerThrottle = throttleMap.get(workerId);

  for (const line of lines) {
    if (!line || seenThisCall.size === PATTERNS.length) break;
    for (const p of PATTERNS) {
      if (seenThisCall.has(p.slug)) continue;
      // Broad patterns only fire on a result the SDK marked an error. Checked
      // before the regex so an ungated pattern cannot claim the slug for this
      // call via seenThisCall below.
      if (p.requiresError && !isError) continue;
      if (!p.re.test(line)) continue;
      seenThisCall.add(p.slug);

      // Throttle: skip if same pattern emitted recently for this worker
      if (workerThrottle) {
        const last = workerThrottle.get(p.slug);
        if (last && now - last < WINDOW_MS) continue;
      } else {
        workerThrottle = new Map();
        throttleMap.set(workerId, workerThrottle);
      }
      workerThrottle.set(p.slug, now);

      matches.push({
        pattern: p.slug,
        excerpt: line.slice(0, 500),
        source,
      });
    }
  }

  return matches;
}

/** Drop throttle state for a finished worker so the Map doesn't leak. */
export function clearWorkerThrottle(workerId: string): void {
  throttleMap.delete(workerId);
}

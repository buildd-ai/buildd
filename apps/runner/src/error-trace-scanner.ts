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
 *      a real error and still exit 0. `cd_no_such_file`, `oom_killed`, and
 *      `bwrap_namespace_denied` stay ungated: each requires a compound,
 *      format-locked signal (a specific shell prefix) rather than a generic
 *      English phrase, so the false-positive rate is low enough to keep
 *      paying for the mid-chain-failure recall. `sandbox_mount_gap` looked
 *      like it belonged in this group too — an error token plus a specific
 *      non-allowlisted path — but a month of production traces showed it
 *      firing on file CONTENT (a test title, a grepped source line, a fixture
 *      string) that merely mentions the same words, because the old regexes
 *      matched "ENOENT ... somewhere ... .npmrc ... somewhere" instead of an
 *      actual path. It now carries both `requiresError` and a `validate` hook
 *      that requires the matched text to contain a path in one of the two
 *      shapes a real bwrap/Node fs denial produces — see the pattern's own
 *      comment below.
 *
 * Recall matters too, and the header incident above is the proof: the agent's
 * shell is zsh, which writes `(eval):cd:1: no such file or directory: apps/web`.
 * The original `cd_no_such_file` regex is anchored on bash's `cd: ` wording and
 * has therefore never once fired in production. The incident this file was
 * written for stayed invisible for months.
 */

import {
  BASH_FAILURE_PATTERN,
  BASH_RECOVERED_PATTERN,
  formatBashTraceExcerpt,
  parseExitCode,
  stripExitCodeLine,
  verifyFamilyOf,
  type VerifyFamily,
} from '@buildd/core/bash-failure-trace';

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

  /**
   * Extra structural check run only after `re` already matched. For patterns
   * whose regex alone can't tell a real signal from prose that merely
   * mentions the same words (see sandbox_mount_gap below).
   */
  validate?: (line: string) => boolean;
}

/**
 * A real bwrap/Node fs denial reports the offending path in one of two
 * syntactically constrained shapes:
 *   ENOENT: no such file or directory, open '/path'   (Node fs, quoted)
 *   ENOENT: /path: No such file or directory           (POSIX-style, bare)
 * A test title, a grep match, or a fixture string that merely CONTAINS the
 * words ENOENT and .npmrc does not have a path in either shape — e.g.
 * `it('detects ENOENT on .npmrc ...', () => {` has no quoted or bare token
 * that is itself a path, so extraction fails rather than needing a denylist
 * of known-prose shapes.
 */
function extractMountGapPath(line: string): string | null {
  const quoted = /(?:ENOENT|EACCES)\b.*?(['"])([^'"\s]+)\1/.exec(line);
  if (quoted) return quoted[2];
  const bare = /(?:ENOENT|EACCES):\s*([^\s'"]+):\s*(?:No such file or directory|[Pp]ermission denied)/.exec(line);
  if (bare) return bare[1];
  return null;
}

/**
 * Reject anything that isn't a plausible absolute filesystem path (no
 * whitespace, quotes, or JS syntax a source line would carry), then require
 * it to fall under one of the known non-allowlisted prefixes — same
 * conservative set as before, minus the directories that ARE mounted.
 */
function isMountGapCandidate(candidate: string): boolean {
  if (/[\s'"`]/.test(candidate) || candidate.includes('=>')) return false;
  if (!/^[/~]/.test(candidate)) return false;
  // Allowlisted / already-mounted — a hit here is not a gap.
  if (/\/\.bun\//.test(candidate) || /\/\.npm\//.test(candidate) || /^\/usr\//.test(candidate)) return false;
  return /\.npmrc$/.test(candidate) || /\.gitconfig$/.test(candidate)
    || /^\/snap\//.test(candidate) || /^\/opt\//.test(candidate);
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
  //
  // This used to be four loose `.*` regexes ("contains ENOENT somewhere, then
  // .npmrc somewhere later") and fired on file CONTENT rather than execution
  // output: a test case title (`it('detects ENOENT on .npmrc ...', () => {`),
  // a grep match on this file's own pattern table, a fixture string inside a
  // test array. `validate` (see extractMountGapPath/isMountGapCandidate above)
  // requires the matched text to have a path in one of the two shapes a real
  // denial actually produces, which rejects prose that merely mentions the
  // same words. `requiresError` closes the rest: a successful Read/Grep/cat of
  // a file that legitimately contains this text (the scanner's own tests, the
  // taxonomy fixtures) is not marked `is_error`, whether or not its content
  // happens to be shaped like a real path — a fixture string can be
  // byte-for-byte identical to a genuine denial, so that gate — plus
  // READ_ONLY_TOOLS for the Read/Grep/Glob case — is load-bearing, not just
  // belt-and-suspenders.
  {
    slug: 'sandbox_mount_gap',
    re: /\b(?:ENOENT|EACCES)\b/,
    requiresError: true,
    validate: (line) => {
      const path = extractMountGapPath(line);
      return path !== null && isMountGapCandidate(path);
    },
  },
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
      if (p.validate && !p.validate(line)) continue;
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

/** Bash non-zero-exit traces one worker may file over its whole session. */
export const BASH_FAILURE_CAP_PER_WORKER = 25;

interface BashFailureState {
  filed: number;
  seen: Set<string>;
  failedFamilies: Set<VerifyFamily>;
}
const bashFailureState: Map<string, BashFailureState> = new Map();

/**
 * Record what a Bash call hit, whatever it was. `scanToolResult` only matches
 * known patterns, so a failing `bun test`, a red `tsc` or a non-zero `gh` call
 * left nothing. This files one trace per distinct failure: the redacted command,
 * its exit code and a short tail of the output.
 *
 * Bounded three ways: only results the SDK marked `is_error` with an exit code
 * are considered; a repeat of the same command/exit/last-line is dropped; and a
 * worker files at most BASH_FAILURE_CAP_PER_WORKER. An exit 1 with no output
 * (`grep` finding nothing, `git diff --quiet`) says nothing and is skipped.
 *
 * A passing verify command (test / typecheck / lint) after an earlier failure of
 * the same family files a `bash_verify_recovered` marker, so the server can tell
 * "the last test run failed" from "it failed once, then passed".
 */
export function scanBashResult(
  workerId: string,
  input: { command: string | undefined; content: string; isError: boolean },
  redact: (text: string) => string = (t) => t,
): ErrorTrace[] {
  const { command, content, isError } = input;
  if (typeof command !== 'string' || command.trim() === '' || typeof content !== 'string') return [];

  let state = bashFailureState.get(workerId);
  if (!state) {
    state = { filed: 0, seen: new Set(), failedFamilies: new Set() };
    bashFailureState.set(workerId, state);
  }
  const family = verifyFamilyOf(command);

  if (!isError) {
    if (family && state.failedFamilies.delete(family)) {
      return [{
        pattern: BASH_RECOVERED_PATTERN,
        excerpt: redact(formatBashTraceExcerpt({ command, exitCode: 0, output: '' })),
        source: 'Bash',
      }];
    }
    return [];
  }

  const exitCode = parseExitCode(content);
  if (exitCode === null) return [];
  const output = stripExitCodeLine(content);
  if (family) state.failedFamilies.add(family);
  if (output.trim() === '' && exitCode === 1) return [];

  const lastLine = output.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';
  const key = `${command.trim().slice(0, 200)}\u0000${exitCode}\u0000${lastLine.slice(0, 120)}`;
  if (state.seen.has(key)) return [];
  if (state.filed >= BASH_FAILURE_CAP_PER_WORKER) return [];
  state.seen.add(key);
  state.filed++;

  return [{
    pattern: BASH_FAILURE_PATTERN,
    excerpt: redact(formatBashTraceExcerpt({ command, exitCode, output })),
    source: 'Bash',
  }];
}

/** Drop throttle state for a finished worker so the Map doesn't leak. */
export function clearWorkerThrottle(workerId: string): void {
  throttleMap.delete(workerId);
  bashFailureState.delete(workerId);
}

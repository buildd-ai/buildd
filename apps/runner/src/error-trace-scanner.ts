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
 */

export interface ErrorTrace {
  pattern: string;   // slug, e.g. 'cd_no_such_file'
  excerpt: string;   // truncated raw line, max 500 chars
  source?: string;   // tool that produced the output, e.g. 'bash'
}

interface PatternDef {
  slug: string;
  re: RegExp;
  // First-match behavior on multi-line output: scan each line individually
  // so a long Bash result with a single error mid-stream is still caught.
}

// Initial pattern list — narrow, high-signal failures we've actually seen.
// Add new patterns as they show up in production traces. Avoid catching
// warnings, deprecation notices, or normal exit-code-0 stderr.
const PATTERNS: PatternDef[] = [
  { slug: 'cd_no_such_file', re: /^cd: .+: No such file or directory/ },
  // Generic "No such file or directory" — but only when NOT preceded by `cd:`,
  // since cd_no_such_file already catches that more specific case.
  { slug: 'no_such_file', re: /^(?!cd: ).*No such file or directory$/ },
  { slug: 'permission_denied', re: /Permission denied/ },
  { slug: 'command_not_found', re: /command not found$/ },
  { slug: 'enoent', re: /\bENOENT\b/ },
  { slug: 'oom_killed', re: /^Killed(:\s*9)?$/ },
  { slug: 'git_fatal', re: /^fatal: / },
  { slug: 'git_error', re: /^error: / },  // git's non-fatal errors
  { slug: 'rate_limit', re: /\b(rate.?limit(ed)?|429 Too Many Requests)\b/i },
  { slug: 'connection_refused', re: /\bECONNREFUSED\b/ },
  { slug: 'timeout', re: /\bETIMEDOUT\b/ },
];

const WINDOW_MS = 60_000;
const throttleMap: Map<string, Map<string, number>> = new Map();

/**
 * Scan a tool result string. Returns the first match per pattern that hasn't
 * been emitted for this worker within the throttle window.
 */
export function scanToolResult(
  workerId: string,
  content: string,
  source?: string,
): ErrorTrace[] {
  if (!content || typeof content !== 'string') return [];

  const matches: ErrorTrace[] = [];
  const lines = content.split('\n');
  const seenThisCall = new Set<string>();
  const now = Date.now();
  let workerThrottle = throttleMap.get(workerId);

  for (const line of lines) {
    if (!line || seenThisCall.size === PATTERNS.length) break;
    for (const p of PATTERNS) {
      if (seenThisCall.has(p.slug)) continue;
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

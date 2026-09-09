/**
 * Turn a GitHub Actions job log into the few lines a retry agent actually needs.
 *
 * Before this, a CI-retry task carried job and step names only — `Job "build"
 * failed: Step "Run tests" failed` — and pointed the agent at
 * `gh run view <id> --log-failed` to learn more. That command returns empty
 * output and exit 0, so a cold-start retry knew a step had failed and had no
 * working way to find out which test. It re-derived the failure from scratch,
 * or guessed.
 *
 * Pure and log-shaped on purpose: no network, no GitHub types. The caller does
 * the fetching, this decides what is worth carrying.
 */

/**
 * Hard cap on the carried digest. This lands in a task description that an
 * agent reads on start; a 900-failure run must not push the actual instructions
 * out of the prompt.
 */
export const DIGEST_MAX_CHARS = 2000;

/** Actions prefixes every log line with an ISO timestamp. Never useful here. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;

/**
 * Bare process-exit annotations. They restate the exit code the caller already
 * knows and crowd out the annotation that names the cause.
 */
const USELESS_ANNOTATION = /Process completed with exit code/;

/** Lines that carry a real diagnosis when no test digest is present. */
const DIAGNOSTIC = [
  /^##\[error\]/,
  /^::error/,
  /\berror TS\d+:/,
  /^ERROR:/,
];

function clean(log: string): string[] {
  return log.split('\n').map(l => l.replace(TIMESTAMP, '').trimEnd());
}

function cap(text: string): string {
  if (text.length <= DIGEST_MAX_CHARS) return text;
  // Truncate visibly. A silently clipped list reads as a complete one, which is
  // how "two tests failed" becomes a wrong root cause.
  const keep = DIGEST_MAX_CHARS - 40;
  return `${text.slice(0, keep).trimEnd()}\n… truncated — pull the full log`;
}

/**
 * The runner's own failure digest, emitted by scripts/run-unit-tests.ts between
 * `N of M unit test files failed:` and `Full output:`. It already names the file
 * and each failing test, so it is strictly better than anything reconstructed
 * from surrounding output.
 */
function unitTestDigest(lines: string[]): string | null {
  const start = lines.findIndex(l => /\d+ of \d+ unit test files? failed:/.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start);
  const end = rest.findIndex(l => l.startsWith('Full output:'));
  // No (pass) filter: the runner emits per-test results BEFORE this marker, so
  // the sliced range never contains them. A filter here would be dead code.
  const block = (end === -1 ? rest : rest.slice(0, end)).join('\n').trimEnd();
  return block || null;
}

/** Fallback: the annotation and compiler lines, deduped, order preserved. */
function diagnosticLines(lines: string[]): string | null {
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const line of lines) {
    const l = line.trim();
    if (!l || USELESS_ANNOTATION.test(l)) continue;
    if (!DIAGNOSTIC.some(re => re.test(l))) continue;
    if (seen.has(l)) continue;
    seen.add(l);
    hits.push(l);
  }
  return hits.length > 0 ? hits.join('\n') : null;
}

/**
 * The digest, or null when the log holds nothing diagnostic — null means "say
 * nothing", not "say something empty", so the caller keeps its own summary
 * rather than shipping a blank "What failed" block.
 */
export function extractFailureDigest(log: string): string | null {
  if (!log?.trim()) return null;
  const lines = clean(log);
  const digest = unitTestDigest(lines) ?? diagnosticLines(lines);
  return digest ? cap(digest) : null;
}

/**
 * The no-prod-data rules that need no secret, for a generated repo copy before
 * approval (docs/specs/living-specs.md §18, R-34). The patterns are
 * `scripts/check_no_prod_data.py`'s, character for character;
 * `no-prod-data-scan.test.ts` reads them out of the Python file and fails when
 * the two drift. The identifier half (personal handles, private repo names)
 * reads a repo secret only CI holds, so it is not here.
 *
 * `code: true` scans as CI scans an added source line (the UUID rule only);
 * otherwise as prose (PR title, body, commit message: UUIDs and counts).
 */

export const TENANCY = String.raw`teams?|tenants?|customers?|orgs?|organi[sz]ations?|seats?|subscribers?|accounts?|api keys?|paying`;
export const VOLUME = String.raw`rows?|records?|entries|entities|memories|keys?|users?|workspaces?|workers?|chunks?|tasks?|missions?|sessions?`;
export const BIG = String.raw`\d{1,3}(?:,\d{3})+|\d{4,}|\d{2,}(?:\.\d+)?\s*[kKmMbB]\b`;
export const UNITS = String.raw`kb|mb|gb|tb|kib|mib|gib|bytes?|bits?|ms|milliseconds?|s|seconds?|minutes?|hours?|days?|px|rem|em|%|stars?|forks?|tokens?|iterations?|items?|lines?|chars?|characters?|commits?|files?|prs?|issues?|requests?/s|rps|qps|usd|eur|gbp`;
export const PROD_CONTEXT = String.raw`\bprod(?:uction)?\b|\blive\b|\bcurrently\b|\btotal\b|\bwe (?:have|had)\b|\bacross all\b`;

const NOUNS = `${TENANCY}|${VOLUME}`;
const COUNT_BIG = new RegExp(String.raw`(?<![\w.#-])(?!0\d)(${BIG})(?:\s*/\s*[\d,]+)?\s+(?!(?:${UNITS})\b)(?:[a-z-]+\s+){0,2}?(${NOUNS})\b`, 'i');
const COUNT_TENANCY = new RegExp(String.raw`(?<![\w./#-])(?!0\d)(\d+)(?:\s*/\s*[\d,]+)?\s+(?!(?:${UNITS})\b)(?:[a-z-]+\s+){0,2}?(${TENANCY})\b`, 'i');
const COUNT_SMALL_IN_CONTEXT = new RegExp(String.raw`(?<![\w./#-])(?!0\d)(\d{2,3})\s+(?!(?:${UNITS})\b)(?:[a-z-]+\s+){0,2}?(${NOUNS})\b`, 'i');
export const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const PROD_CONTEXT_RE = new RegExp(PROD_CONTEXT, 'i');

/** PROD_CONTEXT, except that `live` inside a backtick span is an identifier, not a claim about production. */
function hasProdContext(line: string): boolean {
  return PROD_CONTEXT_RE.test(line.replace(/`[^`\n]*`/g, (span) => span.replace(/\blive\b/gi, ' ')));
}

/** Findings, each "line N: <category>" (never the value, which the public log would republish). */
export function scanForProdData(text: string, opts: { code: boolean }): string[] {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (UUID_RE.test(line)) out.push(`line ${i + 1}: a UUID (row identifiers must not enter a public repo)`);
    if (opts.code) return;
    if (COUNT_BIG.test(line) || COUNT_TENANCY.test(line) || (COUNT_SMALL_IN_CONTEXT.test(line) && hasProdContext(line))) {
      out.push(`line ${i + 1}: a population count (state evidence qualitatively)`);
    }
  });
  return out;
}

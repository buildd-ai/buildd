/**
 * The PR title/body half of the No Production Data check
 * (scripts/check_no_prod_data.py `scan_prose`, .github/workflows/no-prod-data.yml),
 * so `create_pr` can refuse a body CI would reject before the PR exists
 * (docs/specs/workflow-state-kernel.md §6.10 tier 1, S31).
 *
 * CI runs the Python script and this server cannot, so this is the same rule in
 * TypeScript, held to it by a parity test that runs both on one fixture set
 * (packages/core/__tests__/no-prod-data-prose.test.ts). Change one, change the
 * other: the test fails on any disagreement.
 *
 * Only the count/UUID rules live here. The identifier half needs a secret this
 * server never has, so CI stays its only enforcer. Findings never carry the
 * matched text, for the same reason the script masks it: the reply is read
 * back into a public PR thread more often than not.
 */

const TENANCY = String.raw`teams?|tenants?|customers?|orgs?|organi[sz]ations?|seats?|subscribers?|accounts?|api keys?|paying`;
const VOLUME = String.raw`rows?|records?|entries|entities|memories|keys?|users?|workspaces?|workers?|chunks?|tasks?|missions?|sessions?`;
const NOUNS = `${TENANCY}|${VOLUME}`;
const BIG = String.raw`\d{1,3}(?:,\d{3})+|\d{4,}|\d{2,}(?:\.\d+)?\s*[kKmMbB]\b`;
const UNITS = String.raw`kb|mb|gb|tb|kib|mib|gib|bytes?|bits?|ms|milliseconds?|s|seconds?|minutes?|hours?|days?|px|rem|em|%|stars?|forks?|tokens?|iterations?|items?|lines?|chars?|characters?|commits?|files?|prs?|issues?|requests?/s|rps|qps|usd|eur|gbp`;

const COUNT_BIG = new RegExp(String.raw`(?<![\w.#-])(?!0\d)(${BIG})(?:\s*/\s*[\d,]+)?\s+(?!(?:${UNITS})\b)(?:[a-z-]+\s+){0,2}?(${NOUNS})\b`, 'i');
const COUNT_TENANCY = new RegExp(String.raw`(?<![\w./#-])(?!0\d)(\d+)(?:\s*/\s*[\d,]+)?\s+(?!(?:${UNITS})\b)(?:[a-z-]+\s+){0,2}?(${TENANCY})\b`, 'i');
const COUNT_SMALL_IN_CONTEXT = new RegExp(String.raw`(?<![\w./#-])(?!0\d)(\d{2,3})\s+(?!(?:${UNITS})\b)(?:[a-z-]+\s+){0,2}?(${NOUNS})\b`, 'i');
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const PROD_CONTEXT_RE = /\bprod(?:uction)?\b|\blive\b|\bcurrently\b|\btotal\b|\bwe (?:have|had)\b|\bacross all\b/i;
const CODE_SPAN = /`[^`\n]*`/g;
const LIVE = /\blive\b/gi;
const ALLOW_RE = /^[ \t]*no-prod-data:[ \t]*allow[ \t]+(\S.*)$/im;

/** `live` inside a backtick span is an identifier, not a claim about production. */
function hasProdContext(line: string): boolean {
  return PROD_CONTEXT_RE.test(line.replace(CODE_SPAN, (span) => span.replace(LIVE, ' ')));
}

export type ProseFindingCategory = 'population count' | 'UUID';

export interface ProseFinding {
  where: 'PR title' | 'PR body';
  line: number;
  category: ProseFindingCategory;
}

export interface ProseScan {
  findings: ProseFinding[];
  /** The body opted out with a line starting `no-prod-data: allow <reason>`, as CI honours. */
  allowed: boolean;
}

function scanText(text: string, where: ProseFinding['where'], out: ProseFinding[]): void {
  text.split(/\r\n|\r|\n/).forEach((line, i) => {
    const small = COUNT_SMALL_IN_CONTEXT.test(line) && hasProdContext(line);
    if (COUNT_BIG.test(line) || COUNT_TENANCY.test(line) || small) out.push({ where, line: i + 1, category: 'population count' });
    if (UUID_RE.test(line)) out.push({ where, line: i + 1, category: 'UUID' });
  });
}

/** What CI's prose scan would flag in this title and body, without the identifier half. */
export function scanPrProse(p: { title: string; body: string }): ProseScan {
  if (ALLOW_RE.test(p.body)) return { findings: [], allowed: true };
  const findings: ProseFinding[] = [];
  scanText(p.title, 'PR title', findings);
  scanText(p.body, 'PR body', findings);
  return { findings, allowed: false };
}

/** The refusal text: categories and line numbers only, never the matched value. */
export function describeProseFindings(findings: ProseFinding[]): string {
  const where = findings.map((f) => `${f.where} line ${f.line}: possible ${f.category}`).join('; ');
  return `${where}. The No Production Data check CI runs on this repository would fail this PR: state evidence qualitatively and cite your own task by its short id, not a full UUID. A deliberate false positive can opt out with a body line starting "no-prod-data: allow <reason>".`;
}

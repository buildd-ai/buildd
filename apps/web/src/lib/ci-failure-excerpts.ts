/**
 * Failing-check log excerpts for `get_pr includeCiFailures`: why a PR's CI is
 * red, answered from the failing job's own log so nobody has to open GitHub.
 *
 * Fetched server-side with the installation token. Log text is untrusted and
 * can hold secrets, so it is cleaned, trimmed, redacted and size-capped before
 * it leaves here. A job whose log cannot be read degrades to name plus URL.
 */

import { githubApi, githubApiText } from '@/lib/github';
import type { FailedCheck } from '@/lib/failed-checks';

export const CI_EXCERPT_LINES = 150;
export const CI_EXCERPT_MAX_CHARS = 4000;
/** Across every failing job in one response, however many there are. */
export const CI_EXCERPTS_MAX_TOTAL_CHARS = 10000;

export interface CiFailureExcerpt {
  name: string;
  conclusion: string;
  url: string | null;
  /** First failing step of the job, when GitHub reports one. */
  step: string | null;
  /** Last lines of the job log, cleaned and redacted; null when no log was readable. */
  excerpt: string | null;
}

const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ESC_OTHER = /\u001b[@-Z\\-_]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** Actions prefixes every log line with an ISO timestamp (and the first with a BOM). */
const LINE_PREFIX = /^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;

export function cleanLogText(raw: string): string {
  return raw
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(ESC_OTHER, '')
    .replace(/\r/g, '')
    .replace(CONTROL, '')
    .split('\n')
    .map(line => line.replace(LINE_PREFIX, '').replace(/^\uFEFF/, ''))
    .join('\n');
}

// ── Redaction ───────────────────────────────────────────────────────────────
// The population/UUID rules are a port of scripts/check_no_prod_data.py: the
// same text that would fail that gate in a PR body must not leave here in a
// chat answer. The credential rules cover what CI logs carry that a diff does
// not. Keep the first block in step with the script when it changes.

const TENANCY = 'teams?|tenants?|customers?|orgs?|organi[sz]ations?|seats?|subscribers?|accounts?|api keys?|paying';
const VOLUME = 'rows?|records?|entries|entities|memories|keys?|users?|workspaces?|workers?|chunks?|tasks?|missions?|sessions?';
const NOUNS = `${TENANCY}|${VOLUME}`;
const BIG = String.raw`\d{1,3}(?:,\d{3})+|\d{4,}|\d{2,}(?:\.\d+)?\s*[kKmMbB]\b`;
const UNITS = 'kb|mb|gb|tb|kib|mib|gib|bytes?|bits?|ms|milliseconds?|s|seconds?|minutes?|hours?|days?|px|rem|em|%|stars?|forks?|tokens?|iterations?|items?|lines?|chars?|characters?|commits?|files?|prs?|issues?|requests?/s|rps|qps|usd|eur|gbp';

const COUNT_BIG = new RegExp(String.raw`(?<![\w.#-])(${BIG})(?:\s*/\s*[\d,]+)?\s+(?!(?:${UNITS})\b)(?:[a-z-]+\s+){0,2}?(?:${NOUNS})\b`, 'gi');
const COUNT_TENANCY = new RegExp(String.raw`(?<![\w./#-])(\d+)(?:\s*/\s*[\d,]+)?\s+(?!(?:${UNITS})\b)(?:[a-z-]+\s+){0,2}?(?:${TENANCY})\b`, 'gi');
const COUNT_SMALL = new RegExp(String.raw`(?<![\w./#-])(\d{2,3})\s+(?!(?:${UNITS})\b)(?:[a-z-]+\s+){0,2}?(?:${NOUNS})\b`, 'gi');
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PROD_CONTEXT = /\bprod(?:uction)?\b|\blive\b|\bcurrently\b|\btotal\b|\bwe (?:have|had)\b|\bacross all\b/i;

const SECRET = '[redacted-secret]';
const TOKEN_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bbld_[A-Za-z0-9_]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
];
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/g;
const URL_CREDENTIALS = /(:\/\/[^\s:/@]+):[^\s@/]+@/g;
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*\S+/g;

const maskCount = (m: string, n: string) => `[redacted-count]${m.slice(n.length)}`;

export function redactLogText(text: string): string {
  let out = text.replace(UUID, '[redacted-id]');
  for (const re of TOKEN_SHAPES) out = out.replace(re, SECRET);
  out = out
    .replace(BEARER, `$1 ${SECRET}`)
    .replace(URL_CREDENTIALS, `$1:${SECRET}@`)
    .replace(SECRET_ASSIGNMENT, `$1=${SECRET}`);
  return out
    .split('\n')
    .map(line => {
      let l = line.replace(COUNT_BIG, maskCount).replace(COUNT_TENANCY, maskCount);
      if (PROD_CONTEXT.test(l)) l = l.replace(COUNT_SMALL, maskCount);
      return l;
    })
    .join('\n');
}

// ── Trimming ────────────────────────────────────────────────────────────────

function lastLines(text: string, n = CI_EXCERPT_LINES): string {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l !== '');
  return lines.slice(-n).join('\n');
}

const ELLIPSIS = '…\n';

function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const budget = max - ELLIPSIS.length;
  if (budget <= 0) return text.slice(-max);
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + (kept.length ? 1 : 0);
    if (used + cost > budget) break;
    kept.unshift(lines[i]);
    used += cost;
  }
  // A last line longer than the whole budget: keep its tail rather than nothing.
  if (kept.length === 0) return ELLIPSIS + lines[lines.length - 1].slice(-budget);
  return ELLIPSIS + kept.join('\n');
}

/** Last lines of an already-cleaned log, blank lines dropped, within the character cap. */
export function tailExcerpt(cleaned: string, maxChars = CI_EXCERPT_MAX_CHARS): string {
  return capChars(lastLines(cleaned), maxChars);
}

// ── Fetching ────────────────────────────────────────────────────────────────

/**
 * The Actions job id in a check's URL. A check-run's id is its job's id, so
 * both `.../runs/<run>/job/<id>` and `.../runs/<id>` name it.
 */
export function jobIdFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = url.match(/\/actions\/runs\/\d+\/job\/(\d+)/) ?? url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/runs\/(\d+)(?:[?#]|$)/);
  return m ? Number(m[1]) : null;
}

async function excerptFor(
  installationId: number,
  repoFullName: string,
  check: FailedCheck,
  maxChars: number,
): Promise<CiFailureExcerpt> {
  const base: CiFailureExcerpt = { name: check.name, conclusion: check.conclusion, url: check.url, step: null, excerpt: null };
  const jobId = jobIdFromUrl(check.url);
  if (jobId === null) return base;

  const [job, log] = await Promise.allSettled([
    githubApi(installationId, `/repos/${repoFullName}/actions/jobs/${jobId}`),
    githubApiText(installationId, `/repos/${repoFullName}/actions/jobs/${jobId}/logs`),
  ]);

  if (job.status === 'fulfilled') {
    const steps: Array<{ name?: string; conclusion?: string }> = Array.isArray(job.value?.steps) ? job.value.steps : [];
    const failing = steps.find(s => s.conclusion === 'failure' && typeof s.name === 'string');
    if (failing?.name) base.step = redactLogText(failing.name);
  }
  if (log.status === 'fulfilled' && log.value) {
    const excerpt = capChars(redactLogText(lastLines(cleanLogText(log.value))), maxChars);
    base.excerpt = excerpt || null;
  }
  return base;
}

/**
 * One excerpt per failing check, in order. Never throws: a job that cannot be
 * read comes back as name plus URL. The budget is shared, so many failing jobs
 * get shorter excerpts, not a longer answer.
 */
export async function fetchCiFailureExcerpts(
  installationId: number,
  repoFullName: string,
  failed: readonly FailedCheck[],
): Promise<CiFailureExcerpt[]> {
  if (failed.length === 0) return [];
  const perJob = Math.min(CI_EXCERPT_MAX_CHARS, Math.floor(CI_EXCERPTS_MAX_TOTAL_CHARS / failed.length));
  return Promise.all(failed.map(c => excerptFor(installationId, repoFullName, c, perJob)));
}

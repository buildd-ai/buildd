/**
 * API / state-contract adapter: the port shape, the expectation parser and the
 * judge. An auth wall (the Visual Auditor's `classifyPageLoad`) is the owner's
 * config, so it judges `unsupported`, never `fail`.
 */

import type { VerificationObservation } from '../../verification-check';
import { classifyPageLoad } from '../../visual-qa-page-source';
import { CONTAINS, splitClauses, evidenceRefs } from './shared';

/** The evidence key an HTTP exchange produces. */
export const CONTRACT_EVIDENCE_KEY = 'http-exchange';

export interface ScoutHttpRequest {
  method: string;
  url: string;
  timeoutMs: number;
}

export interface ScoutHttpResponse {
  /** Null when no response arrived. */
  status: number | null;
  finalUrl?: string;
  bodyExcerpt?: string;
  durationMs?: number;
  evidenceRef?: string | null;
}

export interface ScoutHttpExpectation {
  /** Exact status, or a class like `2xx`. */
  status: number | `${1 | 2 | 3 | 4 | 5}xx`;
  bodyIncludes?: string;
}

/** Methods a probe may send without the capability being declared mutating. */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `journey.expect` → an HTTP expectation. Null when any clause is not understood. */
export function parseHttpExpectation(raw: string | undefined): ScoutHttpExpectation | null {
  const out: ScoutHttpExpectation = { status: '2xx' };
  if (raw === undefined || !raw.trim()) return out;
  for (const clause of splitClauses(raw)) {
    let m: RegExpMatchArray | null;
    if ((m = clause.match(/^(?:status\s+|returns\s+|responds\s+)?([1-5])xx$/i))) out.status = `${Number(m[1]) as 1 | 2 | 3 | 4 | 5}xx`;
    else if ((m = clause.match(/^(?:status\s+|returns\s+|responds\s+)?([1-5]\d\d)$/i))) out.status = Number(m[1]);
    else if ((m = clause.match(CONTAINS))) out.bodyIncludes = m[1];
    else return null;
  }
  return out;
}

function statusMatches(status: number, want: ScoutHttpExpectation['status']): boolean {
  return typeof want === 'number' ? status === want : Math.floor(status / 100) === Number(want[0]);
}

/** Did this response land on an auth wall (a config error a person must fix)? */
export function isAuthWall(url: string, response: ScoutHttpResponse): boolean {
  return response.status != null
    && classifyPageLoad({ requestedUrl: url, finalUrl: response.finalUrl ?? url, status: response.status, bodyText: response.bodyExcerpt }).kind === 'config_error';
}

/** Judge one HTTP exchange against its expectation. Synchronous substrate executor body. */
export function judgeApi({ method, path, url, expect, response }: {
  method: string;
  path: string;
  url: string;
  expect: ScoutHttpExpectation;
  response: ScoutHttpResponse | null;
}): VerificationObservation {
  if (!response || response.status === null) return { verdict: 'inconclusive', observed: `No response from ${method} ${path}.` };
  const refs = evidenceRefs(CONTRACT_EVIDENCE_KEY, response.evidenceRef);
  const wall = classifyPageLoad({ requestedUrl: url, finalUrl: response.finalUrl ?? url, status: response.status, bodyText: response.bodyExcerpt });
  if (wall.kind === 'config_error') return { verdict: 'unsupported', observed: wall.message, evidenceRefs: refs };
  const statusOk = statusMatches(response.status, expect.status);
  const want = expect.bodyIncludes;
  const bodyOk = want === undefined || (response.bodyExcerpt ?? '').includes(want);
  const summary = `${method} ${path} → ${response.status} (expected ${expect.status})${want !== undefined ? `; body ${bodyOk ? 'includes' : 'lacks'} "${want}"` : ''}`;
  if (statusOk && bodyOk) return { verdict: 'pass', observed: summary, evidenceRefs: refs, confidence: 1 };
  return { verdict: 'fail', observed: summary, evidenceRefs: refs, confidence: 1, signatureParts: [statusOk ? 'body-mismatch' : `status:${response.status}`] };
}

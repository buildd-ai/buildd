import { isRepoPath } from './repo-copy';

/**
 * Acceptance tests recorded against their checks (R-77, "Acceptance tests come
 * first"): the metadata `verified_by` is either the older flat list of repo
 * paths or a map keyed by check id. Recording one changes no revision, so the
 * spec's version and approved hash do not move.
 */
export type VerifiedByRecord = string[] | Record<string, string[]>;

const CHECK_ID = /^(?:R|AC)-\d+$/;
const MAX_ENTRIES = 50;

export function validVerifiedBy(raw: unknown): raw is VerifiedByRecord {
  const paths = (a: unknown) => Array.isArray(a) && a.length > 0 && a.length <= MAX_ENTRIES && a.every((p) => typeof p === 'string' && isRepoPath(p));
  if (Array.isArray(raw)) return raw.length <= MAX_ENTRIES && raw.every((p) => typeof p === 'string' && isRepoPath(p));
  if (!raw || typeof raw !== 'object') return false;
  const entries = Object.entries(raw);
  return entries.length <= MAX_ENTRIES && entries.every(([id, v]) => CHECK_ID.test(id) && paths(v));
}

/** Every distinct test path, in first-seen order: what the repo copy's flat `verified_by` lists. */
export function flattenVerifiedBy(v: VerifiedByRecord | null | undefined): string[] {
  if (!v) return [];
  return [...new Set(Array.isArray(v) ? v : Object.values(v).flat())];
}

/** The id stands alone in the name, so `AC-3` is not found in `AC-33`. */
export function testNameCarriesId(name: string, id: string): boolean {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9-])${esc}(?![A-Za-z0-9-])`).test(name);
}

export interface AcceptanceCheck { id: string; testable: boolean; why?: string }
export interface AcceptanceTest { path: string; name: string }

export interface AcceptancePlan {
  verifiedBy: Record<string, string[]>;
  /** Checks that cannot be tested, with the reason the acceptance-tests task gave (R-82). */
  untested: Array<{ id: string; why: string }>;
  problems: string[];
}

/** Match written tests to the checks in scope by the id in each test's name. */
export function planAcceptanceRecord(checks: AcceptanceCheck[], tests: AcceptanceTest[]): AcceptancePlan {
  const verifiedBy: Record<string, string[]> = {};
  const untested: AcceptancePlan['untested'] = [];
  const problems: string[] = [];
  const claimed = new Set<AcceptanceTest>();
  for (const c of checks) {
    if (!c.testable) {
      const why = c.why?.trim();
      if (why) untested.push({ id: c.id, why }); else problems.push(`${c.id} is not testable and says no reason (R-82)`);
      continue;
    }
    const hits = tests.filter((t) => testNameCarriesId(t.name, c.id));
    hits.forEach((t) => claimed.add(t));
    if (!hits.length) problems.push(`${c.id} is testable but has no test with its id in the name`);
    else verifiedBy[c.id] = [...new Set(hits.map((t) => t.path))];
  }
  for (const t of tests) if (!claimed.has(t)) problems.push(`test "${t.name}" in ${t.path} names no check in scope`);
  return { verifiedBy, untested, problems };
}

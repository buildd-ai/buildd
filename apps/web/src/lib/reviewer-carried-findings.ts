/**
 * Findings carried onto a trunk fix (f8a7a088). A PR merged outside buildd over
 * an open review verdict owes one fix task against its base
 * (`dispatch_external_merge_fix`); the required findings still open at the
 * merge ride on that task as `context.carriedFindings`. The merge closed none
 * of them, so the fix's review is the only place they can close, and it closes
 * them only with evidence: an approve that does not report each one verified,
 * or that says it could not check, is held.
 *
 * Pure: the worker route applies the gate, `createReviewerTask` renders the
 * section, and both read the task context through `carriedFindingsOfContext`.
 */
/**
 * One carried finding, as the kernel's `carriedFindingsOf` writes it onto the task
 * (packages/workflow-kernel/src/handlers/landing.ts). Restated here: outside lib/workflow the
 * kernel is imported only through its entry points (workflow-write-sites S14), and this is read
 * off a task row, not a kernel call.
 */
export interface CarriedFinding {
  id: string;
  title: string;
  path: string | null;
  line: number | null;
  remedyClass: string | null;
  evidence?: { criterionId: string | null; screen: string; route: string | null };
}

type Verdict = 'approve' | 'request-changes' | 'escalate';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The findings a task carries from a PR merged over them; empty for any other task. */
export function carriedFindingsOfContext(context: unknown): CarriedFinding[] {
  const raw = context && typeof context === 'object' ? (context as { carriedFindings?: unknown }).carriedFindings : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f): CarriedFinding[] => {
    const r = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
    const id = str(r.id); const title = str(r.title);
    if (!id || !title) return [];
    const ev = (r.evidence && typeof r.evidence === 'object' ? r.evidence : null) as Record<string, unknown> | null;
    const screen = ev ? str(ev.screen) : null;
    return [{
      id, title, path: str(r.path), line: typeof r.line === 'number' && Number.isFinite(r.line) ? Math.trunc(r.line) : null,
      remedyClass: str(r.remedyClass),
      ...(screen ? { evidence: { criterionId: str(ev!.criterionId), screen, route: str(ev!.route) } } : {}),
    }];
  });
}

const isEvidence = (f: CarriedFinding): boolean => f.remedyClass === 'evidence' && !!f.evidence;

function describe(f: CarriedFinding): string {
  const where = f.path ? ` (${f.path}${f.line != null ? `:${f.line}` : ''})` : '';
  const ev = isEvidence(f) ? ` — evidence: compare design screen ${f.evidence!.screen}${f.evidence!.route ? ` with the built page at ${f.evidence!.route}` : ' with the built page'}` : '';
  return `- \`${f.id}\` ${f.title}${where}${ev}`;
}

/** The reviewer's section for a task that carries findings. Empty when it carries none. */
export function carriedFindingsSection(findings: readonly CarriedFinding[], mergedPrNumber?: number | null): string {
  if (findings.length === 0) return '';
  return [
    '',
    '',
    `## Findings carried from ${mergedPrNumber != null ? `PR #${mergedPrNumber}` : 'the merged PR'} (required evidence)`,
    'That PR was merged outside buildd while these findings were open. This PR exists to close them, and only your review can.',
    'For each one, verify it at this head and report it in `carriedFindings` as `{ id, verified, how }`: `how` says what you checked (the file and line read, the test run, the screenshot artifact compared).',
    '- Approve only when every finding below is reported `verified: true`. An approve that leaves one unreported, or whose summary says you could not check something, is held by buildd.',
    '- A design-comparison finding you cannot capture yourself: report it `verified: false`. buildd captures the screen and asks again; do not approve on the diff alone.',
    '- Anything else you cannot verify: escalate, naming the finding.',
    '',
    ...findings.map(describe),
  ].join('\n');
}

/** What the reviewer reported for one carried finding. */
export interface CarriedFindingCheck { id: string; verified: boolean; how: string | null }

export function parseCarriedFindingChecks(output: unknown): CarriedFindingCheck[] {
  const raw = output && typeof output === 'object' ? (output as { carriedFindings?: unknown }).carriedFindings : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const r = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const id = str(r.id);
    return id ? [{ id, verified: r.verified === true, how: str(r.how) }] : [];
  });
}

/**
 * The reviewer saying, in its own words, that it did not check something: "I couldn't check
 * the design comparisons", "was not able to verify", "did not run". Read only to hold an
 * approve, never to grant one, so model text cannot loosen a gate.
 */
const UNVERIFIED_ADMISSION = new RegExp(
  String.raw`\b(?:could\s?not|couldn[’']?t|can\s?not|can[’']?t|unable\s+to|(?:was|were)n[’']?t\s+able\s+to|(?:was|were)\s+not\s+able\s+to|did\s?not|didn[’']?t|have\s?not|haven[’']?t)\s+(?:\w+\s+){0,2}?(?:check|verify|confirm|capture|compare|run|test|reproduce|inspect|load)\b`,
  'i',
);

export function admitsUnverified(text: string | null | undefined): boolean {
  return !!text && UNVERIFIED_ADMISSION.test(text);
}

/** A finding the gate raises, in the reviewer output's own shape (seam `verdictFindingsOf`). */
export interface CarriedGateFinding {
  title: string;
  remedyClass: 'evidence';
  evidence: { criterionId: string | null; screen: string; route: string | null };
}

/**
 * An approve of a task that carries findings stands only when the reviewer reported every one
 * verified, with how, and did not say it could not check something. Otherwise:
 *  - a carried finding that is not a design comparison, or an admission with nothing left to
 *    capture: escalate, naming them (a person decides what the merge left open);
 *  - only design comparisons missing: request-changes with one `evidence` finding each, which
 *    the kernel routes to buildd's capture (dispatch_visual_qa), never to the builder.
 * Other verdicts pass through.
 */
export function applyCarriedFindingsGate(params: {
  verdict: Verdict;
  carried: readonly CarriedFinding[];
  checks: readonly CarriedFindingCheck[];
  /** The reviewer's summary and feedback, read for an admission only. */
  said?: ReadonlyArray<string | null | undefined>;
}): { verdict: Verdict; reason: string | null; findings: CarriedGateFinding[] } {
  const { verdict, carried, checks } = params;
  if (verdict !== 'approve' || carried.length === 0) return { verdict, reason: null, findings: [] };
  const verified = (f: CarriedFinding) => {
    const c = checks.find((k) => k.id === f.id || (f.id.startsWith(k.id) && k.id.length >= 8));
    return !!c && c.verified && !!c.how && !admitsUnverified(c.how);
  };
  const open = carried.filter((f) => !verified(f));
  const admitted = (params.said ?? []).some(admitsUnverified);
  if (open.length === 0 && !admitted) return { verdict, reason: null, findings: [] };
  const named = (fs: readonly CarriedFinding[]) => fs.map((f) => `${f.id.slice(0, 8)} "${f.title}"`).join('; ');
  const people = open.filter((f) => !isEvidence(f));
  if (people.length > 0 || open.length === 0) {
    return {
      verdict: 'escalate',
      reason: open.length
        ? `approved without verifying the finding${open.length === 1 ? '' : 's'} carried from the merged PR: ${named(open)}`
        : 'approved while saying it could not check something, on a PR that must close findings carried from the merged PR',
      findings: [],
    };
  }
  return {
    verdict: 'request-changes',
    reason: `No design comparison yet for the finding${open.length === 1 ? '' : 's'} carried from the merged PR: ${named(open)}; buildd captures it.`,
    findings: open.map((f) => ({
      title: `Compare screen ${f.evidence!.screen} with the built page (carried: ${f.title})`,
      remedyClass: 'evidence',
      evidence: { criterionId: f.evidence!.criterionId, screen: f.evidence!.screen, route: f.evidence!.route },
    })),
  };
}

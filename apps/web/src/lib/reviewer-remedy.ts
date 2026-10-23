/**
 * The remedy class of a reviewer finding, and the validator that keeps a
 * "a person runs this" remedy honest.
 *
 * A reviewer once escalated with "a person must run the eval with a DB, or waive
 * it" against a task whose pinned spec required model calls to go through
 * buildd's own broker, and a governed capability for that already existed. The
 * reviewer took the builder's infeasibility claim on trust. A finding whose
 * remedy is a manual step now says which kind of remedy it is, and the two
 * kinds that hand work to a person carry the evidence that the human step is
 * not already ruled out by the spec or covered by a capability.
 *
 * Kept free of DB and GitHub imports, like `reviewer-output.ts`, which calls it.
 */

export const REMEDY_CLASSES = ['code_fix', 'person_decision', 'capability_gap', 'operational_run'] as const;
export type RemedyClass = (typeof REMEDY_CLASSES)[number];

/** Remedy classes that propose a manual step or a missing capability, and so need evidence. */
const EVIDENCE_CLASSES: ReadonlySet<string> = new Set(['capability_gap', 'operational_run']);

/** Bump when `REVIEWER_REMEDY_DOCTRINE` changes: the version names the text in effect. */
export const REVIEWER_REMEDY_PROMPT_VERSION = 'v1';
export const REVIEWER_REMEDY_PROMPT_ID = 'buildd.reviewer.remedy_doctrine';

export const REVIEWER_REMEDY_DOCTRINE = `Every finding on an escalation, and every finding whose remedy is a manual step, carries a \`remedyClass\`:
- \`code_fix\`: the author changes code, tests or docs.
- \`person_decision\`: a choice only a person can make (product direction, a trade-off, a waiver of a requirement). It escalates to a person as before.
- \`capability_gap\`: buildd lacks a capability the work needs, or one exists and should be used.
- \`operational_run\`: something must be run or operated outside the diff.

For \`capability_gap\` and \`operational_run\` do not take the author's claim that a step is infeasible on trust. Call \`resolve_capability\` for the need and attach \`remedyEvidence\`: \`{ resolveCapabilityResult, contradictsPinnedCriterion, existingCapabilityCovers, capability? }\`. Answer two questions from the pinned spec criteria and that result: does the proposed human step contradict a pinned criterion, and does an existing capability cover it? If either is yes, restate the finding as \`capability_gap\` that names the capability ("use request_capability <X>" or "missing capability <Y>"), never as "a person runs it".`;

export interface RemedyEvidence {
  resolveCapabilityResult: string;
  contradictsPinnedCriterion: boolean;
  existingCapabilityCovers: boolean;
  capability?: string;
}

export type RemedyCheck = { ok: true } | { ok: false; reason: string };

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** One finding, as the reviewer returned it. */
export function checkRemedyFinding(raw: unknown, opts: { verdict: string }): RemedyCheck {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const label = nonEmpty(f.title) ? `finding "${f.title.trim().slice(0, 60)}"` : 'a finding';
  const cls = f.remedyClass;
  if (cls === undefined || cls === null) {
    return opts.verdict === 'escalate'
      ? { ok: false, reason: `${label} on an escalation needs remedyClass: one of ${REMEDY_CLASSES.join(', ')}` }
      : { ok: true };
  }
  if (typeof cls !== 'string' || !(REMEDY_CLASSES as readonly string[]).includes(cls)) {
    return { ok: false, reason: `${label}: remedyClass must be one of ${REMEDY_CLASSES.join(', ')} (got ${JSON.stringify(cls)})` };
  }
  if (!EVIDENCE_CLASSES.has(cls)) return { ok: true };

  const e = (f.remedyEvidence && typeof f.remedyEvidence === 'object' ? f.remedyEvidence : null) as Record<string, unknown> | null;
  if (!e || !nonEmpty(e.resolveCapabilityResult) || typeof e.contradictsPinnedCriterion !== 'boolean' || typeof e.existingCapabilityCovers !== 'boolean') {
    return {
      ok: false,
      reason: `${label} has remedyClass ${cls} without remedyEvidence: call resolve_capability for the need and attach { resolveCapabilityResult, contradictsPinnedCriterion, existingCapabilityCovers }`,
    };
  }
  if (e.contradictsPinnedCriterion || e.existingCapabilityCovers) {
    if (cls === 'operational_run') {
      return {
        ok: false,
        reason: `${label} sends a person to run something that ${e.contradictsPinnedCriterion ? 'contradicts a pinned criterion' : 'an existing capability covers'}: restate it as capability_gap naming the capability`,
      };
    }
    if (e.existingCapabilityCovers && !nonEmpty(e.capability) && !/\b(request_capability|resolve_capability)\b/.test(String(f.title))) {
      return { ok: false, reason: `${label} says an existing capability covers it but does not name it (remedyEvidence.capability)` };
    }
  }
  return { ok: true };
}

/** Every finding of a reviewer output; the first failure rejects the output. */
export function checkRemedyFindings(output: { verdict: string; findings?: unknown }): RemedyCheck {
  if (!Array.isArray(output.findings)) return { ok: true };
  for (const f of output.findings) {
    const r = checkRemedyFinding(f, { verdict: output.verdict });
    if (!r.ok) return r;
  }
  return { ok: true };
}

/** Does a finding tell a person to run the thing themselves with a database? Used to score eval cases. */
export function tellsPersonToRun(title: string): boolean {
  return /\b(a person|someone|a human|an? operator|you)\b.*\b(must|should|needs? to|to)\b.*\b(run|execute)\b/i.test(title)
    || /\brun\b.*\bwith a (db|database)\b/i.test(title);
}

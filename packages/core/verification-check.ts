/**
 * Shared verification-check substrate — the mechanics only (ADR
 * `adr-shared-verification-check-substrate`).
 *
 * One small, policy-free layer for expressing a check, running it, and
 * recording what it found, so Post-session Quality, Quality Scout, Goal
 * Criteria and later flavors do not each grow their own result/evidence/
 * dedupe stack. It owns:
 *
 *  - **identity** — `id` + `version` of the invariant, and the subject it ran on;
 *  - **executor + capability matching** — an executor names the capabilities it
 *    needs; a host that lacks one gets `unsupported`, and the executor never runs;
 *  - **evidence requirements** — a check names the evidence it needs and how
 *    complete it must be; short evidence is `inconclusive`, never asserted.
 *    Missing evidence is not negative evidence;
 *  - **verdict semantics** — pass | fail | inconclusive | unsupported;
 *  - **severity / confidence**, **evidence refs**, **signature / recurrence
 *    key** for dedupe, and **provenance** for history.
 *
 * It deliberately does NOT own where checks come from, which run, when, or what
 * a result is allowed to do: that is each flavor's policy (e.g. post-session
 * triage and the follow-up policy live in the post-session modules). Keep it
 * that way — "DRY the mechanics, not the policy".
 *
 * Pure: no DB, no network. Executors here are synchronous; an executor that
 * needs I/O reads it before the run and passes it in as `input`.
 */

import { createHash } from 'node:crypto';

// ── Vocabularies ────────────────────────────────────────────────────────────

/**
 * `inconclusive`: the check could run but the evidence could not settle it.
 * `unsupported`: this host cannot run the check at all (missing capability).
 * Neither ever counts as a pass or a fail.
 */
export const VERIFICATION_VERDICTS = ['pass', 'fail', 'inconclusive', 'unsupported'] as const;
export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number];

/** Consequence, not interest. Same scale post-session findings persist. */
export const VERIFICATION_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type VerificationSeverity = (typeof VERIFICATION_SEVERITIES)[number];

/** How much of a piece of evidence the host has. */
export const EVIDENCE_COVERAGE = ['complete', 'partial', 'absent'] as const;
export type EvidenceCoverage = (typeof EVIDENCE_COVERAGE)[number];

export const MAX_EVIDENCE_REFS = 10;
export const MAX_OBSERVED_CHARS = 500;
const MAX_REF_CHARS = 200;
const MAX_KIND_CHARS = 48;
const SIGNATURE_HEX = 24;

export function severityRank(s: VerificationSeverity): number {
  return VERIFICATION_SEVERITIES.indexOf(s);
}

export function maxSeverity(a: VerificationSeverity, b: VerificationSeverity): VerificationSeverity {
  return severityRank(a) <= severityRank(b) ? a : b;
}

// ── Shapes ──────────────────────────────────────────────────────────────────

/** Pointer to evidence — never the evidence itself. */
export interface VerificationEvidenceRef {
  kind: string;
  ref: string;
}

/** What a check ran against: a worker, a PR head SHA, a route, a mission. */
export interface VerificationSubject {
  kind: string;
  ref: string;
}

/** Why the check exists: which flavor asked for it, and from what. */
export interface VerificationProvenance {
  flavor: string;
  origin: string;
}

/** A named piece of evidence the check needs, and how complete it must be. */
export interface EvidenceRequirement {
  key: string;
  /** `complete`: only complete evidence will do. `partial`: any present portion will. */
  need: Exclude<EvidenceCoverage, 'absent'>;
}

export interface EvidenceShortfall {
  key: string;
  need: EvidenceRequirement['need'];
  have: EvidenceCoverage;
}

/** What an executor reports. Everything but `verdict` is optional. */
export interface VerificationObservation {
  verdict: VerificationVerdict;
  observed?: string;
  evidenceRefs?: VerificationEvidenceRef[];
  confidence?: number;
  /** Overrides the check's default severity for this result (fail only). */
  severity?: VerificationSeverity;
  /** Extra dedupe parts, e.g. an error slug. Never a per-run id. */
  signatureParts?: string[];
  /** Overrides the default family key (the check id). */
  recurrenceKey?: string;
}

export interface VerificationExecutor<I> {
  /** e.g. `deterministic`, `transcript`, `command`, `model`. */
  kind: string;
  /** Capabilities the host must offer for this executor to run. */
  requires: readonly string[];
  run(input: I): VerificationObservation;
}

export interface VerificationCheck<I> {
  id: string;
  version: number;
  /** What must be true, in one line. */
  invariant: string;
  subject: VerificationSubject;
  provenance: VerificationProvenance;
  executor: VerificationExecutor<I>;
  evidenceRequirements: readonly EvidenceRequirement[];
  defaultSeverity: VerificationSeverity;
}

export interface VerificationRunContext<I> {
  input: I;
  /** Coverage per evidence key. A key not listed is `absent`. */
  evidence: Readonly<Record<string, EvidenceCoverage>>;
  capabilities: readonly string[];
  now: Date;
}

export interface VerificationResult {
  checkId: string;
  checkVersion: number;
  subject: VerificationSubject;
  verdict: VerificationVerdict;
  /** Set only on `fail`. */
  severity: VerificationSeverity | null;
  /** 0..1, or null when the executor gave none. */
  confidence: number | null;
  observed: string | null;
  evidenceRefs: VerificationEvidenceRef[];
  /** Why the verdict is inconclusive/unsupported. Machine-readable, bounded. */
  reason: string | null;
  evidenceShortfall: EvidenceShortfall[];
  signature: string;
  /**
   * The executor's extra dedupe parts `signature` was built from (after the
   * check id). Present only when there were any. A remote host reports these,
   * not a signature: the receiving server re-derives the signature itself.
   */
  signatureParts?: string[];
  recurrenceKey: string;
  provenance: VerificationProvenance & { executor: string; ranAt: string };
}

// ── Mechanics ───────────────────────────────────────────────────────────────

/**
 * Stable dedupe key. Parts are trimmed and lower-cased, then length-prefixed
 * so `['ab','c']` and `['a','bc']` cannot collide.
 */
export function verificationSignature(parts: readonly string[]): string {
  const canonical = parts.map(p => {
    const s = p.trim().toLowerCase();
    return `${s.length}:${s}`;
  }).join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, SIGNATURE_HEX);
}

export function missingCapabilities(requires: readonly string[], available: readonly string[]): string[] {
  return requires.filter(c => !available.includes(c));
}

export function evidenceShortfall(
  requirements: readonly EvidenceRequirement[],
  evidence: Readonly<Record<string, EvidenceCoverage>>,
): EvidenceShortfall[] {
  const out: EvidenceShortfall[] = [];
  for (const req of requirements) {
    const have = evidence[req.key] ?? 'absent';
    const ok = req.need === 'complete' ? have === 'complete' : have !== 'absent';
    if (!ok) out.push({ key: req.key, need: req.need, have });
  }
  return out;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function boundRefs(refs: VerificationEvidenceRef[] | undefined): VerificationEvidenceRef[] {
  if (!Array.isArray(refs)) return [];
  return refs
    .filter(r => r && typeof r.kind === 'string' && typeof r.ref === 'string')
    .slice(0, MAX_EVIDENCE_REFS)
    .map(r => ({ kind: clip(r.kind, MAX_KIND_CHARS), ref: clip(r.ref, MAX_REF_CHARS) }));
}

function boundConfidence(c: unknown): number | null {
  if (typeof c !== 'number' || !Number.isFinite(c)) return null;
  return Math.min(1, Math.max(0, c));
}

/**
 * Run one check. Never throws. Order: capabilities → evidence → executor. A
 * failing gate short-circuits, so an executor never sees evidence the check
 * said it could not trust.
 */
export function runVerificationCheck<I>(check: VerificationCheck<I>, ctx: VerificationRunContext<I>): VerificationResult {
  const base = {
    checkId: check.id,
    checkVersion: check.version,
    subject: { ...check.subject },
    provenance: { ...check.provenance, executor: check.executor.kind, ranAt: ctx.now.toISOString() },
  };
  const skeleton = (verdict: VerificationVerdict, reason: string | null, shortfall: EvidenceShortfall[] = []): VerificationResult => ({
    ...base,
    verdict,
    severity: null,
    confidence: null,
    observed: null,
    evidenceRefs: [],
    reason,
    evidenceShortfall: shortfall,
    signature: verificationSignature([check.id]),
    recurrenceKey: check.id,
  });

  const missing = missingCapabilities(check.executor.requires, ctx.capabilities);
  if (missing.length > 0) return skeleton('unsupported', clip(`missing_capability:${missing.join(',')}`, 120));

  const short = evidenceShortfall(check.evidenceRequirements, ctx.evidence);
  if (short.length > 0) {
    return skeleton('inconclusive', clip(`evidence_insufficient:${short.map(s => s.key).join(',')}`, 120), short);
  }

  let obs: VerificationObservation;
  try {
    obs = check.executor.run(ctx.input);
  } catch {
    // The message can carry anything the executor touched; record the fact only.
    return skeleton('inconclusive', 'executor_error');
  }
  if (!obs || !(VERIFICATION_VERDICTS as readonly string[]).includes(obs.verdict)) {
    return skeleton('inconclusive', 'executor_malformed');
  }

  const severity = obs.verdict === 'fail'
    ? (obs.severity && (VERIFICATION_SEVERITIES as readonly string[]).includes(obs.severity) ? obs.severity : check.defaultSeverity)
    : null;
  const parts = Array.isArray(obs.signatureParts) ? obs.signatureParts.filter(p => typeof p === 'string') : [];
  return {
    ...base,
    verdict: obs.verdict,
    severity,
    confidence: boundConfidence(obs.confidence),
    observed: typeof obs.observed === 'string' ? clip(obs.observed, MAX_OBSERVED_CHARS) : null,
    evidenceRefs: boundRefs(obs.evidenceRefs),
    reason: null,
    evidenceShortfall: [],
    signature: verificationSignature([check.id, ...parts]),
    ...(parts.length > 0 ? { signatureParts: [...parts] } : {}),
    recurrenceKey: typeof obs.recurrenceKey === 'string' && obs.recurrenceKey ? clip(obs.recurrenceKey, 120) : check.id,
  };
}

/** Verdict counts, for readouts and run history. */
export function summarizeVerificationResults(results: readonly VerificationResult[]): Record<VerificationVerdict | 'total', number> {
  const out = { total: results.length, pass: 0, fail: 0, inconclusive: 0, unsupported: 0 };
  for (const r of results) out[r.verdict]++;
  return out;
}

/**
 * Quality Scout candidate generation — `generateScoutCandidates(signals, profile)`.
 *
 * Pure: workspace-grounded signals plus the capability profile
 * (`scout-capabilities.ts`) in, a bounded, ordered set of candidate probes out.
 * Selection (`./selector.ts`) and execution are elsewhere.
 *
 * Rules this module owns:
 *
 * - **Grounded only.** Every candidate comes from a signal the caller passed:
 *   a changed path, a reviewer state, a failure signature, a relevant Recall
 *   entry, a spec discrepancy, a visual finding, a readiness change, a touched
 *   critical path or a prior severe finding. No signals, no candidates.
 * - **History proposes, it never proves.** Candidates from history are marked
 *   `grounding: 'history'` and their invariant says what must *not* happen
 *   now; nothing here asserts the old defect is still present.
 * - **Invariant before execution.** Every candidate carries a non-empty
 *   invariant and is frozen, so the claim a probe tests cannot be rewritten
 *   after an odd result appears.
 * - **Bounded.** Inputs, text fields, path lists and the candidate set are all
 *   capped; the most severe candidates survive the cap.
 * - **Unsupported is recorded.** A candidate whose preconditions no usable
 *   capability meets keeps `supported: false` and the reason, rather than
 *   being dropped.
 */

import { createHash } from 'crypto';
import type { ScoutProbeKind } from '../decision-kind-scout-probe-selection';
import type { ScoutCapability, ScoutCapabilityKind, ScoutCapabilityProfile } from '../scout-capabilities';

export type ScoutProbeFamily = 'state-transition' | 'surface' | 'contract' | 'persistence' | 'release';
export type ScoutSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ScoutGrounding = 'change' | 'history' | 'config';
export type ScoutSignalType =
  | 'change'
  | 'review'
  | 'failure'
  | 'recall'
  | 'spec'
  | 'visual'
  | 'readiness'
  | 'critical-path'
  | 'prior-finding';
export type ScoutCost = 'low' | 'medium' | 'high';

export interface ScoutCriticalPath {
  name: string;
  /** Exact path, directory prefix (`dir/`), or glob with `*` / `**`. */
  pattern: string;
  severity?: ScoutSeverity;
  /** The owner's invariant. Blank or absent: one is generated. */
  invariant?: string;
  family?: ScoutProbeFamily;
  probeKind?: ScoutProbeKind;
}

/** Everything a candidate may be grounded in. Ids and short text only — no diffs, no transcripts. */
export interface ScoutSignals {
  /** The ref/SHA being exercised. */
  candidateRef: string;
  /** The ref the previous Scout run exercised, if any. */
  priorRef?: string | null;
  /** Paths changed between `priorRef` and `candidateRef`. */
  changedPaths: string[];
  /** Recent tasks/PRs and where their review stands. */
  recentWork?: Array<{ ref: string; title: string; reviewState?: 'changes_requested' | 'escalated' | 'approved' | 'none'; paths?: string[] }>;
  failures?: Array<{ signature: string; count: number; paths?: string[] }>;
  /** Recall entries; only those touching a changed path are relevant. */
  recall?: Array<{ ref: string; type: string; title: string; paths?: string[] }>;
  specDiscrepancies?: Array<{ ref: string; direction: 'spec_ahead' | 'code_ahead' | 'contradicted'; summary: string; paths?: string[] }>;
  visualFindings?: Array<{ ref: string; route: string; severity: ScoutSeverity; summary: string }>;
  /** Readiness/release items whose status moved since the prior run. */
  readinessChanges?: Array<{ itemId: string; from: string; to: string }>;
  criticalPaths?: ScoutCriticalPath[];
  /** Earlier Scout findings; only high/critical ones are re-checked. */
  priorFindings?: Array<{ signature: string; severity: ScoutSeverity; family: ScoutProbeFamily; invariant: string; paths?: string[] }>;
}

export interface ScoutSourceSignal {
  type: ScoutSignalType;
  ref: string;
}

export interface ScoutProbeCandidate {
  /** Stable across runs: a hash of family, probe kind and anchor. */
  id: string;
  family: ScoutProbeFamily;
  probeKind: ScoutProbeKind;
  title: string;
  hypothesis: string;
  /** Declared before execution; what a pass must demonstrate. */
  invariant: string;
  grounding: ScoutGrounding;
  sourceSignals: ScoutSourceSignal[];
  /** What the hypothesis is about; candidates sharing one are near-duplicates. */
  anchor: string;
  paths: string[];
  touchesChangedPaths: boolean;
  severity: ScoutSeverity;
  /** Times the grounding failure was seen recently (0 when not failure-grounded). */
  priorFailures: number;
  /** Capability kinds that could execute it, in preference order. */
  preconditions: ScoutCapabilityKind[];
  /** The capability id chosen to execute it, or null. */
  executor: string | null;
  supported: boolean;
  unsupportedReason?: string;
  estimatedCost: ScoutCost;
  evidenceRequirements: string[];
}

export interface ScoutCandidateOptions {
  /** Cap on the candidate set. Default `DEFAULT_MAX_CANDIDATES`, clamped to [1, `MAX_CANDIDATES`]. */
  maxCandidates?: number;
}

export interface ScoutCandidateSet {
  candidates: readonly ScoutProbeCandidate[];
  /** Candidates generated but cut by the cap. */
  truncated: number;
  /** Distinct changed paths considered. */
  changedFiles: number;
  warnings: string[];
}

export const DEFAULT_MAX_CANDIDATES = 24;
export const MAX_CANDIDATES = 100;
const MAX_SIGNALS_PER_SOURCE = 200;
const MAX_CHANGED_PATHS = 5_000;
const MAX_PATHS_PER_CANDIDATE = 20;
const MAX_TITLE = 160;
const MAX_TEXT = 400;

export const SEVERITY_RANK: Record<ScoutSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Evidence each probe kind requires. The executors (`./executors.ts`) map these keys to what they can supply. */
export const SCOUT_EVIDENCE_REQUIREMENTS: Readonly<Record<ScoutProbeKind, readonly string[]>> = {
  route_smoke: ['Status and rendered output for each exercised route.'],
  api_contract: ['Request and response for each exercised call, or command output with exit code.'],
  visual: ['Phone- and desktop-width captures of each affected route.'],
  spec_invariant: ['The declared contract and the shipped behaviour it was checked against.'],
  regression: ['Output of the exercised command or journey at the candidate ref.'],
  security_boundary: ['Request and response showing the boundary held or broke.'],
};

const FAMILY_PROBE_KIND: Record<ScoutProbeFamily, ScoutProbeKind> = {
  'state-transition': 'regression',
  surface: 'visual',
  contract: 'api_contract',
  persistence: 'spec_invariant',
  release: 'spec_invariant',
};

const FAMILY_PRECONDITIONS: Record<ScoutProbeFamily, ScoutCapabilityKind[]> = {
  'state-transition': ['api-journey', 'cli-journey', 'verification-command'],
  surface: ['ui-surface'],
  contract: ['api-journey', 'cli-journey', 'verification-command'],
  persistence: ['migrations', 'verification-command'],
  release: ['release', 'verification-command', 'build-command'],
};

const EXECUTOR_COST: Partial<Record<ScoutCapabilityKind, ScoutCost>> = {
  'ui-surface': 'high',
  'verification-command': 'medium',
  'build-command': 'medium',
  'typecheck-command': 'medium',
};

const PERSISTENCE_PATH = /(^|\/)(migrations?|drizzle|alembic|db\/migrate)(\/|$)|\.sql$|(^|\/)schema\.(ts|prisma|sql|rb|py)$/i;
const UI_PATH = /\.(tsx|jsx|vue|svelte|html?|css|scss|astro|erb|hbs)$|(^|\/)(components?|pages|views|templates|screens|ui)\//i;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

const quote = (s: string) => `"${clip(s, 80)}"`;

const nonBlank = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;

function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Does `path` fall under `pattern`? Exact, `dir/` prefix, bare-directory prefix, or `*`/`**` glob. */
export function matchesPathPattern(path: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.includes('*')) return globToRegExp(pattern).test(path);
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  return path === pattern || path.startsWith(`${pattern}/`);
}

/** The changed area a path belongs to: its directory, at most two segments deep. */
function areaOf(path: string): string {
  const dirs = path.split('/').slice(0, -1);
  return dirs.length === 0 ? '.' : dirs.slice(0, 2).join('/');
}

function boundPaths(paths: readonly string[] | undefined): string[] {
  if (!paths) return [];
  return [...new Set(paths.filter(nonBlank).map((p) => p.trim()))].sort().slice(0, MAX_PATHS_PER_CANDIDATE);
}

function candidateId(family: ScoutProbeFamily, probeKind: ScoutProbeKind, anchor: string): string {
  return `sc_${createHash('sha256').update(`${family}|${probeKind}|${anchor}`).digest('hex').slice(0, 12)}`;
}

function resolveExecutor(
  preconditions: readonly ScoutCapabilityKind[],
  profile: ScoutCapabilityProfile,
): { executor: ScoutCapability | null; reason?: string } {
  for (const kind of preconditions) {
    const usable = profile.capabilities.find((c) => c.kind === kind && c.usable);
    if (usable) return { executor: usable };
  }
  const blocked = preconditions
    .map((kind) => profile.capabilities.find((c) => c.kind === kind))
    .find((c): c is ScoutCapability => !!c);
  return {
    executor: null,
    reason: blocked
      ? `${blocked.id}: ${blocked.blockedReason ?? 'not usable'}`
      : `No capability of kind ${preconditions.join(' / ')} is declared or detected.`,
  };
}

// ─── Generation ──────────────────────────────────────────────────────────────

interface Draft {
  family: ScoutProbeFamily;
  probeKind?: ScoutProbeKind;
  preconditions?: ScoutCapabilityKind[];
  title: string;
  hypothesis: string;
  invariant: string;
  grounding: ScoutGrounding;
  signal: ScoutSourceSignal;
  anchor: string;
  paths: string[];
  severity: ScoutSeverity;
  priorFailures?: number;
}

export function generateScoutCandidates(
  signals: ScoutSignals,
  profile: ScoutCapabilityProfile,
  options: ScoutCandidateOptions = {},
): ScoutCandidateSet {
  const warnings: string[] = [];
  const max = Math.min(Math.max(Math.floor(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES), 1), MAX_CANDIDATES);
  const ref = clip(signals.candidateRef || 'the candidate ref', 64);
  const take = <T>(list: readonly T[] | undefined): T[] => (list ?? []).slice(0, MAX_SIGNALS_PER_SOURCE);

  const changed = [...new Set((signals.changedPaths ?? []).filter(nonBlank).map((p) => p.trim()))].sort().slice(0, MAX_CHANGED_PATHS);
  const touches = (paths: readonly string[]) => paths.some((p) => changed.some((c) => matchesPathPattern(c, p)));
  const drafts: Draft[] = [];

  // Changed areas.
  const areas = new Map<string, string[]>();
  for (const p of changed) {
    const a = areaOf(p);
    areas.set(a, [...(areas.get(a) ?? []), p]);
  }
  for (const [area, files] of areas) {
    const persistence = files.filter((f) => PERSISTENCE_PATH.test(f));
    const ui = profile.hasUi !== 'no' ? files.filter((f) => UI_PATH.test(f)) : [];
    const rest = files.filter((f) => !PERSISTENCE_PATH.test(f));
    const signal = { type: 'change' as const, ref: area };
    if (persistence.length > 0) {
      drafts.push({
        family: 'persistence',
        title: `Persistence changes in ${area}`,
        hypothesis: `A schema or migration change in ${area} may have shipped without a matching migration, out of order, or with read/write paths that disagree with the new shape.`,
        invariant: `Every schema change under ${area} ships with an ordered migration, and reads and writes agree with the new shape at ${ref}.`,
        grounding: 'change', signal, anchor: area, paths: persistence, severity: 'high',
      });
    }
    if (ui.length > 0) {
      drafts.push({
        family: 'surface',
        title: `Surfaces rendering ${area}`,
        hypothesis: `A change in ${area} may break a route that renders it, in a state nobody declared (empty, error, loading, narrow width).`,
        invariant: `Every route rendering what changed under ${area} renders without error at phone and desktop width, in empty and populated states, at ${ref}.`,
        grounding: 'change', signal, anchor: area, paths: ui, severity: 'medium',
      });
    }
    if (rest.length > 0) {
      drafts.push({
        family: 'contract',
        title: `Contracts exposed by ${area}`,
        hypothesis: `Behaviour exposed by ${area} (API, CLI or verified behaviour) may have changed in a way no declared check covers.`,
        invariant: `The workspace's declared journeys and verification over ${area} succeed with their documented outcomes at ${ref}.`,
        grounding: 'change', signal, anchor: area, paths: rest, severity: 'medium',
      });
    }
  }

  // Reviewer state on recent work.
  for (const w of take(signals.recentWork)) {
    if (!nonBlank(w.ref) || (w.reviewState !== 'changes_requested' && w.reviewState !== 'escalated')) continue;
    const paths = boundPaths(w.paths);
    drafts.push({
      family: 'state-transition',
      title: `Reviewer concern on ${w.ref} after the fix`,
      hypothesis: `A reviewer ${w.reviewState === 'escalated' ? 'escalated' : 'requested changes on'} ${w.ref} (${quote(w.title)}); the fix may not hold once later work landed on top.`,
      invariant: `The concern raised on ${w.ref} does not reproduce at ${ref}, and the reviewed state is the one that ships.`,
      grounding: 'history', signal: { type: 'review', ref: w.ref }, anchor: `review:${w.ref}`, paths,
      severity: w.reviewState === 'escalated' ? 'high' : 'medium',
    });
  }

  // Failure signatures.
  for (const f of take(signals.failures)) {
    if (!nonBlank(f.signature)) continue;
    const count = Number.isFinite(f.count) && f.count > 0 ? Math.floor(f.count) : 0;
    drafts.push({
      family: 'contract',
      probeKind: 'regression',
      preconditions: ['verification-command', 'cli-journey', 'api-journey'],
      title: `Recurring failure ${clip(f.signature, 80)}`,
      hypothesis: `Failure ${quote(f.signature)} was seen ${count} time(s) recently; it may recur at ${ref}. Past occurrences are not proof it still does.`,
      invariant: `Failure ${quote(f.signature)} does not occur when the affected behaviour is exercised at ${ref}.`,
      grounding: 'history', signal: { type: 'failure', ref: clip(f.signature, 120) }, anchor: `failure:${f.signature}`,
      paths: boundPaths(f.paths), severity: count >= 5 ? 'high' : 'medium', priorFailures: count,
    });
  }

  // Recall history relevant to what changed.
  for (const r of take(signals.recall)) {
    const paths = boundPaths(r.paths);
    if (!nonBlank(r.ref) || paths.length === 0 || !touches(paths)) continue;
    drafts.push({
      family: 'contract',
      probeKind: 'regression',
      preconditions: ['verification-command', 'cli-journey', 'api-journey'],
      title: `Known ${clip(r.type, 20)} near changed code: ${clip(r.title, 100)}`,
      hypothesis: `A recorded ${clip(r.type, 20)} (${quote(r.title)}) touches code that changed; the change may have reintroduced it.`,
      invariant: `The behaviour described by ${r.ref} (${quote(r.title)}) does not reproduce at ${ref}.`,
      grounding: 'history', signal: { type: 'recall', ref: r.ref }, anchor: `recall:${r.ref}`, paths, severity: 'medium',
    });
  }

  // Spec discrepancies. code_ahead is undocumented-but-shipped: a docs gap, not a defect hypothesis.
  for (const d of take(signals.specDiscrepancies)) {
    if (!nonBlank(d.ref) || d.direction === 'code_ahead') continue;
    drafts.push({
      family: 'contract',
      probeKind: 'spec_invariant',
      preconditions: ['spec', 'verification-command'],
      title: `Spec vs shipped: ${clip(d.summary, 120)}`,
      hypothesis: `The spec and the shipped behaviour may disagree (${d.direction === 'contradicted' ? 'contradicted' : 'spec ahead of code'}): ${quote(d.summary)}.`,
      invariant: `Shipped behaviour at ${ref} matches the spec clause behind ${d.ref}.`,
      grounding: 'history', signal: { type: 'spec', ref: d.ref }, anchor: `spec:${d.ref}`, paths: boundPaths(d.paths),
      severity: d.direction === 'contradicted' ? 'high' : 'medium',
    });
  }

  // Visual-audit findings.
  for (const v of take(signals.visualFindings)) {
    if (!nonBlank(v.ref) || !nonBlank(v.route)) continue;
    drafts.push({
      family: 'surface',
      title: `Visual finding on ${clip(v.route, 80)}`,
      hypothesis: `A visual audit flagged ${clip(v.route, 80)}: ${quote(v.summary)}. It may still show, or the fix may have moved it.`,
      invariant: `${clip(v.route, 80)} no longer shows ${quote(v.summary)} at phone or desktop width at ${ref}.`,
      grounding: 'history', signal: { type: 'visual', ref: v.ref }, anchor: `route:${v.route}`, paths: [],
      severity: v.severity in SEVERITY_RANK ? v.severity : 'medium',
    });
  }

  // Readiness / release changes.
  for (const c of take(signals.readinessChanges)) {
    if (!nonBlank(c.itemId) || c.from === c.to) continue;
    const regressed = c.from === 'detected' && (c.to === 'missing' || c.to === 'unknown');
    drafts.push({
      family: 'release',
      title: `Readiness change: ${clip(c.itemId, 60)} ${clip(c.from, 20)} → ${clip(c.to, 20)}`,
      hypothesis: `Readiness item ${c.itemId} moved from ${c.from} to ${c.to}; what would ship may no longer match what was reviewed and tested.`,
      invariant: `Readiness item ${c.itemId} (${c.to}) is consistent with what would actually ship at ${ref}.`,
      grounding: 'change', signal: { type: 'readiness', ref: c.itemId }, anchor: `readiness:${c.itemId}`, paths: [],
      severity: regressed ? 'high' : 'low',
    });
  }

  // Configured critical paths the change touches.
  for (const cp of take(signals.criticalPaths)) {
    if (!nonBlank(cp.name) || !nonBlank(cp.pattern)) continue;
    const hit = changed.filter((p) => matchesPathPattern(p, cp.pattern.trim()));
    if (hit.length === 0) continue;
    let invariant = nonBlank(cp.invariant) ? cp.invariant : '';
    if (!invariant) {
      if (cp.invariant !== undefined) warnings.push(`critical path "${cp.name}" declares a blank invariant; a generated one is used.`);
      invariant = `Critical path ${quote(cp.name)} behaves as declared after the changes under ${cp.pattern} at ${ref}.`;
    }
    const family = cp.family ?? 'contract';
    drafts.push({
      family,
      probeKind: cp.probeKind,
      title: `Critical path ${clip(cp.name, 80)} touched`,
      hypothesis: `The change touches the declared critical path ${quote(cp.name)}; a break there is severe.`,
      invariant,
      grounding: 'config', signal: { type: 'critical-path', ref: clip(cp.name, 80) }, anchor: `critical:${cp.name}`,
      paths: hit, severity: cp.severity && cp.severity in SEVERITY_RANK ? cp.severity : 'high',
    });
  }

  // Prior severe Scout findings.
  for (const f of take(signals.priorFindings)) {
    if (!nonBlank(f.signature) || !nonBlank(f.invariant) || (f.severity !== 'critical' && f.severity !== 'high')) continue;
    drafts.push({
      family: f.family in FAMILY_PROBE_KIND ? f.family : 'contract',
      probeKind: 'regression',
      title: `Re-check prior ${f.severity} finding ${clip(f.signature, 60)}`,
      hypothesis: `An earlier Scout run found a ${f.severity} defect (${clip(f.signature, 60)}); later changes may have reintroduced it.`,
      invariant: f.invariant,
      grounding: 'history', signal: { type: 'prior-finding', ref: clip(f.signature, 120) }, anchor: `finding:${f.signature}`,
      paths: boundPaths(f.paths), severity: f.severity,
    });
  }

  // Draft → candidate, merging drafts that land on the same id.
  const byId = new Map<string, ScoutProbeCandidate>();
  for (const d of drafts) {
    const probeKind = d.probeKind ?? FAMILY_PROBE_KIND[d.family];
    const preconditions = d.preconditions ?? FAMILY_PRECONDITIONS[d.family];
    const id = candidateId(d.family, probeKind, d.anchor);
    const existing = byId.get(id);
    if (existing) {
      if (!existing.sourceSignals.some((s) => s.type === d.signal.type && s.ref === d.signal.ref)) existing.sourceSignals.push(d.signal);
      if (SEVERITY_RANK[d.severity] < SEVERITY_RANK[existing.severity]) existing.severity = d.severity;
      existing.priorFailures = Math.max(existing.priorFailures, d.priorFailures ?? 0);
      continue;
    }
    const paths = boundPaths(d.paths);
    const { executor, reason } = resolveExecutor(preconditions, profile);
    byId.set(id, {
      id,
      family: d.family,
      probeKind,
      title: clip(d.title, MAX_TITLE),
      hypothesis: clip(d.hypothesis, MAX_TEXT),
      invariant: clip(d.invariant, MAX_TEXT),
      grounding: d.grounding,
      sourceSignals: [d.signal],
      anchor: clip(d.anchor, MAX_TITLE),
      paths,
      touchesChangedPaths: d.signal.type === 'change' ? paths.length > 0 : touches(paths),
      severity: d.severity,
      priorFailures: d.priorFailures ?? 0,
      preconditions: [...preconditions],
      executor: executor?.id ?? null,
      supported: executor !== null,
      ...(reason && !executor ? { unsupportedReason: clip(reason, MAX_TEXT) } : {}),
      estimatedCost: executor ? (EXECUTOR_COST[executor.kind] ?? 'low') : 'medium',
      evidenceRequirements: [...SCOUT_EVIDENCE_REQUIREMENTS[probeKind]],
    });
  }

  const ordered = [...byId.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      Number(b.touchesChangedPaths) - Number(a.touchesChangedPaths) ||
      b.priorFailures - a.priorFailures ||
      b.paths.length - a.paths.length ||
      a.id.localeCompare(b.id),
  );
  const kept = ordered.slice(0, max).map((c) =>
    Object.freeze({
      ...c,
      sourceSignals: Object.freeze(c.sourceSignals.map((s) => Object.freeze({ ...s }))),
      paths: Object.freeze([...c.paths]),
      preconditions: Object.freeze([...c.preconditions]),
      evidenceRequirements: Object.freeze([...c.evidenceRequirements]),
    }) as ScoutProbeCandidate,
  );

  return { candidates: Object.freeze(kept), truncated: ordered.length - kept.length, changedFiles: changed.length, warnings };
}

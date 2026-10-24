import { createHash } from 'node:crypto';
import {
  criterionVerificationCoverage, criterionVerificationScenarios, toRegisteredBinding, REGISTERED_VERIFIER_REGISTRY,
  type CriterionVerification, type RegisteredBinding, type VerificationScenario,
} from '@buildd/spec-contract/verification-bindings';
import type { VerificationResult, VerificationVerdict } from '@buildd/core/verification-check';
import type { BuilddDecisionScope } from '@buildd/core/decision-policy';
import {
  bindingFingerprint, criterionBindings, type VerificationBinding, type VerifierIdentity, type VerifierRegistry,
} from '@buildd/spec-contract/verification-bindings';
import { criterionRecords } from '@buildd/spec-contract/criterion-records';
import {
  UI_ACTION_STATE_VERIFIER, evaluateUiSurface, parseUiEvidence, surfaceFromUiEvidence,
  type UiCopyFeatures, type UiEvidenceCapability, type UiModelDecision, type UiSurfaceOutcome,
} from '@buildd/core/ui-verification';
import { registeredAuthor, type RegisteredMethod } from './registered-author';

/**
 * One coordinator for registered `verify:` checks (spec "Registered
 * requirement verification", r1): an explicit request, a mission's final
 * verification and (later) PR events all run through dispatchRegisteredVerification.
 *
 * The server resolves everything that decides a verdict: the subject and its
 * immutable revision body, scope, head, evidence and evaluator. A request
 * names a task and, optionally, a stored evidence artifact; nothing else.
 *
 * Evidence comes from an independent collector (./registered-verification-store.ts
 * admits only a mission [surface audit]'s own capture), never from the request.
 * Refused evidence (forged, foreign, stale) is reported and records nothing, so
 * a bad reference cannot knock down a standing result. Missing evidence and
 * transient failures (provider, budget, a held reservation) also record nothing:
 * the criterion stays missing or keeps its last result, and never reads as a pass.
 *
 * Coverage: a binding judges the captures its criterion declares on a
 * `scenarios:` line (scenario at viewport). A pass certifies the criterion
 * only when every declared capture was judged; a partial set, or a binding
 * that declares none (a revision stored before declarations were required),
 * reports what is missing and records nothing. A failing capture still fails
 * the binding. A model is not asked about an incomplete set at all.
 *
 * Only deterministic runs are cached, by an identity that covers subject,
 * revision, wording, binding, declared captures, evaluator, head and every
 * judged capture. Model judgments are never served from a cache: the broker
 * resolves team policy on every call, and we cannot yet prove that policy
 * unchanged. An automatic trigger (`trigger: 'event'`: a PR event, a capture
 * arriving) does not re-ask a model whose identical run is already the
 * standing row; an explicit request always asks again.
 */

export const MAX_REGISTERED_SURFACES = 8;

export type RegisteredSubjectKind = 'task' | 'mission';
export interface RegisteredSubject {
  kind: RegisteredSubjectKind;
  /** The task the request named: the governed task, or a mission's final verification task. */
  taskId: string;
  /** The governed task (task path) or mission (mission path) the verdict is about. */
  subjectId: string;
  workspaceId: string;
  teamId: string;
  missionId?: string;
  specRevisionId: string;
  headSha: string;
  body: string;
  /** In-scope, unwaived criteria. */
  criterionIds: string[];
  criterionHashes: ReadonlyMap<string, string>;
}

/** One admitted capture, produced by the store's collector, never by a request. */
export interface CollectedSurface {
  input: unknown;
  /** Stable identity of the stored capture: `<artifact id>:<content sha256>`. */
  ref: string;
  /** Where it came from, for the record: not part of the identity (the same body at a later revision replays). */
  provenance: { artifactId: string; revision: number; auditTaskId: string; captureSha: string };
  /** Canonical fingerprint of the capture as stored (normalized evidence when it parses). */
  fingerprint: string;
  /** Which declared capture this is. A surface without one matches no declaration. */
  scenario?: VerificationScenario;
}
export interface RefusedSurface { ref: string; reason: string }
export interface Collection {
  admitted: CollectedSurface[];
  refused: RefusedSurface[];
  /** Set when collection itself could not finish (GitHub unreachable, ...). Nothing is recorded. */
  error?: string;
}

export { registeredAuthor, type RegisteredMethod };
export interface RegisteredRun {
  criterionId: string;
  bindingId: RegisteredBinding['id'];
  bindingFingerprint: string;
  inputFingerprint: string;
  evaluatorVersion: string;
  runKey: string;
  headSha: string;
  verdict: VerificationVerdict;
  method: RegisteredMethod;
  recordedBy: string;
  observed: string | null;
  decisionRecordIds: string[];
  receipts: unknown[];
  evidence: unknown[];
  evidenceRefs: string[];
  /** Set when this record replays an earlier identical deterministic run. */
  replayOf?: string;
  /** Set when this run took over a reservation an abandoned run left behind. */
  recoveredReservation?: boolean;
  /** The captures the criterion declares (`scenario@viewport`). */
  scenarios?: string[];
  /** Declared captures this run did not see: set only on a fail, which one failing capture decides. */
  missing?: string[];
  /** Findings on the judged captures, each linked to its capture's element ids. */
  findings?: Array<Record<string, unknown>>;
  /** Capabilities every judged capture was actually inspected for. */
  inspected?: UiEvidenceCapability[];
  coverage?: UiSurfaceOutcome['coverage'];
  /** The model, prompt and policy each decision ran under (model runs only). */
  evaluators?: Array<NonNullable<UiSurfaceOutcome['evaluator']>>;
  /** The planned run this records (planRegisteredChecks): what reusablePass and the verdict record answer to. */
  plan?: { key: string; fingerprint: string; verifier: VerifierIdentity; profile: VerifierIdentity; subject: PlannedSubject };
}
export interface Execution {
  result: VerificationResult;
  method: RegisteredMethod;
  inputFingerprint: string | null;
  decisionRecordIds: string[];
  receipts: unknown[];
  findings?: UiSurfaceOutcome['findings'];
  inspected?: UiEvidenceCapability[];
  coverage?: UiSurfaceOutcome['coverage'];
  evaluator?: UiSurfaceOutcome['evaluator'];
}
/** What a check is judged against, beyond the capture: the binding's profile and the criterion's words. */
export interface ExecutionContext {
  profile: UiCopyFeatures['profile'];
  criterion?: UiCopyFeatures['criterion'];
}
export interface Reservation { owner: string; recovered: boolean }
export interface CachedRun { verdictId: string; run: RegisteredRun; current: boolean }

export interface RegisteredVerificationDeps {
  load(taskId: string): Promise<RegisteredSubject | { error: string }>;
  collect(subject: RegisteredSubject, evidenceRef?: string): Promise<Collection>;
  evaluator(id: RegisteredBinding['id'], scope: BuilddDecisionScope): Promise<{ key: string; cacheable: boolean }>;
  /** The newest recorded run with this exact key in this subject, and whether it still stands for its binding. */
  cached(subject: RegisteredSubject, runKey: string): Promise<CachedRun | null>;
  /** Atomic: null while another live reservation holds the key. */
  reserve(subject: RegisteredSubject, runKey: string): Promise<Reservation | null>;
  release(subject: RegisteredSubject, runKey: string, owner: string): Promise<void>;
  execute(id: RegisteredBinding['id'], input: unknown, scope: BuilddDecisionScope, ctx: ExecutionContext): Promise<Execution>;
  /**
   * Revalidates subject, head, binding, captures and (when given) that the
   * reservation is still this run's, then appends a verdict row.
   */
  record(subject: RegisteredSubject, run: RegisteredRun, surfaces: readonly CollectedSurface[], lease?: Reservation & { runKey: string }): Promise<{ ok: true; verdictId: string } | { ok: false; reason: string }>;
}

export interface RegisteredResult {
  criterionId: string;
  bindingId: RegisteredBinding['id'];
  verdict: VerificationVerdict;
  method: RegisteredMethod;
  cached: boolean;
  recorded: boolean;
  reason?: string;
}
export interface RegisteredVerification {
  results: RegisteredResult[];
  coverage: ReturnType<typeof criterionVerificationCoverage>;
  refused: RefusedSurface[];
  reason?: string;
}

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x)).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}
export const sha256 = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');

/** Identity of one run. Workspace is part of it, so a key never matches across tenants. */
export function registeredRunKey(s: RegisteredSubject, c: CriterionVerification, evaluatorKey: string, inputFingerprint: string, scenarios: readonly string[] = []): string {
  return sha256({
    workspace: s.workspaceId, subject: `${s.kind}:${s.subjectId}`, revision: s.specRevisionId, criterion: c.criterionId,
    words: s.criterionHashes.get(c.criterionId) ?? null, binding: c.fingerprint, head: s.headSha.toLowerCase(),
    evaluator: evaluatorKey, input: inputFingerprint, ...(scenarios.length ? { scenarios } : {}),
  });
}

export const scenarioKey = (x: VerificationScenario) => `${x.scenarioId}@${x.viewport}`;

/** The surfaces a binding judges and the declared captures none of them supplies. Pure. */
export function bindingCoverage(declared: readonly VerificationScenario[], surfaces: readonly CollectedSurface[]): { judged: CollectedSurface[]; missing: string[] } {
  const wanted = new Set(declared.map(scenarioKey));
  const judged = surfaces.filter((e) => e.scenario && wanted.has(scenarioKey(e.scenario)));
  const seen = new Set(judged.map((e) => scenarioKey(e.scenario!)));
  return { judged, missing: declared.map(scenarioKey).filter((k) => !seen.has(k)) };
}

const SHA40 = /^[0-9a-f]{40}$/i;

/** Who collected and who records production runs: the store admits only an independent audit's own captures. */
const AUDITOR = 'visual_verifier';
export const REGISTERED_RECORDER = { kind: 'harness', id: 'registered-verification' } as const;

/** The judged captures as one stamped snapshot: its fingerprint is the run's input identity. */
function stampedSet(s: RegisteredSubject, set: readonly CollectedSurface[]): StampedEvidence {
  const snapshot = set.map((e) => ({ ref: e.ref, fingerprint: e.fingerprint }));
  return {
    workspaceId: s.workspaceId, targetSha: s.headSha.toLowerCase(),
    collectedBy: { kind: AUDITOR, id: [...new Set(set.map((e) => e.provenance.auditTaskId))].join(',') },
    snapshot, fingerprint: evidenceFingerprint(snapshot),
  };
}

/** A stored production run as the shared outcome (toVerdictRecord, reusablePass, registeredMissionRow read this). */
export function storedOutcome(s: Pick<RegisteredSubject, 'specRevisionId'>, run: RegisteredRun, collectedBy?: Actor): RegisteredOutcome | null {
  if (!run.plan) return null;
  return {
    criterionId: run.criterionId, subject: run.plan.subject, specRevisionId: s.specRevisionId, targetSha: run.headSha.toLowerCase(),
    verdict: run.verdict, method: run.method, authoritative: true, coverage: run.coverage ?? 'partial', findings: run.findings ?? [],
    fingerprint: run.plan.fingerprint, key: run.plan.key,
    provenance: {
      verifier: run.plan.verifier, profile: run.plan.profile, specRevisionId: s.specRevisionId, targetSha: run.headSha.toLowerCase(),
      evidenceFingerprint: run.inputFingerprint, collectedBy: collectedBy ?? { kind: AUDITOR, id: 'stored' }, recordedBy: REGISTERED_RECORDER,
      inspected: run.inspected ?? [], ...(run.evaluators?.[0] ? { evaluator: run.evaluators[0] } : {}),
    },
  };
}

function aggregate(checks: readonly Execution[], bindingId: RegisteredBinding['id']): Pick<RegisteredRun, 'verdict' | 'method' | 'observed' | 'inspected' | 'coverage'> {
  const verdicts = checks.map((x) => x.result.verdict);
  const verdict: VerificationVerdict = verdicts.includes('fail') ? 'fail' : verdicts.includes('unsupported') ? 'unsupported'
    : verdicts.includes('inconclusive') ? 'inconclusive' : 'pass';
  // One method for the whole set: any surface that could not be judged by the
  // verifier's own method makes the run a fallback, never a deterministic or model pass.
  const own: RegisteredMethod = bindingId === 'ui.actions_match_state' ? 'deterministic' : 'model';
  const method: RegisteredMethod = checks.every((x) => x.method === own) ? own : 'fallback';
  const observed = checks.map((x) => x.result.observed || x.result.reason).filter(Boolean).join(' ').slice(0, 500) || null;
  // Only what every capture was inspected for: a capture judged on less narrows the claim, never widens it.
  const inspected = checks.reduce<UiEvidenceCapability[] | null>((acc, x) => {
    const mine = x.inspected ?? [];
    return acc === null ? [...mine] : acc.filter((c) => mine.includes(c));
  }, null) ?? [];
  const coverage: UiSurfaceOutcome['coverage'] = checks.every((x) => x.coverage === 'complete') ? 'complete'
    : checks.every((x) => x.coverage === 'absent') ? 'absent' : 'partial';
  return { verdict, method, observed, inspected, coverage };
}

export async function dispatchRegisteredVerification(
  opts: { taskId: string; headSha: string; evidenceRef?: string; trigger?: 'request' | 'event' },
  deps: RegisteredVerificationDeps,
): Promise<RegisteredVerification> {
  const results: RegisteredResult[] = [];
  const refused: RefusedSurface[] = [];
  const empty = (reason: string, coverage: RegisteredVerification['coverage'] = []): RegisteredVerification => ({ results, coverage, refused, reason });
  if (!SHA40.test(opts.headSha)) return empty('target must be a full commit SHA');
  const s = await deps.load(opts.taskId);
  if ('error' in s) return empty(s.error);
  if (s.headSha.toLowerCase() !== opts.headSha.toLowerCase()) return empty('the verification target is no longer current');

  let coverage: RegisteredVerification['coverage'];
  let plans: PlannedRegisteredCheck[];
  let declared: Map<string, VerificationScenario[]>;
  try {
    const inScope = new Set(s.criterionIds);
    coverage = criterionVerificationCoverage(s.body).filter((c) => inScope.has(c.criterionId));
    plans = planRegisteredChecks({
      subject: s.kind === 'mission' ? { kind: 'mission', missionId: s.subjectId } : { kind: 'task', taskId: s.subjectId },
      workspaceId: s.workspaceId, specRevisionId: s.specRevisionId, body: s.body,
      target: { headSha: s.headSha }, registry: REGISTERED_VERIFIER_REGISTRY, criteria: s.criterionIds,
    });
    declared = criterionVerificationScenarios(s.body);
  } catch {
    return empty('the revision contains an invalid verifier binding');
  }
  const bindings: CriterionVerification[] = plans.map((p) => ({ criterionId: p.criterionId, binding: toRegisteredBinding(p.binding)!, fingerprint: bindingFingerprint(p.binding) }));
  if (!bindings.length) return { results, coverage, refused };

  const collection = await deps.collect(s, opts.evidenceRef);
  refused.push(...collection.refused);
  const note = (c: CriterionVerification, verdict: VerificationVerdict, reason: string, method: RegisteredMethod = 'fallback') =>
    results.push({ criterionId: c.criterionId, bindingId: c.binding.id, verdict, method, cached: false, recorded: false, reason });
  if (collection.error) {
    for (const c of bindings) note(c, 'inconclusive', collection.error);
    return { results, coverage, refused, reason: collection.error };
  }
  // An explicitly named capture that is refused is the caller's answer, not
  // something to replace silently with other evidence.
  if (opts.evidenceRef && collection.refused.some((r) => r.ref.startsWith(opts.evidenceRef!))) {
    for (const c of bindings) note(c, 'inconclusive', 'the named evidence was refused');
    return { results, coverage, refused, reason: 'the named evidence was refused' };
  }
  const surfaces = [...collection.admitted].sort((a, b) => (a.ref < b.ref ? -1 : 1));
  if (!surfaces.length) {
    for (const c of bindings) note(c, 'inconclusive', 'no independent capture at the current target');
    return { results, coverage, refused };
  }
  if (surfaces.length > MAX_REGISTERED_SURFACES) {
    for (const c of bindings) note(c, 'inconclusive', `more than ${MAX_REGISTERED_SURFACES} captures; narrow the evidence`);
    return { results, coverage, refused };
  }

  const scope: BuilddDecisionScope = { teamId: s.teamId, workspaceId: s.workspaceId, taskId: s.taskId, missionId: s.missionId ?? null };
  for (const c of bindings) {
    const planned = plans.find((p) => p.criterionId === c.criterionId && bindingFingerprint(p.binding) === c.fingerprint)!;
    const verifier = REGISTERED_VERIFIER_REGISTRY.verifiers.find((v) => v.id === planned.binding.verifier.id && v.version === planned.binding.verifier.version)!;
    const uninspected = planned.binding.evidence.filter((capability) => !verifier.evidence.includes(capability));
    if (uninspected.length) {
      note(c, 'unsupported', `the selected verifier does not inspect declared evidence: ${uninspected.join(', ')}`);
      continue;
    }
    const wanted = declared.get(c.criterionId) ?? [];
    const { judged, missing } = bindingCoverage(wanted, surfaces);
    // Undeclared (an older revision): every admitted capture is judged, but none can certify a pass.
    const set = wanted.length ? judged : surfaces;
    const incomplete = !wanted.length ? 'the criterion declares no scenarios, so no set of captures is complete'
      : missing.length ? `no independent capture of ${missing.join(', ')} at the current target` : null;
    if (!set.length) { note(c, 'inconclusive', incomplete ?? 'no independent capture at the current target'); continue; }
    const deterministic = c.binding.id === 'ui.actions_match_state';
    // A model is never asked to judge part of what the criterion needs; a deterministic check
    // still runs, so a failing capture is seen.
    if (incomplete && !deterministic) { note(c, 'inconclusive', incomplete); continue; }
    const scenarios = wanted.map(scenarioKey);
    const stamped = stampedSet(s, set);
    const inputFingerprint = stamped.fingerprint;
    const ctx: ExecutionContext = { profile: planned.binding.profile, ...(planned.criterionText ? { criterion: { id: c.criterionId, text: planned.criterionText } } : {}) };
    const evaluator = await deps.evaluator(c.binding.id, scope);
    const runKey = registeredRunKey(s, c, evaluator.key, inputFingerprint, scenarios);
    if (!evaluator.cacheable && opts.trigger === 'event') {
      const standing = await deps.cached(s, runKey);
      if (standing?.current) {
        results.push({ criterionId: c.criterionId, bindingId: c.binding.id, verdict: standing.run.verdict, method: standing.run.method, cached: true, recorded: false, reason: 'an identical run is already the standing result' });
        continue;
      }
    }
    if (evaluator.cacheable) {
      const hit = await deps.cached(s, runKey);
      // A stored pass replays only as reusablePass allows (same run, same evidence); a stored fail at the same key stands.
      const reusable = hit?.run.verdict === 'pass' && !incomplete && !!reusablePass(storedOutcome(s, hit.run), planned, stamped);
      if (hit?.run.plan && (hit.run.verdict === 'fail' || reusable) && hit.run.method === 'deterministic') {
        let recorded = true;
        // A newer row for this binding superseded the identical run: replay it, without executing.
        if (!hit.current) {
          const replay = await deps.record(s, { ...hit.run, runKey, replayOf: hit.verdictId }, set);
          recorded = replay.ok;
        }
        results.push({ criterionId: c.criterionId, bindingId: c.binding.id, verdict: hit.run.verdict, method: hit.run.method, cached: true, recorded });
        continue;
      }
    }
    const lease = await deps.reserve(s, runKey);
    if (!lease) { note(c, 'inconclusive', 'an identical verification is already running'); continue; }
    try {
      const checks: Execution[] = [];
      try {
        for (const e of set) checks.push(await deps.execute(c.binding.id, e.input, scope, ctx));
      } catch (err) {
        note(c, 'inconclusive', `the verifier could not finish (${err instanceof Error ? err.message.slice(0, 120) : 'error'}); retry later`);
        continue;
      }
      const { verdict, method, observed, inspected, coverage: judged } = aggregate(checks, c.binding.id);
      // No model answer (provider down, budget, an abstention, a lost decision record): a transient
      // non-result. Record nothing, so the criterion keeps its last result rather than reading as unknown.
      if (method === 'fallback' && !deterministic) { note(c, 'inconclusive', `the model gave no result (${observed ?? 'no answer'}); nothing was recorded`); continue; }
      // A pass over an incomplete set certifies nothing: say what is missing, record nothing.
      if (incomplete && verdict !== 'fail') { note(c, 'inconclusive', incomplete, method); continue; }
      const run: RegisteredRun = {
        criterionId: c.criterionId, bindingId: c.binding.id, bindingFingerprint: c.fingerprint, inputFingerprint,
        evaluatorVersion: evaluator.key, runKey, headSha: s.headSha.toLowerCase(), verdict, method,
        recordedBy: registeredAuthor(c.binding.id, method), observed,
        decisionRecordIds: checks.flatMap((x) => x.decisionRecordIds), receipts: checks.flatMap((x) => x.receipts),
        evidence: checks.map((x, i) => ({ ref: set[i]!.ref, inputFingerprint: x.inputFingerprint, verdict: x.result.verdict, observed: x.result.observed ?? null })),
        evidenceRefs: set.map((e) => e.ref),
        findings: checks.flatMap((x, i) => (x.findings ?? []).map((f) => ({ ...f, ref: set[i]!.ref }))).slice(0, 64),
        inspected, coverage: judged,
        ...(checks.some((x) => x.evaluator) ? { evaluators: checks.flatMap((x) => (x.evaluator ? [x.evaluator] : [])) } : {}),
        plan: { key: planned.key, fingerprint: planned.fingerprint, verifier: planned.binding.verifier, profile: planned.binding.profile, subject: planned.subject },
        ...(lease.recovered ? { recoveredReservation: true } : {}),
        ...(scenarios.length ? { scenarios } : {}),
        ...(missing.length ? { missing } : {}),
      };
      const rec = await deps.record(s, run, set, { ...lease, runKey });
      results.push({ criterionId: c.criterionId, bindingId: c.binding.id, verdict: rec.ok ? verdict : 'inconclusive', method, cached: false, recorded: rec.ok, ...(rec.ok ? {} : { reason: rec.reason }) });
    } finally {
      await deps.release(s, runKey, lease.owner);
    }
  }
  return { results, coverage, refused };
}

/*
 * The registry-facing contract of the same coordinator (spec "Registered
 * requirement verification" r1, AC-1..AC-5): key=value `verify:` bindings
 * (@buildd/spec-contract/verification-bindings) planned per subject, revision,
 * binding and target, and evaluated over a stamped UI evidence snapshot. Pure:
 * no database, no network; the model call is a dependency the host supplies.
 *
 * The verifiers here are the stored coordinator's under registry names:
 * `ui.action-state@1` is the deterministic action/state check and `ui.copy@1`
 * the `buildd.ui_copy` decision kind. Profile `buildd-ui@1` is Buildd's own.
 */

export { REGISTERED_VERIFIER_REGISTRY };

export type PlannedSubject = { kind: 'task'; taskId: string } | { kind: 'mission'; missionId: string };

export interface PlannedRegisteredCheck {
  criterionId: string;
  criterionText: string;
  binding: VerificationBinding;
  method: 'deterministic' | 'model' | 'visual';
  subject: PlannedSubject;
  workspaceId: string;
  specRevisionId: string;
  targetSha: string;
  /** Revision + wording + complete binding: what the run judges, wherever it runs. */
  fingerprint: string;
  /** Fingerprint + subject + workspace + target: one run per key. */
  key: string;
}

/** One run per in-scope criterion with an accepted binding. Refused bindings are verificationCoverage's to report. */
export function planRegisteredChecks(input: {
  subject: PlannedSubject;
  workspaceId: string;
  specRevisionId: string;
  body: string;
  target: { headSha: string };
  registry: VerifierRegistry;
  criteria?: readonly string[];
}): PlannedRegisteredCheck[] {
  const words = new Map(criterionRecords(input.body).map((r) => [r.id, r.text]));
  const targetSha = input.target.headSha.toLowerCase();
  return criterionBindings(input.body, input.registry).bindings
    .filter((b) => !input.criteria || input.criteria.includes(b.criterionId))
    .map((binding) => {
      const verifier = input.registry.verifiers.find((v) => v.id === binding.verifier.id && v.version === binding.verifier.version)!;
      const criterionText = words.get(binding.criterionId) ?? '';
      const fingerprint = sha256({ revision: input.specRevisionId, words: criterionText, binding: bindingFingerprint(binding) });
      const key = sha256({ fingerprint, workspace: input.workspaceId, subject: input.subject, target: targetSha });
      return { criterionId: binding.criterionId, criterionText, binding, method: verifier.method, subject: input.subject, workspaceId: input.workspaceId, specRevisionId: input.specRevisionId, targetSha, fingerprint, key };
    });
}

/** The stamp the harness puts on a snapshot it collected. */
export const evidenceFingerprint = (snapshot: unknown): string => sha256(snapshot ?? null);

type Actor = { kind: string; id: string };
export interface StampedEvidence {
  workspaceId: string;
  targetSha: string;
  collectedBy: Actor;
  snapshot: unknown;
  fingerprint: string;
}
export type ModelDecision = UiModelDecision;
export interface EvaluateDeps {
  recordedBy: Actor;
  /** The `buildd.ui_copy` decision for these features, through the team's decision policy. */
  decide?: (features: UiCopyFeatures, run: PlannedRegisteredCheck) => Promise<ModelDecision>;
}
export interface RegisteredOutcome {
  criterionId: string;
  subject: PlannedSubject;
  specRevisionId: string;
  targetSha: string;
  verdict: 'pass' | 'fail' | 'inconclusive' | 'unsupported';
  /** How it was actually judged; `fallback` when the verifier's own method could not run. */
  method: PlannedRegisteredCheck['method'] | 'fallback';
  /** Collected and recorded by an independent harness or reviewer: a builder's own evidence is advice. */
  authoritative: boolean;
  coverage: 'complete' | 'partial' | 'absent';
  findings: Array<Record<string, unknown>>;
  fingerprint: string;
  key: string;
  provenance: {
    verifier: { id: string; version: number };
    profile: { id: string; version: number };
    specRevisionId: string;
    targetSha: string;
    evidenceFingerprint: string;
    collectedBy: Actor;
    recordedBy: Actor;
    /** What the evaluator actually looked at; a text-only model never lists pixels. */
    inspected: UiEvidenceCapability[];
    evaluator?: Extract<UiModelDecision, { ok: true }>['evaluator'];
  };
}

const INDEPENDENT = new Set(['harness', 'reviewer', AUDITOR, 'person']);
const CAPABILITY: Record<string, UiEvidenceCapability> = { 'ui.text': 'text', 'ui.actions': 'actions', 'ui.state': 'state', 'ui.pixels': 'pixels' };

/**
 * Judge one planned run on stamped evidence, with the production evaluator (evaluateUiSurface): the snapshot
 * is normalized to the canonical stored capture first, so a portable snapshot and a stored capture are judged
 * by the same code. Evidence from another workspace, for another target, or whose stamp does not match its
 * snapshot is refused and judges nothing. Missing, partial or unreadable evidence and an unavailable model are
 * inconclusive, never a pass.
 */
export async function evaluateRegisteredCheck(
  run: PlannedRegisteredCheck, evidence: StampedEvidence, deps: EvaluateDeps,
): Promise<{ ok: true; outcome: RegisteredOutcome } | { ok: false; reason: 'cross_workspace' | 'stale_evidence' | 'forged_evidence' }> {
  if (evidence.workspaceId !== run.workspaceId) return { ok: false, reason: 'cross_workspace' };
  if (evidence.targetSha.toLowerCase() !== run.targetSha) return { ok: false, reason: 'stale_evidence' };
  if (evidence.fingerprint !== evidenceFingerprint(evidence.snapshot)) return { ok: false, reason: 'forged_evidence' };
  const declared = run.binding.evidence.map((e) => CAPABILITY[e]).filter((c): c is UiEvidenceCapability => !!c);
  const base = {
    criterionId: run.criterionId, subject: run.subject, specRevisionId: run.specRevisionId, targetSha: run.targetSha,
    fingerprint: run.fingerprint, key: run.key,
    authoritative: INDEPENDENT.has(evidence.collectedBy.kind) && INDEPENDENT.has(deps.recordedBy.kind),
  };
  const provenance = (inspected: UiEvidenceCapability[], evaluator?: RegisteredOutcome['provenance']['evaluator']): RegisteredOutcome['provenance'] => ({
    verifier: run.binding.verifier, profile: run.binding.profile, specRevisionId: run.specRevisionId, targetSha: run.targetSha,
    evidenceFingerprint: evidence.fingerprint, collectedBy: evidence.collectedBy, recordedBy: deps.recordedBy, inspected,
    ...(evaluator ? { evaluator } : {}),
  });
  const inconclusive = (coverage: RegisteredOutcome['coverage'], finding: Record<string, unknown>) =>
    ({ ok: true as const, outcome: { ...base, method: 'fallback' as const, verdict: 'inconclusive' as const, coverage, findings: [finding], provenance: provenance([]) } });

  if (evidence.snapshot == null) return inconclusive('absent', { kind: 'no_evidence' });
  const parsed = parseUiEvidence(evidence.snapshot);
  if (!parsed.ok) return inconclusive('absent', { kind: 'invalid_evidence', reason: parsed.reason });
  const absent = declared.filter((c) => !parsed.capabilities.includes(c));
  if (absent.length) return inconclusive('partial', { kind: 'missing_evidence', capabilities: absent });
  const canonical = surfaceFromUiEvidence(parsed.evidence, { independent: INDEPENDENT.has(evidence.collectedBy.kind) });
  if (!canonical.ok) return inconclusive('partial', { kind: 'invalid_evidence', reason: canonical.reason });

  const id = run.binding.verifier.id === UI_ACTION_STATE_VERIFIER.id ? 'ui.actions_match_state' : 'ui.card_clarity';
  const decide = deps.decide;
  const out = await evaluateUiSurface(id, canonical.evidence, {
    profile: run.binding.profile, ...(run.criterionText ? { criterion: { id: run.criterionId, text: run.criterionText } } : {}),
  }, decide ? (features) => decide(features, run) : undefined);
  return { ok: true, outcome: {
    ...base, method: out.method, verdict: out.verdict as RegisteredOutcome['verdict'],
    coverage: out.coverage, findings: out.findings, provenance: provenance(out.inspected, out.evaluator),
  } };
}

/** A stored pass replays only for the identical run (binding, subject, target) on the identical evidence. */
export function reusablePass(previous: RegisteredOutcome | null, run: PlannedRegisteredCheck, evidence: StampedEvidence): RegisteredOutcome | null {
  if (!previous || previous.verdict !== 'pass' || !previous.authoritative) return null;
  if (previous.key !== run.key || previous.fingerprint !== run.fingerprint) return null;
  if (evidence.fingerprint !== evidenceFingerprint(evidence.snapshot) || previous.provenance.evidenceFingerprint !== evidence.fingerprint) return null;
  return previous;
}

/** The newest outcome of this exact run is current; every other outcome is history. */
export function currentResult(outcomes: readonly RegisteredOutcome[], run: PlannedRegisteredCheck): { current: RegisteredOutcome | null; history: RegisteredOutcome[] } {
  const mine = outcomes.filter((o) => o.key === run.key);
  const current = mine.length ? mine[mine.length - 1]! : null;
  return { current, history: outcomes.filter((o) => o !== current) };
}

/** The `spec_outcome_verdicts` input for an authoritative outcome; null for advice. A registered result is never a test result. */
export function toVerdictRecord(o: RegisteredOutcome) {
  if (!o.authoritative) return null;
  return {
    specRevisionId: o.specRevisionId,
    criterionId: o.criterionId,
    verdict: o.verdict,
    headSha: o.targetSha,
    source: 'review' as const,
    ...(o.subject.kind === 'task' ? { taskId: o.subject.taskId } : { missionId: o.subject.missionId }),
    evidence: {
      kind: 'registered' as const,
      method: o.method,
      verifier: o.provenance.verifier,
      profile: o.provenance.profile,
      coverage: o.coverage,
      fingerprint: o.fingerprint,
      evidenceFingerprint: o.provenance.evidenceFingerprint,
      inspected: o.provenance.inspected,
      findings: o.findings,
      ...(o.provenance.evaluator ? { evaluator: o.provenance.evaluator } : {}),
    },
  };
}

/**
 * The explicit MCP request: a governed task or mission and nothing else. No
 * prompt, and a builder may not ask for its own task to be graded.
 */
export function resolveVerificationRequest(input: { params: Record<string, unknown>; caller: { kind: string; taskId?: string } }):
  { ok: true; subject: PlannedSubject } | { ok: false; reason: 'arbitrary_prompt' | 'no_subject' | 'self_grading' } {
  const { params, caller } = input;
  if (Object.keys(params).some((k) => k !== 'taskId' && k !== 'missionId' && k !== 'evidenceRef')) return { ok: false, reason: 'arbitrary_prompt' };
  const taskId = typeof params.taskId === 'string' && params.taskId ? params.taskId : null;
  const missionId = typeof params.missionId === 'string' && params.missionId ? params.missionId : null;
  if (!taskId && !missionId) return { ok: false, reason: 'no_subject' };
  if (taskId && caller.kind === 'builder' && caller.taskId === taskId) return { ok: false, reason: 'self_grading' };
  return { ok: true, subject: taskId ? { kind: 'task', taskId } : { kind: 'mission', missionId: missionId! } };
}

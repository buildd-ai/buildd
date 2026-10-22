import { createHash } from 'node:crypto';
import {
  criterionVerifications, criterionVerificationCoverage, criterionVerificationScenarios,
  type CriterionVerification, type VerificationBinding, type VerificationScenario,
} from '@buildd/spec-contract/verification-bindings';
import type { VerificationResult, VerificationVerdict } from '@buildd/core/verification-check';
import type { BuilddDecisionScope } from '@buildd/core/decision-policy';
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
  bindingId: VerificationBinding['id'];
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
}
export interface Execution {
  result: VerificationResult;
  method: RegisteredMethod;
  inputFingerprint: string | null;
  decisionRecordIds: string[];
  receipts: unknown[];
}
export interface Reservation { owner: string; recovered: boolean }
export interface CachedRun { verdictId: string; run: RegisteredRun; current: boolean }

export interface RegisteredVerificationDeps {
  load(taskId: string): Promise<RegisteredSubject | { error: string }>;
  collect(subject: RegisteredSubject, evidenceRef?: string): Promise<Collection>;
  evaluator(id: VerificationBinding['id'], scope: BuilddDecisionScope): Promise<{ key: string; cacheable: boolean }>;
  /** The newest recorded run with this exact key in this subject, and whether it still stands for its binding. */
  cached(subject: RegisteredSubject, runKey: string): Promise<CachedRun | null>;
  /** Atomic: null while another live reservation holds the key. */
  reserve(subject: RegisteredSubject, runKey: string): Promise<Reservation | null>;
  release(subject: RegisteredSubject, runKey: string, owner: string): Promise<void>;
  execute(id: VerificationBinding['id'], input: unknown, scope: BuilddDecisionScope): Promise<Execution>;
  /**
   * Revalidates subject, head, binding, captures and (when given) that the
   * reservation is still this run's, then appends a verdict row.
   */
  record(subject: RegisteredSubject, run: RegisteredRun, surfaces: readonly CollectedSurface[], lease?: Reservation & { runKey: string }): Promise<{ ok: true; verdictId: string } | { ok: false; reason: string }>;
}

export interface RegisteredResult {
  criterionId: string;
  bindingId: VerificationBinding['id'];
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

function aggregate(checks: readonly Execution[], bindingId: VerificationBinding['id']): Pick<RegisteredRun, 'verdict' | 'method' | 'observed'> {
  const verdicts = checks.map((x) => x.result.verdict);
  const verdict: VerificationVerdict = verdicts.includes('fail') ? 'fail' : verdicts.includes('unsupported') ? 'unsupported'
    : verdicts.includes('inconclusive') ? 'inconclusive' : 'pass';
  // One method for the whole set: any surface that could not be judged by the
  // verifier's own method makes the run a fallback, never a deterministic or model pass.
  const own: RegisteredMethod = bindingId === 'ui.actions_match_state' ? 'deterministic' : 'model';
  const method: RegisteredMethod = checks.every((x) => x.method === own) ? own : 'fallback';
  const observed = checks.map((x) => x.result.observed || x.result.reason).filter(Boolean).join(' ').slice(0, 500) || null;
  return { verdict, method, observed };
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
  let bindings: CriterionVerification[];
  let declared: Map<string, VerificationScenario[]>;
  try {
    const inScope = new Set(s.criterionIds);
    coverage = criterionVerificationCoverage(s.body).filter((c) => inScope.has(c.criterionId));
    bindings = criterionVerifications(s.body).filter((c) => inScope.has(c.criterionId));
    declared = criterionVerificationScenarios(s.body);
  } catch {
    return empty('the revision contains an invalid verifier binding');
  }
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
    const inputFingerprint = sha256(set.map((e) => ({ ref: e.ref, fingerprint: e.fingerprint })));
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
      if (hit && (hit.run.verdict === 'fail' || (hit.run.verdict === 'pass' && !incomplete)) && hit.run.method === 'deterministic') {
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
        for (const e of set) checks.push(await deps.execute(c.binding.id, e.input, scope));
      } catch (err) {
        note(c, 'inconclusive', `the verifier could not finish (${err instanceof Error ? err.message.slice(0, 120) : 'error'}); retry later`);
        continue;
      }
      const { verdict, method, observed } = aggregate(checks, c.binding.id);
      // A pass over an incomplete set certifies nothing: say what is missing, record nothing.
      if (incomplete && verdict !== 'fail') { note(c, 'inconclusive', incomplete, method); continue; }
      const run: RegisteredRun = {
        criterionId: c.criterionId, bindingId: c.binding.id, bindingFingerprint: c.fingerprint, inputFingerprint,
        evaluatorVersion: evaluator.key, runKey, headSha: s.headSha.toLowerCase(), verdict, method,
        recordedBy: registeredAuthor(c.binding.id, method), observed,
        decisionRecordIds: checks.flatMap((x) => x.decisionRecordIds), receipts: checks.flatMap((x) => x.receipts),
        evidence: checks.map((x, i) => ({ ref: set[i]!.ref, inputFingerprint: x.inputFingerprint, verdict: x.result.verdict, observed: x.result.observed ?? null })),
        evidenceRefs: set.map((e) => e.ref),
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

import { createHash } from 'node:crypto';
import { criterionVerifications, criterionVerificationCoverage, type CriterionVerification } from '@buildd/spec-contract/verification-bindings';
import type { VerificationResult, VerificationVerdict } from '@buildd/core/verification-check';
import type { BuilddDecisionScope } from '@buildd/core/decision-policy';

export interface RegisteredSubject {
  taskId: string; workspaceId: string; teamId: string; missionId?: string;
  specRevisionId: string; headSha: string; body: string; criterionIds: string[];
  criterionHashes: ReadonlyMap<string, string>;
}
/** Produced by the independent collector, never accepted from a verification request. */
export interface CollectedSurface {
  input: unknown; workspaceId: string; subjectTaskId: string;
  independent: boolean; captureSha: string; ref: string;
}
export interface RegisteredRun {
  criterionId: string; bindingFingerprint: string; inputFingerprint: string; evaluatorVersion: string;
  runKey: string; headSha: string; verdict: VerificationVerdict; method: 'deterministic' | 'model' | 'fallback';
  recordedBy: string; observed: string | null; decisionRecordIds: string[]; receipts: unknown[];
  evidence: unknown; evidenceRefs: string[];
}
export interface RegisteredVerificationDeps {
  load(taskId: string): Promise<RegisteredSubject | null>;
  collect(subject: RegisteredSubject, evidenceRef?: string): Promise<CollectedSurface[]>;
  evaluator(id: CriterionVerification['binding']['id'], scope: BuilddDecisionScope): Promise<{ key: string; cacheable: boolean }>;
  cached(key: string): Promise<RegisteredRun | null>;
  reserve(key: string, subject: RegisteredSubject, run: RegisteredRun, cacheable: boolean): Promise<boolean>;
  execute(id: CriterionVerification['binding']['id'], input: unknown, scope: BuilddDecisionScope): Promise<{
    result: VerificationResult; method: RegisteredRun['method']; inputFingerprint: string | null;
    decisionRecordIds: string[]; receipts: unknown[];
  }>;
  record(subject: RegisteredSubject, run: RegisteredRun): Promise<boolean>;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => JSON.stringify(k) + ':' + canonical(x)).join(',') + '}';
  return JSON.stringify(v) ?? 'null';
}
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');

/** One coordinator for PR events, mission final verification and explicit MCP requests. */
export async function dispatchRegisteredVerification(
  opts: { taskId: string; headSha: string; evidenceRef?: string },
  supplied?: RegisteredVerificationDeps,
) {
  const deps = supplied ?? (await import('./registered-verification-store')).registeredVerificationDeps;
  const results: Array<{ criterionId: string; verdict: VerificationVerdict; method: RegisteredRun['method']; cached: boolean; recorded: boolean }> = [];
  const empty = (reason: string) => ({ results, coverage: [] as ReturnType<typeof criterionVerificationCoverage>, reason });
  if (!/^[a-f0-9]{40}$/i.test(opts.headSha)) return empty('target must be a full commit SHA');
  const s = await deps.load(opts.taskId);
  if (!s || s.headSha.toLowerCase() !== opts.headSha.toLowerCase()) return empty('the verification target is no longer current');
  const inScope = new Set(s.criterionIds);
  const coverage = criterionVerificationCoverage(s.body).filter(c => inScope.has(c.criterionId));
  const bindings = criterionVerifications(s.body).filter(c => inScope.has(c.criterionId));
  if (!bindings.length) return { results, coverage };
  const scope: BuilddDecisionScope = { teamId: s.teamId, workspaceId: s.workspaceId, taskId: s.taskId, missionId: s.missionId };
  const collected = await deps.collect(s, opts.evidenceRef);
  const trusted = collected.filter(e => e.independent && e.workspaceId === s.workspaceId && e.subjectTaskId === s.taskId
    && e.captureSha.toLowerCase() === s.headSha.toLowerCase());
  // A declaration judges the complete supplied set. Every surface must pass.
  // Collection is bounded by the host; no evidence is an explicit inconclusive.
  for (const c of bindings) {
    const evaluator = await deps.evaluator(c.binding.id, scope);
    const inputFingerprint = hash(trusted.map(e => ({ ref: e.ref, input: e.input })));
    const runKey = hash({ subject: s.missionId ?? s.taskId, revision: s.specRevisionId, criterion: c.criterionId,
      words: s.criterionHashes.get(c.criterionId), binding: c.fingerprint, head: s.headSha, inputFingerprint, evaluator: evaluator.key });
    if (evaluator.cacheable && trusted.length) {
      const cached = await deps.cached(runKey);
      if (cached && (cached.verdict === 'pass' || cached.verdict === 'fail')) {
        results.push({ criterionId: c.criterionId, verdict: cached.verdict, method: cached.method, cached: true, recorded: true });
        continue;
      }
    }
    const deterministic = c.binding.id === 'ui.actions_match_state';
    const run: RegisteredRun = {
      criterionId: c.criterionId, bindingFingerprint: c.fingerprint, inputFingerprint, evaluatorVersion: evaluator.key,
      runKey, headSha: s.headSha, verdict: 'inconclusive', method: deterministic ? 'deterministic' : 'fallback',
      recordedBy: `${deterministic ? 'check:registered:' : 'registered:'}${c.binding.id}`,
      observed: trusted.length ? 'Verification is in progress.' : 'No independent surface evidence at the current target.',
      decisionRecordIds: [], receipts: [], evidence: [], evidenceRefs: trusted.map(e => e.ref),
    };
    if (!await deps.reserve(runKey, s, run, evaluator.cacheable)) {
      results.push({ criterionId: c.criterionId, verdict: 'inconclusive', method: run.method, cached: false, recorded: false });
      continue;
    }
    if (trusted.length) {
      try {
        const checks = [];
        for (const e of trusted) checks.push(await deps.execute(c.binding.id, e.input, scope));
        const verdicts = checks.map(x => x.result.verdict);
        run.verdict = verdicts.includes('fail') ? 'fail' : verdicts.includes('unsupported') ? 'unsupported'
          : verdicts.includes('inconclusive') ? 'inconclusive' : 'pass';
        run.method = checks.some(x => x.method === 'fallback') ? 'fallback' : deterministic ? 'deterministic' : 'model';
        run.observed = checks.map(x => x.result.observed || x.result.reason).filter(Boolean).join(' ').slice(0, 500) || null;
        run.decisionRecordIds = checks.flatMap(x => x.decisionRecordIds);
        run.receipts = checks.flatMap(x => x.receipts);
        run.evidence = checks.map(x => ({ result: x.result, inputFingerprint: x.inputFingerprint }));
      } catch {
        run.verdict = 'inconclusive'; run.observed = 'The verifier could not finish; retry with current evidence.';
      }
    }
    const recorded = await deps.record(s, run);
    results.push({ criterionId: c.criterionId, verdict: recorded ? run.verdict : 'inconclusive', method: run.method, cached: false, recorded });
  }
  return { results, coverage };
}

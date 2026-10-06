/**
 * Post-session quality loop — Stage C, the selective deep analyser (artifact
 * `post-session-quality-loop-spec` §7, §8, §12).
 *
 * Runs only on runs triage selected (`state = 'triaged'`). It reads the Stage A
 * facts, the triage record, the completed-session transcript, the task's
 * stored run evidence and — when reconstructable — the knowledge the session
 * relied on, and turns them into a short list of structured findings.
 *
 * Mechanics come from the shared verification substrate
 * (`@buildd/core/verification-check`): every post-session invariant is a
 * `VerificationCheck`, so verdict semantics, evidence gating, signatures and
 * provenance are the same ones Quality Scout and Goal Criteria use. What stays
 * here is post-session policy: which invariants exist, which finding class and
 * proposed action a failure maps to, and how symptoms collapse into one root
 * cause.
 *
 * Rules this module keeps:
 *  - **Read-only.** Nothing here writes: not the run row, not the findings
 *    ledger, not memory, not tasks. It returns the analysis; persisting it and
 *    acting on it belong to the ledger/action-policy stage.
 *  - **Coverage truth.** A check that needs early-session evidence declares it.
 *    A trailing-only, absent or unread transcript makes that check
 *    `inconclusive`/`unsupported`, and only a `fail` becomes a finding. Missing
 *    evidence is not negative evidence.
 *  - **Bounded, no free text.** Titles and summaries are templates over enums
 *    and counts. No transcript content, file path, error text or PR body reaches
 *    a finding.
 *  - **One root cause over symptoms.** A failing check that is a known symptom
 *    of another failing check is folded into it (`relatedCheckIds`).
 *  - **Never throws.** Every outcome of `analysePostSessionRun` is a status.
 */

import type {
  FindingClass,
  FindingEvidenceRef,
  FindingProposedAction,
  FindingSeverity,
  PostSessionRunState,
  PostSessionTriageRecord,
  StageAFacts,
  TraceAvailability,
  TriageFocus,
} from '@buildd/core/post-session-quality';
import { SEVERE_ERROR_MIN_COUNT, SEVERE_ERROR_PATTERNS, CI_LOOP_MIN_FIX_ATTEMPTS, REVIEW_LOOP_MIN_REQUEST_CHANGES } from '@buildd/core/post-session-triage';
import {
  MAX_EVIDENCE_REFS,
  runVerificationCheck,
  severityRank,
  summarizeVerificationResults,
  verificationSignature,
  type EvidenceCoverage,
  type EvidenceRequirement,
  type VerificationObservation,
  type VerificationResult,
} from '@buildd/core/verification-check';
import type { CompletedSessionTranscript } from './session-transcript';

/** Bump when a check, its mapping or the root-cause rules change. */
export const POST_SESSION_ANALYSER_VERSION = 'psa1';
export const MAX_FINDINGS = 3;
export const MAX_TITLE_CHARS = 120;
export const MAX_SUMMARY_CHARS = 600;
const MAX_EVIDENCE_OBJECTS = 3;
const MAX_ERROR_CHARS = 500;
const FLAVOR = 'post_session_quality';

// ── Input ───────────────────────────────────────────────────────────────────

/**
 * A claim from knowledge the session retrieved, and the shipped-state evidence
 * that contradicts it (null = not contradicted). Supplied by the caller; the
 * analyser never queries memory itself.
 */
export interface KnowledgeClaim {
  sourceId: string;
  claim: string;
  contradictedBy: FindingEvidenceRef | null;
}

export interface PostSessionAnalysisInput {
  runId: string;
  facts: StageAFacts;
  focus: TriageFocus | null;
  hardTriggerReasons: string[];
  /** null = the transcript was not read at all (no reader / read threw). */
  transcript: CompletedSessionTranscript | null;
  /** The task's stored run evidence, newest first. null = could not be listed. */
  evidence: Array<{ id: string; kind: string }> | null;
  /** null = knowledge context not reconstructable for this session. */
  knowledge: { claims: KnowledgeClaim[] } | null;
}

// ── Output ──────────────────────────────────────────────────────────────────

export interface PostSessionQualityFinding {
  class: FindingClass;
  severity: FindingSeverity;
  confidence: number;
  title: string;
  evidenceRefs: FindingEvidenceRef[];
  signature: string;
  recurrenceKey: string;
  proposedAction: FindingProposedAction;
  summary: string;
  /** The verification check that produced it; `no_action` for the empty outcome. */
  checkId: string;
  /** Failing checks folded into this one as symptoms. */
  relatedCheckIds: string[];
}

/** Shape of the run row's trace columns, so the persisting stage can write it as-is. */
export interface PostSessionTraceCoverage {
  traceAvailability: TraceAvailability;
  traceSource: string | null;
  traceMissing: { portions: string[]; reason: string | null };
}

export interface PostSessionAnalysis {
  analyserVersion: string;
  focus: TriageFocus | null;
  coverage: PostSessionTraceCoverage;
  /** Every check's result, including passes and inconclusives — the history. */
  results: VerificationResult[];
  verdicts: ReturnType<typeof summarizeVerificationResults>;
  /** 1..MAX_FINDINGS; a single `no_action` finding when nothing failed. */
  findings: PostSessionQualityFinding[];
}

// ── Evidence & capabilities ─────────────────────────────────────────────────

const EARLY_GAPS = new Set(['early_tool_calls', 'unknown_coverage', 'malformed_records']);
const TAIL_GAPS = new Set(['tail', 'unknown_coverage', 'malformed_records']);

function transcriptCoverage(t: CompletedSessionTranscript | null, gaps: Set<string>): EvidenceCoverage {
  if (!t || t.traceAvailability === 'absent') return 'absent';
  if (t.traceAvailability === 'full') return 'complete';
  return t.missingPortions.some(p => gaps.has(p)) ? 'partial' : 'complete';
}

/** What evidence this run has, and how much of it. A source that was not read is `absent`. */
export function postSessionEvidenceCoverage(input: PostSessionAnalysisInput): Record<string, EvidenceCoverage> {
  const f = input.facts;
  return {
    'facts.outcome': 'complete',
    'facts.review': f.outcome.review ? 'complete' : 'absent',
    'facts.errors': f.errors ? 'complete' : 'absent',
    'facts.tools': f.behaviour.tools.known ? 'complete' : 'absent',
    'transcript.early_tool_calls': transcriptCoverage(input.transcript, EARLY_GAPS),
    'transcript.tail': transcriptCoverage(input.transcript, TAIL_GAPS),
    'evidence.objects': input.evidence ? 'complete' : 'absent',
    'knowledge.claims': input.knowledge ? 'complete' : 'absent',
  };
}

function capabilities(input: PostSessionAnalysisInput): string[] {
  const caps = ['stage_a_facts'];
  if (input.transcript) caps.push('transcript_reader');
  if (input.knowledge) caps.push('knowledge_claims');
  return caps;
}

// ── Checks (post-session policy) ────────────────────────────────────────────

interface PostSessionCheckSpec {
  id: string;
  invariant: string;
  title: string;
  class: FindingClass | ((input: PostSessionAnalysisInput) => FindingClass);
  proposedAction: FindingProposedAction;
  defaultSeverity: FindingSeverity;
  /** Used when the executor reports no confidence. */
  defaultConfidence: number;
  requires: string[];
  evidenceRequirements: EvidenceRequirement[];
  /** Root causes: when any of these fail too, this one is a symptom. */
  symptomOf: string[];
  run(input: PostSessionAnalysisInput): VerificationObservation;
}

const pass = (observed?: string): VerificationObservation => ({ verdict: 'pass', observed });
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const RECALL_TOOL = /(^|__)(recall|query_knowledge)$/;

function orderedToolNames(t: CompletedSessionTranscript): string[] {
  return t.records
    .filter(r => r.type === 'tool_call')
    .sort((a, b) => (a.seq as number) - (b.seq as number))
    .map(r => String((r.toolCall as { name?: unknown } | undefined)?.name ?? ''));
}

const CHECKS: PostSessionCheckSpec[] = [
  {
    id: 'success_has_shipping_evidence',
    invariant: 'A session recorded as a success on PR-required work shipped a PR',
    title: 'Session recorded as success without the PR its task required',
    class: 'platform',
    proposedAction: 'file_task',
    defaultSeverity: 'high',
    defaultConfidence: 0.9,
    requires: ['stage_a_facts'],
    evidenceRequirements: [{ key: 'facts.outcome', need: 'complete' }],
    symptomOf: ['output_contract_honoured'],
    run: ({ facts: { outcome: o } }) => {
      if (o.workerStatus !== 'completed' || o.taskStatus !== 'completed' || o.outputRequirement !== 'pr_required') return pass('not a PR-required success');
      return o.prCreated ? pass('PR present') : { verdict: 'fail', observed: 'worker and task completed; outputRequirement=pr_required; no PR recorded' };
    },
  },
  {
    id: 'merge_agrees_with_review',
    invariant: 'A merged PR was not rejected by review and its task did not fail or get abandoned',
    title: 'PR merged while review or task state said it should not ship',
    class: 'platform',
    proposedAction: 'file_task',
    defaultSeverity: 'high',
    defaultConfidence: 0.85,
    requires: ['stage_a_facts'],
    evidenceRequirements: [{ key: 'facts.outcome', need: 'complete' }],
    symptomOf: [],
    run: ({ facts: { outcome: o } }) => {
      if (!o.merged) return pass('not merged');
      const verdict = o.review?.latestVerdict ?? null;
      if (verdict === 'request-changes' || verdict === 'escalate') {
        return { verdict: 'fail', severity: 'critical', signatureParts: ['review_rejected'], observed: `merged; latest review verdict=${verdict}` };
      }
      if (o.taskStatus === 'failed' || o.prAbandoned) {
        return { verdict: 'fail', signatureParts: ['task_state'], observed: `merged; taskStatus=${o.taskStatus}; prAbandoned=${o.prAbandoned}` };
      }
      return pass('merged consistently');
    },
  },
  {
    id: 'output_contract_honoured',
    invariant: 'The output gate does not refuse a session that produced a PR or worktree changes',
    title: 'Output gate refused a session after it produced work',
    class: 'platform',
    proposedAction: 'file_task',
    defaultSeverity: 'high',
    defaultConfidence: 0.8,
    requires: ['stage_a_facts'],
    evidenceRequirements: [{ key: 'facts.outcome', need: 'complete' }],
    symptomOf: [],
    run: ({ facts: { outcome: o } }) => {
      if (!o.outputGateRefused) return pass('no refusal');
      if (!o.prCreated && !o.dirtyWorktree) return pass('refused with no work produced');
      return { verdict: 'fail', observed: `output gate refused; prCreated=${o.prCreated}; dirtyWorktree=${o.dirtyWorktree}` };
    },
  },
  {
    id: 'no_severe_runtime_error',
    invariant: 'No platform-level error pattern recurs within one session',
    title: 'Severe runtime error recurred during the session',
    class: 'environment',
    proposedAction: 'file_task',
    defaultSeverity: 'high',
    defaultConfidence: 0.85,
    requires: ['stage_a_facts'],
    evidenceRequirements: [{ key: 'facts.errors', need: 'complete' }],
    symptomOf: [],
    run: ({ facts }) => {
      const hit = facts.errors!.patterns
        .filter(p => SEVERE_ERROR_PATTERNS.includes(p.pattern) && p.count >= SEVERE_ERROR_MIN_COUNT)
        .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern))[0];
      if (!hit) return pass('no recurring severe pattern');
      return {
        verdict: 'fail',
        signatureParts: [hit.pattern],
        evidenceRefs: [{ kind: 'error_trace', ref: hit.pattern }],
        observed: `pattern=${hit.pattern}; count=${hit.count}`,
      };
    },
  },
  {
    id: 'review_converges',
    invariant: 'Review and CI converge without a fix loop',
    title: 'Review or CI needed a fix loop to converge',
    class: 'agent_use',
    proposedAction: 'adjust_guidance',
    defaultSeverity: 'medium',
    defaultConfidence: 0.5,
    requires: ['stage_a_facts'],
    evidenceRequirements: [{ key: 'facts.outcome', need: 'complete' }],
    symptomOf: ['no_severe_runtime_error', 'merge_agrees_with_review'],
    run: ({ facts: { outcome: o } }) => {
      const rc = o.review?.requestChangesCount ?? null;
      const ci = o.ciFixAttempts;
      if (rc === null && ci === null) return { verdict: 'inconclusive', observed: 'review and CI-fix history unread' };
      if (rc !== null && rc >= REVIEW_LOOP_MIN_REQUEST_CHANGES) {
        return { verdict: 'fail', signatureParts: ['review'], observed: `requestChanges=${rc}` };
      }
      if (ci !== null && ci >= CI_LOOP_MIN_FIX_ATTEMPTS) {
        return { verdict: 'fail', signatureParts: ['ci'], observed: `ciFixAttempts=${ci}` };
      }
      return pass(`requestChanges=${rc ?? 'unknown'}; ciFixAttempts=${ci ?? 'unknown'}`);
    },
  },
  {
    id: 'review_not_escalated',
    invariant: 'The reviewer could decide without escalating to a human',
    title: 'Reviewer escalated the PR to a human',
    class: 'task_spec',
    proposedAction: 'observe_only',
    defaultSeverity: 'medium',
    defaultConfidence: 0.4,
    requires: ['stage_a_facts'],
    evidenceRequirements: [{ key: 'facts.review', need: 'complete' }],
    symptomOf: ['merge_agrees_with_review'],
    run: ({ facts: { outcome: o } }) => (o.review!.escalated
      ? { verdict: 'fail', observed: `escalated; rounds=${o.review!.rounds}` }
      : pass('not escalated')),
  },
  {
    id: 'failure_explained',
    invariant: 'A failed session carries an exit cause, an error or an error trace',
    title: 'Session failed with no recorded cause',
    class: 'platform',
    proposedAction: 'observe_only',
    defaultSeverity: 'medium',
    defaultConfidence: 0.4,
    requires: ['stage_a_facts'],
    evidenceRequirements: [{ key: 'facts.errors', need: 'complete' }],
    symptomOf: ['no_severe_runtime_error', 'output_contract_honoured'],
    run: ({ facts }) => {
      const o = facts.outcome;
      if (o.workerStatus !== 'failed' && o.workerStatus !== 'error') return pass('not a failure');
      if (o.exitCause || o.hasError || facts.errors!.total > 0) return pass('failure has a recorded cause');
      return { verdict: 'fail', observed: `workerStatus=${o.workerStatus}; no exitCause, error or error trace` };
    },
  },
  {
    id: 'retrieval_before_first_edit',
    invariant: 'The session consulted team knowledge before its first edit',
    title: 'First edit made before any knowledge lookup',
    class: ({ facts }) => {
      const c = facts.knowledge.corpora;
      return c && c.code === 'not_indexed' && c.docs === 'not_indexed' ? 'retrieval' : 'agent_use';
    },
    proposedAction: 'adjust_guidance',
    defaultSeverity: 'low',
    defaultConfidence: 0.6,
    requires: ['transcript_reader'],
    // The question is about the START of the session: a trailing window cannot answer it.
    evidenceRequirements: [{ key: 'transcript.early_tool_calls', need: 'complete' }],
    symptomOf: [],
    run: ({ transcript }) => {
      const names = orderedToolNames(transcript!);
      const firstEdit = names.findIndex(n => EDIT_TOOLS.has(n));
      if (firstEdit < 0) return pass('no edit in session');
      const firstRecall = names.findIndex(n => RECALL_TOOL.test(n));
      if (firstRecall >= 0 && firstRecall < firstEdit) return pass(`recall at call ${firstRecall}; first edit at call ${firstEdit}`);
      return {
        verdict: 'fail',
        evidenceRefs: transcript!.source ? [{ kind: 'transcript', ref: transcript!.source.objectKey }] : [],
        observed: `first edit at call ${firstEdit}; first recall ${firstRecall < 0 ? 'never' : `at call ${firstRecall}`}`,
      };
    },
  },
  {
    id: 'retrieved_knowledge_consistent',
    invariant: 'Knowledge the session relied on agrees with shipped state',
    title: 'Retrieved knowledge contradicts shipped state',
    class: 'knowledge',
    proposedAction: 'propose_memory_correction',
    defaultSeverity: 'high',
    defaultConfidence: 0.7,
    requires: ['knowledge_claims'],
    evidenceRequirements: [{ key: 'knowledge.claims', need: 'partial' }],
    symptomOf: [],
    run: ({ knowledge }) => {
      const bad = knowledge!.claims.filter(c => c.contradictedBy);
      if (bad.length === 0) return pass(`${knowledge!.claims.length} claim(s) consistent`);
      const first = [...bad].sort((a, b) => a.sourceId.localeCompare(b.sourceId))[0];
      return {
        verdict: 'fail',
        signatureParts: [first.sourceId],
        evidenceRefs: [{ kind: 'memory', ref: first.sourceId }, first.contradictedBy!],
        observed: `${bad.length} contradicted claim(s); first source=${first.sourceId}`,
      };
    },
  },
];

export const POST_SESSION_CHECK_IDS: readonly string[] = CHECKS.map(c => c.id);
const SPEC_BY_ID = new Map(CHECKS.map(c => [c.id, c]));

// ── Analysis ────────────────────────────────────────────────────────────────

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Pointers to the session itself. `withPr: false` for a memory-correction
 * finding: its proposal reads every non-session ref as contradicting evidence,
 * and the session's own PR is not evidence against the memory.
 */
function baseRefs(input: PostSessionAnalysisInput, opts: { withPr: boolean } = { withPr: true }): FindingEvidenceRef[] {
  const ctx = input.facts.context;
  const refs: FindingEvidenceRef[] = [
    { kind: 'post_session_run', ref: input.runId },
    { kind: 'worker', ref: ctx.workerId },
    { kind: 'task', ref: ctx.taskId },
  ];
  if (opts.withPr && input.facts.outcome.prNumber !== null) refs.push({ kind: 'pr', ref: String(input.facts.outcome.prNumber) });
  return refs;
}

function mergeRefs(...lists: FindingEvidenceRef[][]): FindingEvidenceRef[] {
  const seen = new Set<string>();
  const out: FindingEvidenceRef[] = [];
  for (const r of lists.flat()) {
    const k = `${r.kind}\u0000${r.ref}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.slice(0, MAX_EVIDENCE_REFS);
}

/** Run evidence (CI logs, command output) worth pointing at for these checks. */
const EVIDENCE_OBJECT_CHECKS = new Set(['no_severe_runtime_error', 'failure_explained', 'review_converges']);

function evidenceObjectRefs(input: PostSessionAnalysisInput, checkId: string): FindingEvidenceRef[] {
  if (!input.evidence || !EVIDENCE_OBJECT_CHECKS.has(checkId)) return [];
  return input.evidence.slice(0, MAX_EVIDENCE_OBJECTS).map(e => ({ kind: `evidence:${e.kind}`, ref: e.id }));
}

function toFinding(input: PostSessionAnalysisInput, spec: PostSessionCheckSpec, r: VerificationResult, related: VerificationResult[]): PostSessionQualityFinding {
  const cls = typeof spec.class === 'function' ? spec.class(input) : spec.class;
  return {
    class: cls,
    severity: r.severity ?? spec.defaultSeverity,
    confidence: r.confidence ?? spec.defaultConfidence,
    title: clip(spec.title, MAX_TITLE_CHARS),
    evidenceRefs: mergeRefs(baseRefs(input, { withPr: spec.proposedAction !== 'propose_memory_correction' }), r.evidenceRefs, ...related.map(x => x.evidenceRefs), evidenceObjectRefs(input, spec.id)),
    signature: r.signature,
    recurrenceKey: `post_session:${cls}:${spec.id}`,
    proposedAction: spec.proposedAction,
    summary: clip(`${spec.invariant}. Observed: ${r.observed ?? 'n/a'}.${related.length ? ` Symptoms folded in: ${related.map(x => x.checkId).join(', ')}.` : ''}`, MAX_SUMMARY_CHARS),
    checkId: spec.id,
    relatedCheckIds: related.map(x => x.checkId),
  };
}

function noActionFinding(input: PostSessionAnalysisInput, results: VerificationResult[]): PostSessionQualityFinding {
  const inconclusive = results.filter(r => r.verdict === 'inconclusive').map(r => r.checkId).sort();
  const transcriptRef: FindingEvidenceRef[] = input.transcript?.source
    ? [{ kind: 'transcript', ref: input.transcript.source.objectKey }]
    : [];
  const title = inconclusive.length
    ? `Inconclusive: evidence missing for ${inconclusive.join(', ')}`
    : 'No actionable finding';
  return {
    class: 'no_action',
    severity: 'low',
    confidence: inconclusive.length ? 0.3 : 0.8,
    title: clip(title, MAX_TITLE_CHARS),
    evidenceRefs: mergeRefs(baseRefs(input), transcriptRef),
    signature: verificationSignature(['no_action', ...inconclusive]),
    recurrenceKey: 'post_session:no_action',
    proposedAction: 'observe_only',
    summary: clip(inconclusive.length
      ? `No check failed. ${inconclusive.length} check(s) could not be settled from the available evidence and were not asserted: ${inconclusive.join(', ')}.`
      : 'Every check that could run passed.', MAX_SUMMARY_CHARS),
    checkId: 'no_action',
    relatedCheckIds: [],
  };
}

function coverageOf(t: CompletedSessionTranscript | null): PostSessionTraceCoverage {
  if (!t) return { traceAvailability: 'absent', traceSource: null, traceMissing: { portions: [], reason: 'not_read' } };
  return {
    traceAvailability: t.traceAvailability,
    traceSource: t.source?.kind ?? null,
    traceMissing: { portions: [...t.missingPortions], reason: t.reason },
  };
}

/** Pure. Same input, same analysis (bar `ranAt`). */
export function analysePostSession(input: PostSessionAnalysisInput, now: Date): PostSessionAnalysis {
  const evidence = postSessionEvidenceCoverage(input);
  const caps = capabilities(input);
  const subject = { kind: 'worker', ref: input.facts.context.workerId };

  const results = CHECKS.map(spec => runVerificationCheck({
    id: spec.id,
    version: 1,
    invariant: spec.invariant,
    subject,
    provenance: { flavor: FLAVOR, origin: `${POST_SESSION_ANALYSER_VERSION}:${input.runId}` },
    executor: { kind: spec.requires.includes('transcript_reader') ? 'transcript' : 'deterministic', requires: spec.requires, run: spec.run },
    evidenceRequirements: spec.evidenceRequirements,
    defaultSeverity: spec.defaultSeverity,
  }, { input, evidence, capabilities: caps, now }));

  const failing = results.filter(r => r.verdict === 'fail');
  const failingIds = new Set(failing.map(r => r.checkId));
  const roots = failing.filter(r => !SPEC_BY_ID.get(r.checkId)!.symptomOf.some(id => failingIds.has(id)));
  const symptomsOf = (rootId: string) =>
    failing.filter(r => r.checkId !== rootId && SPEC_BY_ID.get(r.checkId)!.symptomOf.includes(rootId));

  const findings = roots
    .map(r => toFinding(input, SPEC_BY_ID.get(r.checkId)!, r, symptomsOf(r.checkId)))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.confidence - a.confidence || a.checkId.localeCompare(b.checkId))
    .slice(0, MAX_FINDINGS);

  return {
    analyserVersion: POST_SESSION_ANALYSER_VERSION,
    focus: input.focus,
    coverage: coverageOf(input.transcript),
    results,
    verdicts: summarizeVerificationResults(results),
    findings: findings.length ? findings : [noActionFinding(input, results)],
  };
}

// ── Read-only orchestration ─────────────────────────────────────────────────

/** The run-row columns the analyser reads. */
export interface AnalysisRunRow {
  id: string;
  state: PostSessionRunState;
  workerId: string;
  taskId: string | null;
  workspaceId: string;
  facts: StageAFacts | null;
  triage: PostSessionTriageRecord | null;
  hardTriggerReasons: string[] | null;
}

/** Every dependency is a read. There is deliberately no write hook. */
export interface PostSessionAnalysisDeps {
  loadRun?: (runId: string) => Promise<AnalysisRunRow | null>;
  readTranscript?: (workerId: string) => Promise<CompletedSessionTranscript>;
  listEvidence?: (task: { id: string; workspaceId: string }) => Promise<Array<{ id: string; kind: string }>>;
  /** Knowledge claims the session relied on. Default: not reconstructable (null). */
  loadKnowledge?: (run: AnalysisRunRow) => Promise<{ claims: KnowledgeClaim[] } | null>;
  now?: Date;
}

export type AnalysePostSessionResult =
  | { status: 'analysed'; runId: string; analysis: PostSessionAnalysis }
  | { status: 'not_ready'; runId: string; state: PostSessionRunState | null }
  | { status: 'missing' }
  | { status: 'error'; error: string };

async function defaultLoadRun(runId: string): Promise<AnalysisRunRow | null> {
  const [{ db }, { postSessionRuns }, { eq }] = await Promise.all([
    import('@buildd/core/db'),
    import('@buildd/core/db/schema'),
    import('drizzle-orm'),
  ]);
  const row = await db.query.postSessionRuns.findFirst({
    where: eq(postSessionRuns.id, runId),
    columns: {
      id: true, state: true, workerId: true, taskId: true, workspaceId: true,
      facts: true, triage: true, hardTriggerReasons: true,
    },
  });
  return row ?? null;
}

async function defaultReadTranscript(workerId: string): Promise<CompletedSessionTranscript> {
  const { readCompletedSessionTranscript } = await import('./session-transcript');
  return readCompletedSessionTranscript(workerId);
}

async function defaultListEvidence(task: { id: string; workspaceId: string }): Promise<Array<{ id: string; kind: string }>> {
  const { listTaskEvidenceObjects } = await import('./evidence-read');
  const rows = await listTaskEvidenceObjects(task, { limit: 20 });
  return rows.map(r => ({ id: r.id, kind: r.kind }));
}

/**
 * Load a triaged run and analyse it. Reads only; returns the analysis for the
 * ledger stage to persist. A failed transcript/evidence/knowledge read
 * degrades coverage — it never fails the analysis.
 */
export async function analysePostSessionRun(runId: string, deps: PostSessionAnalysisDeps = {}): Promise<AnalysePostSessionResult> {
  try {
    const loadRun = deps.loadRun ?? defaultLoadRun;
    const run = await loadRun(runId);
    if (!run) return { status: 'missing' };
    if (run.state !== 'triaged' || !run.facts) return { status: 'not_ready', runId, state: run.state };

    const readTranscript = deps.readTranscript ?? defaultReadTranscript;
    const listEvidence = deps.listEvidence ?? defaultListEvidence;
    const loadKnowledge = deps.loadKnowledge ?? (async () => null);
    const taskId = run.taskId;
    const [transcript, evidence, knowledge] = await Promise.all([
      readTranscript(run.workerId).catch(() => null),
      taskId ? listEvidence({ id: taskId, workspaceId: run.workspaceId }).catch(() => null) : Promise.resolve(null),
      loadKnowledge(run).catch(() => null),
    ]);

    const analysis = analysePostSession({
      runId: run.id,
      facts: run.facts,
      focus: run.triage?.focus ?? null,
      hardTriggerReasons: run.hardTriggerReasons ?? [],
      transcript,
      evidence,
      knowledge,
    }, deps.now ?? new Date());
    return { status: 'analysed', runId: run.id, analysis };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: clip(msg, MAX_ERROR_CHARS) };
  }
}

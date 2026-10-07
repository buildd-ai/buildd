/**
 * Post-session quality loop — end-to-end proof (artifact
 * `post-session-quality-loop-spec`, mission close-out).
 *
 * Unit tests prove each stage against its own fake. This file proves the
 * stages compose: it drives the scheduled entry point
 * (`runPostSessionQualityLoop`) with the REAL collector, triage, transcript
 * reader, analyser, ledger and action policy, and replaces only the edges a
 * sandbox cannot reach:
 *
 *  - Postgres → `World`, an in-memory twin of the rows the two DB stores read
 *    and write. Each store method mirrors its SQL in `post-session-store.ts` /
 *    `post-session-findings-store.ts`: the unique (worker, policy) and
 *    (workspace, signature, policy) keys, the state fences, the updated_at CAS
 *    and the action claim. A method the real store does not have is not here.
 *  - The decision model → a scripted `decide` with the transport's result
 *    shape, keyed off a fact (turns) because the triage state carries no ids.
 *  - Object storage → JSONL bytes fed through `readCompletedSessionTranscript`,
 *    so truncation is detected by the real reader, not asserted by a fixture.
 *
 * Every store write is logged by table, so "the loop never wrote the worker,
 * the original task or memory" is checked against what actually happened.
 */

import { describe, expect, it } from 'bun:test';
import {
  MAX_POST_SESSION_ATTEMPTS,
  POST_SESSION_POLICY_VERSION,
  POST_SESSION_STALE_COLLECTING_MS,
  resolvePostSessionQualityMode,
  type FindingActionState,
  type PostSessionQualityConfig,
  type PostSessionRunState,
  type PostSessionTriageRecord,
  type StageAFacts,
  type StageASource,
  type TranscriptAvailability,
} from '@buildd/core/post-session-quality';
import { TERMINAL_TASK_STATUSES, TERMINAL_WORKER_STATUSES } from '@buildd/shared';
import type { FindingLedgerAggregate, FollowUpTaskSpec, CorrectionProposalSpec } from '@buildd/core/post-session-findings';
import { runPostSessionQualityLoop, type PostSessionLoopReadout } from './post-session-loop';
import { sweepPostSessionRuns, type PostSessionRunStore, type PostSessionWorkerRef } from './post-session-run';
import { recordPostSessionFindings, recordTriagedRuns, type PostSessionFindingStore, type StoredFinding } from './post-session-findings';
import { analysePostSessionRun, type KnowledgeClaim, type PostSessionTraceCoverage } from './post-session-quality-analysis';
import { readCompletedSessionTranscript } from './session-transcript';
import { decisionDepsFor } from './post-session-triage-test-deps';

const NOW = new Date('2026-10-04T12:00:00Z');
const HOUR = 60 * 60 * 1000;

// ── World: the rows the stores touch ────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  teamId: string | null;
  dataClass: string;
  gitConfig: { postSessionQuality?: PostSessionQualityConfig } | null;
}

interface WorkerRow {
  id: string;
  taskId: string;
  workspaceId: string;
  status: string;
  exitCause: string | null;
  error: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  prNumber: number | null;
  prLifecycleStatus: string | null;
  mergedAt: Date | null;
  supersededByPrNumber: number | null;
  abandonedAt: Date | null;
  rejectedCompletionPayload: unknown;
  dirtyWorktree: boolean;
  mcpCalls: unknown[] | null;
  resultMeta: StageASource['worker']['resultMeta'];
}

interface TaskRow {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: string;
  kind: string | null;
  category: string | null;
  roleSlug: string | null;
  missionId: string | null;
  outputRequirement: string | null;
  creationSource: string | null;
  parentTaskId: string | null;
  priority: number;
  result: unknown;
  context: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface RunRow {
  id: string;
  workerId: string;
  taskId: string | null;
  workspaceId: string;
  missionId: string | null;
  policyVersion: string;
  mode: 'off' | 'shadow' | 'propose';
  state: PostSessionRunState;
  attempts: number;
  facts: StageAFacts | null;
  transcriptAvailability: TranscriptAvailability | null;
  triage: PostSessionTriageRecord | null;
  hardTriggered: boolean | null;
  hardTriggerReasons: string[] | null;
  finalDecision: string | null;
  traceAvailability: string | null;
  traceSource: string | null;
  traceMissing: PostSessionTraceCoverage['traceMissing'] | null;
  errorStage: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ArtifactRow {
  id: string;
  workspaceId: string;
  missionId: string | null;
  key: string;
  type: string;
  title: string;
  content: string;
  metadata: CorrectionProposalSpec['metadata'];
}

type Answer = { decision: string; focus: string; confidence?: number };

interface SessionInputs {
  reviews: Array<{ status: string; verdict: string | null; confidence: number | null }>;
  ciFixes: number;
  errorTraces: Array<{ pattern: string; count: number }>;
  /** JSONL body; 'missing' = no object; 'unreadable' = storage throws. */
  transcript: string | 'missing' | 'unreadable';
  evidence: Array<{ id: string; kind: string }>;
  knowledge: { claims: KnowledgeClaim[] } | null;
}

class World {
  workspaces = new Map<string, WorkspaceRow>();
  workers = new Map<string, WorkerRow>();
  tasks = new Map<string, TaskRow>();
  runs = new Map<string, RunRow>();
  findings = new Map<string, StoredFinding>();
  artifacts = new Map<string, ArtifactRow>();
  notes: Array<{ missionId: string; title: string }> = [];
  /** Durable memory. Nothing in the loop may add to it. */
  memories: Array<{ id: string; content: string }> = [];
  inputs = new Map<string, SessionInputs>();
  answers = new Map<number, Answer>();
  writes: Array<{ table: string; op: string; id: string }> = [];
  dispatched: string[] = [];
  decideCalls = 0;
  /** The run whose triage is in flight: the decision call carries no ids. */
  private triaging: string | null = null;
  private seq = 0;
  private turns = 10;

  nextId(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  workspace(over: Partial<WorkspaceRow> = {}): WorkspaceRow {
    const ws: WorkspaceRow = { id: 'ws-dogfood', teamId: 'team-dogfood', dataClass: 'standard', gitConfig: null, ...over };
    this.workspaces.set(ws.id, ws);
    return ws;
  }

  setMode(workspaceId: string, mode: 'off' | 'shadow' | 'propose'): void {
    const ws = this.workspaces.get(workspaceId)!;
    ws.gitConfig = { ...(ws.gitConfig ?? {}), postSessionQuality: { ...(ws.gitConfig?.postSessionQuality ?? {}), mode } };
  }

  /** One finished session: a task, the worker that ran it, and what the stores can read about it. */
  session(name: string, opts: {
    workspaceId?: string;
    worker?: Partial<WorkerRow>;
    task?: Partial<TaskRow>;
    inputs?: Partial<SessionInputs>;
    answer?: Answer;
  } = {}): { workerId: string; taskId: string; turns: number } {
    const workspaceId = opts.workspaceId ?? 'ws-dogfood';
    const taskId = `task-${name}`;
    const workerId = `worker-${name}`;
    const turns = this.turns++;
    this.tasks.set(taskId, {
      id: taskId, workspaceId, title: `fixture ${name}`, description: 'original description',
      status: 'completed', kind: 'engineering', category: 'feature', roleSlug: 'builder', missionId: 'mission-dogfood',
      outputRequirement: 'pr_required', creationSource: 'mcp', parentTaskId: null, priority: 5,
      result: { summarySource: 'agent', prUrl: 'https://example.invalid/pr' }, context: {},
      createdAt: new Date(NOW.getTime() - 3 * HOUR), updatedAt: new Date(NOW.getTime() - HOUR),
      ...opts.task,
    });
    this.workers.set(workerId, {
      id: workerId, taskId, workspaceId, status: 'completed', exitCause: null, error: null,
      turns, inputTokens: 1000, outputTokens: 200, costUsd: '0.50',
      createdAt: new Date(NOW.getTime() - 3 * HOUR), startedAt: new Date(NOW.getTime() - 3 * HOUR),
      completedAt: new Date(NOW.getTime() - HOUR),
      prNumber: 100 + turns, prLifecycleStatus: 'merged', mergedAt: new Date(NOW.getTime() - HOUR),
      supersededByPrNumber: null, abandonedAt: null, rejectedCompletionPayload: null, dirtyWorktree: false,
      mcpCalls: [], resultMeta: { toolCounts: { Read: 5, Edit: 2, mcp__buildd__recall: 1 } } as never,
      ...opts.worker,
    });
    this.inputs.set(workerId, {
      reviews: [{ status: 'completed', verdict: 'approve', confidence: 0.9 }],
      ciFixes: 0, errorTraces: [], transcript: 'missing', evidence: [], knowledge: null,
      ...opts.inputs,
    });
    this.answers.set(turns, opts.answer ?? { decision: 'skip', focus: 'general' });
    return { workerId, taskId, turns };
  }

  /** The original worker and task rows, for an unchanged-by-the-loop comparison. */
  snapshotOriginals(): string {
    const fixtures = [...this.tasks.values()].filter(t => !t.context.postSessionFinding);
    return JSON.stringify({ workers: [...this.workers.values()], tasks: fixtures });
  }

  runsFor(workerId: string): RunRow[] {
    return [...this.runs.values()].filter(r => r.workerId === workerId);
  }

  followUpTasks(): TaskRow[] {
    return [...this.tasks.values()].filter(t => t.context.postSessionFinding);
  }

  findingBy(checkPrefix: string): StoredFinding | undefined {
    return [...this.findings.values()].find(f => f.recurrenceKey?.endsWith(`:${checkPrefix}`));
  }

  private log(table: string, op: string, id: string): void {
    this.writes.push({ table, op, id });
  }

  private notOff(workspaceId: string): boolean {
    return resolvePostSessionQualityMode(this.workspaces.get(workspaceId)?.gitConfig) !== 'off';
  }

  // ── Twin of post-session-store.ts ─────────────────────────────────────────

  runStore(): PostSessionRunStore {
    const w = this;
    const settled = (r: RunRow, now: Date) => !(
      (r.state === 'failed' && r.attempts < MAX_POST_SESSION_ATTEMPTS)
      || (r.state === 'collecting' && r.updatedAt.getTime() < now.getTime() - POST_SESSION_STALE_COLLECTING_MS)
    );
    return {
      async loadWorker(id): Promise<PostSessionWorkerRef | null> {
        const row = w.workers.get(id);
        if (!row) return null;
        return {
          id: row.id, status: row.status, startedAt: row.startedAt, exitCause: row.exitCause, taskId: row.taskId,
          workspaceId: row.workspaceId, missionId: w.tasks.get(row.taskId)?.missionId ?? null,
          gitConfig: w.workspaces.get(row.workspaceId)?.gitConfig ?? null,
        };
      },
      async claimRun({ workerId, taskId, workspaceId, missionId, policyVersion, mode, now }) {
        await Promise.resolve();
        const existing = [...w.runs.values()].find(r => r.workerId === workerId && r.policyVersion === policyVersion);
        if (!existing) {
          const id = w.nextId('run');
          w.runs.set(id, {
            id, workerId, taskId, workspaceId, missionId, policyVersion, mode, state: 'collecting', attempts: 1,
            facts: null, transcriptAvailability: null, triage: null, hardTriggered: null, hardTriggerReasons: null,
            finalDecision: null, traceAvailability: null, traceSource: null, traceMissing: null,
            errorStage: null, lastError: null, createdAt: now, updatedAt: now,
          });
          w.log('post_session_runs', 'insert', id);
          return { claimed: true, runId: id, attempt: 1 };
        }
        if (!settled(existing, now)) {
          existing.state = 'collecting';
          existing.attempts++;
          existing.updatedAt = now;
          w.log('post_session_runs', 'reclaim', existing.id);
          return { claimed: true, runId: existing.id, attempt: existing.attempts };
        }
        return { claimed: false, runId: existing.id, state: existing.state };
      },
      async loadSource(ref, mode): Promise<StageASource> {
        const row = w.workers.get(ref.id)!;
        const task = w.tasks.get(row.taskId)!;
        const ws = w.workspaces.get(row.workspaceId)!;
        const inp = w.inputs.get(row.id)!;
        const siblings = [...w.workers.values()].filter(x => x.taskId === task.id);
        return {
          worker: {
            id: row.id, status: row.status, exitCause: row.exitCause, error: row.error, turns: row.turns,
            inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd: row.costUsd,
            startedAt: row.startedAt, completedAt: row.completedAt, prNumber: row.prNumber,
            prLifecycleStatus: row.prLifecycleStatus, mergedAt: row.mergedAt,
            supersededByPrNumber: row.supersededByPrNumber, abandonedAt: row.abandonedAt,
            rejectedCompletionPayload: row.rejectedCompletionPayload, dirtyWorktree: row.dirtyWorktree,
            mcpCallCount: Array.isArray(row.mcpCalls) ? row.mcpCalls.length : null, resultMeta: row.resultMeta,
          },
          task: {
            id: task.id, status: task.status, kind: task.kind, category: task.category, roleSlug: task.roleSlug,
            missionId: task.missionId, outputRequirement: task.outputRequirement, creationSource: task.creationSource,
            parentTaskId: task.parentTaskId, result: task.result,
          },
          workspace: { id: ws.id, mergePolicyTier: null, dataClass: ws.dataClass },
          mode,
          attempts: {
            attemptNumber: siblings.filter(x => x.createdAt <= row.createdAt).length,
            totalAttempts: siblings.length,
          },
          reviews: row.prNumber === null ? [] : inp.reviews,
          ciFixAttempts: row.prNumber === null ? 0 : inp.ciFixes,
          errorTraces: inp.errorTraces,
          transcript: {
            availability: inp.transcript === 'missing' ? 'absent' : inp.transcript === 'unreadable' ? 'unknown' : 'present',
            sizeBytes: null,
          },
          corpora: { code: 'indexed', docs: 'indexed' },
          unavailable: inp.transcript === 'unreadable' ? ['transcript'] : [],
        };
      },
      async completeRun(runId, attempt, { facts, transcriptAvailability, now }) {
        const r = w.runs.get(runId);
        if (!r || r.state !== 'collecting' || r.attempts !== attempt) return false;
        Object.assign(r, { state: 'collected', facts, transcriptAvailability, updatedAt: now });
        w.log('post_session_runs', 'collected', runId);
        return true;
      },
      async failRun(runId, attempt, { stage, error, now }) {
        const r = w.runs.get(runId);
        if (!r || r.state !== 'collecting' || r.attempts !== attempt) return;
        Object.assign(r, { state: 'failed', errorStage: stage, lastError: error, updatedAt: now });
        w.log('post_session_runs', 'failed', runId);
      },
      async listCandidates({ policyVersion, since, limit, now }) {
        return [...w.workers.values()]
          .filter(x => (TERMINAL_WORKER_STATUSES as readonly string[]).includes(x.status)
            && x.startedAt && x.taskId && x.exitCause !== 'never_started'
            && x.completedAt && x.completedAt >= since
            && w.notOff(x.workspaceId)
            && ![...w.runs.values()].some(r => r.workerId === x.id && r.policyVersion === policyVersion && settled(r, now)))
          .sort((a, b) => a.completedAt!.getTime() - b.completedAt!.getTime())
          .slice(0, limit)
          .map(x => x.id);
      },
      async loadTriageInput(runId) {
        const r = w.runs.get(runId);
        if (!r) return null;
        w.triaging = runId;
        const ws = w.workspaces.get(r.workspaceId)!;
        return { runId: r.id, state: r.state, facts: r.facts, workspaceId: r.workspaceId, teamId: ws.teamId, dataClass: ws.dataClass };
      },
      async recordTriage(runId, outcome, now) {
        await Promise.resolve();
        const r = w.runs.get(runId);
        if (!r || r.state !== 'collected') return false;
        Object.assign(r, {
          state: outcome.finalDecision === 'analyse' ? 'triaged' : 'skipped',
          triage: outcome.triage, hardTriggered: outcome.hardTriggered,
          hardTriggerReasons: outcome.hardTriggerReasons, finalDecision: outcome.finalDecision, updatedAt: now,
        });
        w.log('post_session_runs', 'triaged', runId);
        return true;
      },
      async listUntriaged({ policyVersion, limit }) {
        return [...w.runs.values()]
          .filter(r => r.policyVersion === policyVersion && r.state === 'collected' && w.notOff(r.workspaceId))
          .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
          .slice(0, limit)
          .map(r => r.id);
      },
      async recordTriageFailure(runId, error, now) {
        const r = w.runs.get(runId);
        if (!r || r.state !== 'collected') return;
        Object.assign(r, { errorStage: 'triage', lastError: error, updatedAt: now });
        w.log('post_session_runs', 'triage_failure', runId);
      },
    };
  }

  // ── Twin of post-session-findings-store.ts ────────────────────────────────

  findingStore(): PostSessionFindingStore {
    const w = this;
    const copy = (f: StoredFinding): StoredFinding => structuredClone(f);
    const writeAggregate = (f: StoredFinding, a: FindingLedgerAggregate) => Object.assign(f, structuredClone(a));
    return {
      async loadRun(runId) {
        const r = w.runs.get(runId);
        if (!r) return null;
        return {
          id: r.id, state: r.state, workerId: r.workerId, taskId: r.taskId, workspaceId: r.workspaceId,
          missionId: r.missionId, policyVersion: r.policyVersion, mode: r.mode,
          gitConfig: w.workspaces.get(r.workspaceId)?.gitConfig ?? null,
        };
      },
      async insertFinding({ workspaceId, signature, policyVersion, aggregate, now }) {
        await Promise.resolve();
        if ([...w.findings.values()].some(f => f.workspaceId === workspaceId && f.signature === signature && f.policyVersion === policyVersion)) return null;
        const id = w.nextId('finding');
        const row: StoredFinding = {
          ...structuredClone(aggregate), id, workspaceId, signature, policyVersion,
          actionState: 'observed', actionTaskId: null, actionArtifactId: null, actionAt: null, updatedAt: now,
        };
        w.findings.set(id, row);
        w.log('post_session_findings', 'insert', id);
        return copy(row);
      },
      async loadFinding(workspaceId, signature, policyVersion) {
        const f = [...w.findings.values()].find(x => x.workspaceId === workspaceId && x.signature === signature && x.policyVersion === policyVersion);
        return f ? copy(f) : null;
      },
      async updateFindingIfUnchanged(id, expectedUpdatedAt, aggregate, updatedAt) {
        await Promise.resolve();
        const f = w.findings.get(id);
        if (!f || f.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return null;
        writeAggregate(f, aggregate);
        f.updatedAt = updatedAt;
        w.log('post_session_findings', 'update', id);
        return copy(f);
      },
      async findOpenFollowUpTask(workspaceId, findingId) {
        const t = [...w.tasks.values()].find(x => x.workspaceId === workspaceId
          && (x.context.postSessionFinding as { findingId?: string } | undefined)?.findingId === findingId
          && !(TERMINAL_TASK_STATUSES as readonly string[]).includes(x.status));
        return t?.id ?? null;
      },
      async insertTask(workspaceId, spec: FollowUpTaskSpec, now) {
        await Promise.resolve();
        const id = w.nextId('followup');
        w.tasks.set(id, {
          id, workspaceId, title: spec.title, description: spec.description, status: 'pending', kind: spec.kind,
          category: spec.category, roleSlug: null, missionId: null, outputRequirement: null,
          creationSource: 'orchestrator', parentTaskId: null, priority: spec.priority, result: null,
          context: spec.context as unknown as Record<string, unknown>, createdAt: now, updatedAt: now,
        });
        w.log('tasks', 'insert', id);
        return id;
      },
      async deleteTask(taskId) {
        if (w.tasks.get(taskId)?.status === 'pending') {
          w.tasks.delete(taskId);
          w.log('tasks', 'delete', taskId);
        }
      },
      async dispatchTask(taskId) {
        w.dispatched.push(taskId);
      },
      async claimAction(findingId, { state, taskId, artifactId, now }) {
        await Promise.resolve();
        const f = w.findings.get(findingId);
        if (!f || f.actionTaskId || f.actionArtifactId || !(['observed', 'promoted'] as FindingActionState[]).includes(f.actionState)) return false;
        Object.assign(f, { actionState: state, actionTaskId: taskId ?? null, actionArtifactId: artifactId ?? null, actionAt: now });
        w.log('post_session_findings', 'claim', findingId);
        return true;
      },
      async markPromoted(findingId, now) {
        const f = w.findings.get(findingId);
        if (f?.actionState !== 'observed') return;
        Object.assign(f, { actionState: 'promoted', actionAt: now });
        w.log('post_session_findings', 'promoted', findingId);
      },
      async upsertProposal(workspaceId, missionId, spec, _now) {
        const existing = [...w.artifacts.values()].find(a => a.workspaceId === workspaceId && a.key === spec.key);
        if (existing) return existing.id;
        const id = w.nextId('artifact');
        w.artifacts.set(id, { id, workspaceId, missionId, key: spec.key, type: spec.type, title: spec.title, content: spec.content, metadata: spec.metadata });
        w.log('artifacts', 'insert', id);
        return id;
      },
      async appendToTask(taskId, text, now) {
        const t = w.tasks.get(taskId)!;
        t.description += text;
        t.updatedAt = now;
        w.log('tasks', 'append', taskId);
      },
      async insertWarning({ missionId, title }) {
        w.notes.push({ missionId, title });
        w.log('mission_notes', 'insert', missionId);
      },
      async markRunAnalysed(runId, coverage, now) {
        const r = w.runs.get(runId);
        if (!r || r.state !== 'triaged') return false;
        Object.assign(r, {
          state: 'analysed', traceAvailability: coverage.traceAvailability, traceSource: coverage.traceSource,
          traceMissing: coverage.traceMissing, updatedAt: now,
        });
        w.log('post_session_runs', 'analysed', runId);
        return true;
      },
      async recordFailure(runId, stage, error, now) {
        const r = w.runs.get(runId);
        if (!r || r.state !== 'triaged') return;
        Object.assign(r, { errorStage: stage, lastError: error, updatedAt: now });
        w.log('post_session_runs', `${stage}_failure`, runId);
      },
      async listTriaged({ policyVersion, limit }) {
        return [...w.runs.values()]
          .filter(r => r.policyVersion === policyVersion && r.state === 'triaged' && w.notOff(r.workspaceId))
          .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
          .slice(0, limit)
          .map(r => r.id);
      },
    };
  }

  // ── Edges: decision model, transcript storage, evidence, knowledge ────────

  /** Same result shape as `decisionCall`. */
  decide(mode: 'ok' | 'throw' | 'timeout' = 'ok') {
    return (async (params: { decisionId: string; onUsage?: (r: unknown) => void }) => {
      this.decideCalls++;
      if (mode === 'throw') throw new Error('decision transport down');
      if (mode === 'timeout') return { ok: false, error: { kind: 'timeout' }, latencyMs: 5000, attempts: 2 };
      const a = this.answers.get(this.workers.get(this.runs.get(this.triaging!)!.workerId)!.turns)!;
      params.onUsage?.({ decisionId: params.decisionId, model: 'decision-model', usage: { inputTokens: 400, outputTokens: 6, costUsd: 0.0001 } });
      return {
        ok: true, model: 'decision-model', latencyMs: 180, attempts: 1,
        usage: { inputTokens: 400, outputTokens: 6, costUsd: 0.0001 },
        answers: {
          decision: { type: 'choice', choice: a.decision, confidence: a.confidence ?? 0.82, probabilities: {} },
          focus: { type: 'choice', choice: a.focus, confidence: 0.6, probabilities: {} },
        },
      };
    }) as never;
  }

  analyse(opts: { brokenWorkers?: Set<string> } = {}) {
    return (runId: string) => analysePostSessionRun(runId, {
      now: NOW,
      loadRun: async id => {
        const r = this.runs.get(id);
        if (!r) return null;
        if (opts.brokenWorkers?.has(r.workerId)) throw new Error('analyser exploded');
        return {
          id: r.id, state: r.state, workerId: r.workerId, taskId: r.taskId, workspaceId: r.workspaceId,
          facts: r.facts, triage: r.triage, hardTriggerReasons: r.hardTriggerReasons,
        };
      },
      readTranscript: workerId => readCompletedSessionTranscript(workerId, {
        loadWorker: async id => {
          const x = this.workers.get(id);
          if (!x) return null;
          const ws = this.workspaces.get(x.workspaceId)!;
          return { id: x.id, workspaceId: x.workspaceId, status: x.status, workspace: { teamId: ws.teamId, dataClass: ws.dataClass } };
        },
        open: async () => {
          const t = this.inputs.get(workerId)!.transcript;
          if (t === 'missing') throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
          if (t === 'unreadable') throw new Error('storage unavailable');
          return (async function* () { yield Buffer.from(t); })();
        },
      }),
      listEvidence: async task => this.inputs.get(this.workers.get(`worker-${task.id.slice('task-'.length)}`)?.id ?? '')?.evidence ?? [],
      loadKnowledge: async run => this.inputs.get(run.workerId)?.knowledge ?? null,
    });
  }

  /** One scheduled pass, exactly as the cron route runs it, with the edges above. */
  pass(opts: { decide?: 'ok' | 'throw' | 'timeout'; brokenWorkers?: Set<string>; now?: Date } = {}): Promise<PostSessionLoopReadout> {
    const now = opts.now ?? NOW;
    const runStore = this.runStore();
    const findingStore = this.findingStore();
    return runPostSessionQualityLoop({
      now,
      env: {},
      sweep: o => sweepPostSessionRuns({
        ...o, store: runStore,
        triage: { decisionDeps: decisionDepsFor(this.decide(opts.decide)), recordReceipts: async () => {} },
      }),
      record: o => recordTriagedRuns({ ...o, store: findingStore, analyse: this.analyse({ brokenWorkers: opts.brokenWorkers }) }),
    });
  }
}

// ── Transcript fixtures (the runner's JSONL shape) ──────────────────────────

const jsonl = (...rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

/** A session that edits before it ever looks anything up. */
function editBeforeRecallTranscript(workerId: string, opts: { padTo?: number } = {}): string {
  const names = ['Read', 'Edit', 'Bash', 'mcp__buildd__recall'];
  while (names.length < (opts.padTo ?? 0)) names.push('Read');
  const calls = names.map((name, seq) => ({ type: 'tool_call', seq, toolCall: { name, input: {} } }));
  return jsonl({ type: 'session', schemaVersion: 1, workerId, workspaceId: 'ws-dogfood', messageCount: 0, toolCallCount: calls.length }, ...calls);
}

// ── Common fixtures ─────────────────────────────────────────────────────────

/** Completed, merged, approved; the model says routine. */
function clean(w: World, name = 'clean') {
  return w.session(name);
}

/** Recorded as a success on PR-required work with no PR: a hard trigger the model's "skip" cannot override. */
function successWithoutPr(w: World, name = 'no-pr') {
  return w.session(name, {
    worker: { prNumber: null, prLifecycleStatus: null, mergedAt: null },
    inputs: { evidence: [{ id: 'evidence-ci-log', kind: 'command_output' }] },
    answer: { decision: 'skip', focus: 'general' },
  });
}

/** Two request-changes rounds before approval: a medium review-loop finding. */
function reviewLoop(w: World, name: string) {
  return w.session(name, {
    inputs: {
      reviews: [
        { status: 'completed', verdict: 'request-changes', confidence: 0.8 },
        { status: 'completed', verdict: 'request-changes', confidence: 0.8 },
        { status: 'completed', verdict: 'approve', confidence: 0.9 },
      ],
    },
  });
}

/** The session relied on a memory that shipped state contradicts. */
function staleKnowledge(w: World, name = 'stale') {
  return w.session(name, {
    inputs: {
      knowledge: {
        claims: [
          { sourceId: 'memory-stale-flag', claim: 'the feature flag is still read at startup', contradictedBy: { kind: 'commit', ref: 'abc1234' } },
          { sourceId: 'memory-fresh', claim: 'migrations auto-run on deploy', contradictedBy: null },
        ],
      },
    },
    answer: { decision: 'analyse', focus: 'knowledge', confidence: 0.78 },
  });
}

function writesTo(w: World, table: string): Array<{ op: string; id: string }> {
  return w.writes.filter(x => x.table === table);
}

// ── The proof ───────────────────────────────────────────────────────────────

describe('post-session quality loop — end to end', () => {
  it('a shadow pass over a mixed workspace: one row each, triage provenance, evidence-backed findings, originals untouched', async () => {
    const w = new World();
    w.workspace();
    const c = clean(w);
    const p = successWithoutPr(w);
    const s = staleKnowledge(w);
    const before = w.snapshotOriginals();

    const readout = await w.pass();

    // (1) The original workers and tasks are byte-identical, and no write touched them.
    expect(w.snapshotOriginals()).toBe(before);
    expect(writesTo(w, 'workers')).toEqual([]);
    expect(writesTo(w, 'tasks')).toEqual([]);

    // (2) Exactly one run per worker at this policy version.
    for (const x of [c, p, s]) {
      const runs = w.runsFor(x.workerId);
      expect(runs).toHaveLength(1);
      expect(runs[0].policyVersion).toBe(POST_SESSION_POLICY_VERSION);
      expect(runs[0].mode).toBe('shadow');
    }

    // (3) Triage provenance on every run.
    const cleanRun = w.runsFor(c.workerId)[0];
    expect(cleanRun.state).toBe('skipped');
    expect(cleanRun.finalDecision).toBe('skip');
    expect(cleanRun.hardTriggered).toBe(false);
    expect(cleanRun.triage).toMatchObject({
      status: 'ok', decision: 'skip', focus: 'general', reasonCode: 'focus_general', confidence: 0.82,
      provenance: { model: 'typesafe/jev-1.13', rule: 'triage', source: 'model', policyVersion: expect.any(String) },
    });
    const noPrRun = w.runsFor(p.workerId)[0];
    expect(noPrRun.triage).toMatchObject({ status: 'rule', decision: 'analyse', provenance: { rule: 'hard_trigger', source: 'rule' } });
    expect(noPrRun.hardTriggered).toBe(true);
    expect(noPrRun.hardTriggerReasons).toEqual(['success_without_evidence']);
    expect(noPrRun.finalDecision).toBe('analyse');
    expect(noPrRun.state).toBe('analysed');
    expect(w.runsFor(s.workerId)[0].triage).toMatchObject({ decision: 'analyse', focus: 'knowledge', reasonCode: 'focus_knowledge', confidence: 0.78 });

    // (4) The selected session yields a structured, evidence-backed finding.
    const f = w.findingBy('success_has_shipping_evidence')!;
    expect(f).toMatchObject({
      class: 'platform', severity: 'high', confidence: 0.9, proposedAction: 'file_task', occurrenceCount: 1,
      // Shadow: the policy wanted to act and was not allowed to.
      actionState: 'promoted', actionTaskId: null,
    });
    expect(f.summary).toContain('outputRequirement=pr_required; no PR recorded');
    expect(f.evidenceRefs).toEqual(expect.arrayContaining([
      { kind: 'post_session_run', ref: noPrRun.id },
      { kind: 'worker', ref: p.workerId },
      { kind: 'task', ref: p.taskId },
    ]));
    expect(f.affectedRefs).toEqual([{ runId: noPrRun.id, workerId: p.workerId, taskId: p.taskId, seenAt: NOW.toISOString() }]);
    expect(noPrRun.traceMissing).toEqual({ portions: [], reason: 'object_missing' });

    // Shadow files nothing — not the task, not the proposal.
    expect(w.followUpTasks()).toEqual([]);
    expect(w.artifacts.size).toBe(0);
    expect(w.memories).toEqual([]);

    expect(readout).toMatchObject({
      enabled: true, evaluated: 3, triaged: 3, hardTriggered: 1, selectedForAnalysis: 2, analysed: 2,
      tasksCreated: 0, proposalsCreated: 0, wouldAct: 2,
      stageFailures: { collect: 0, triage: 0, transcript: 0, analyse: 0, act: 0 },
      stageErrors: [],
    });
    // The hard-triggered session is decided by rule and asks no model.
    expect(readout.stageCost.triage.calls).toBe(2);
  });

  it('replay is a no-op: a second pass, a crash replay of the record step, and racing sweeps file nothing twice', async () => {
    const w = new World();
    w.workspace();
    w.setMode('ws-dogfood', 'propose');
    const p = successWithoutPr(w);
    const before = w.snapshotOriginals();

    const first = await w.pass();
    expect(first.tasksCreated).toBe(1);
    const [task] = w.followUpTasks();
    expect(task.title).toStartWith('[post-session] ');
    expect(task.context.postSessionFinding).toMatchObject({ class: 'platform', severity: 'high' });
    expect(w.dispatched).toEqual([task.id]);

    // Second scheduled pass: nothing is a candidate any more.
    const decideCallsBefore = w.decideCalls;
    const second = await w.pass();
    expect(second).toMatchObject({ evaluated: 0, triaged: 0, analysed: 0, tasksCreated: 0 });
    expect(w.decideCalls).toBe(decideCallsBefore);

    // Crash replay: the record step re-runs for the same run (forced back to triaged).
    const run = w.runsFor(p.workerId)[0];
    run.state = 'triaged';
    const a = await w.analyse()(run.id);
    if (a.status !== 'analysed') throw new Error(`expected analysis, got ${a.status}`);
    const replay = await recordPostSessionFindings(run.id, a.analysis, { store: w.findingStore(), now: new Date(NOW.getTime() + HOUR) });
    expect(replay).toMatchObject({ status: 'recorded', findings: [{ counted: false, occurrenceCount: 1, reason: 'already_actioned', outcome: 'observed' }] });

    expect(w.followUpTasks()).toHaveLength(1);
    expect(w.findingBy('success_has_shipping_evidence')!.occurrenceCount).toBe(1);
    expect(w.runsFor(p.workerId)).toHaveLength(1);
    expect(w.snapshotOriginals()).toBe(before);
  });

  it('racing sweeps over the same sessions create one run per worker and one follow-up per finding', async () => {
    const w = new World();
    w.workspace();
    w.setMode('ws-dogfood', 'propose');
    const a = successWithoutPr(w, 'race-a');
    const b = successWithoutPr(w, 'race-b');

    const readouts = await Promise.all([w.pass(), w.pass(), w.pass()]);

    expect(w.runsFor(a.workerId)).toHaveLength(1);
    expect(w.runsFor(b.workerId)).toHaveLength(1);
    const f = w.findingBy('success_has_shipping_evidence')!;
    expect(f.occurrenceCount).toBe(2);
    expect(w.followUpTasks()).toHaveLength(1);
    expect(readouts.reduce((n, r) => n + r.tasksCreated, 0)).toBe(1);
    // Any loser's task was deleted, never dispatched.
    expect(w.dispatched).toEqual([f.actionTaskId]);
  });

  it('two medium recurrences aggregate into one finding and promote it exactly once', async () => {
    const w = new World();
    w.workspace();
    w.setMode('ws-dogfood', 'propose');

    const first = reviewLoop(w, 'loop-1');
    await w.pass();
    const f1 = w.findingBy('review_converges')!;
    expect(f1).toMatchObject({ severity: 'medium', class: 'agent_use', occurrenceCount: 1, actionState: 'observed', actionTaskId: null });
    expect(w.followUpTasks()).toEqual([]);
    // The fix loop is itself a hard trigger, so it is analysed whatever the model says.
    expect(w.runsFor(first.workerId)[0].hardTriggerReasons).toEqual(['review_fix_loop']);

    const second = reviewLoop(w, 'loop-2');
    const r2 = await w.pass({ now: new Date(NOW.getTime() + 2 * HOUR) });
    const f2 = w.findingBy('review_converges')!;
    expect(f2.id).toBe(f1.id);
    expect(f2.occurrenceCount).toBe(2);
    expect(f2.affectedRefs.map(x => x.workerId)).toEqual([first.workerId, second.workerId]);
    expect(f2.actionState).toBe('task_filed');
    expect(r2.tasksCreated).toBe(1);
    const tasks = w.followUpTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toContain(first.workerId);
    expect(tasks[0].description).toContain(second.workerId);

    // A third recurrence is counted but files nothing new.
    reviewLoop(w, 'loop-3');
    const r3 = await w.pass({ now: new Date(NOW.getTime() + 4 * HOUR) });
    expect(w.findingBy('review_converges')!.occurrenceCount).toBe(3);
    expect(r3).toMatchObject({ tasksCreated: 0, duplicatesSuppressed: 1 });
    expect(w.followUpTasks()).toHaveLength(1);
  });

  it('a stale-knowledge session yields a correction proposal and never a memory write', async () => {
    const w = new World();
    w.workspace();
    w.setMode('ws-dogfood', 'propose');
    const s = staleKnowledge(w);

    const readout = await w.pass();

    expect(readout.proposalsCreated).toBe(1);
    const f = w.findingBy('retrieved_knowledge_consistent')!;
    expect(f).toMatchObject({ class: 'knowledge', proposedAction: 'propose_memory_correction', actionState: 'proposal_filed' });
    const [artifact] = [...w.artifacts.values()];
    expect(f.actionArtifactId).toBe(artifact.id);
    expect(artifact.type).toBe('recommendation');
    expect(artifact.metadata).toMatchObject({
      kind: 'memory_correction_proposal', status: 'proposed', appliedAt: null,
      memorySourceIds: ['memory-stale-flag'],
      contradictingEvidence: [{ kind: 'commit', ref: 'abc1234' }],
      sessions: [{ workerId: s.workerId, taskId: s.taskId }],
    });
    expect(artifact.content).toContain('has not been applied');

    // No memory write, no task, and nothing outside the loop's own tables.
    expect(w.memories).toEqual([]);
    expect(w.followUpTasks()).toEqual([]);
    const tables = new Set(w.writes.map(x => x.table));
    expect([...tables].sort()).toEqual(['artifacts', 'post_session_findings', 'post_session_runs']);

    // A second session tripping the same memory does not file a second proposal.
    staleKnowledge(w, 'stale-2');
    await w.pass();
    expect(w.artifacts.size).toBe(1);
    expect(w.findingBy('retrieved_knowledge_consistent')!.occurrenceCount).toBe(2);
  });

  it('a truncated or absent transcript cannot satisfy evidence that is not there', async () => {
    const w = new World();
    w.workspace();
    w.setMode('ws-dogfood', 'propose');
    const analyse = { decision: 'analyse', focus: 'retrieval' } as const;
    // Same behaviour in every session: the first edit precedes the first recall.
    const full = w.session('full', { answer: analyse });
    w.inputs.get(full.workerId)!.transcript = editBeforeRecallTranscript(full.workerId);
    // A 200-call trailing window: the reader cannot vouch for the start of the session.
    const truncated = w.session('truncated', { answer: analyse });
    w.inputs.get(truncated.workerId)!.transcript = editBeforeRecallTranscript(truncated.workerId, { padTo: 200 });
    const absent = w.session('absent', { answer: analyse });
    const unreadable = w.session('unreadable', { answer: analyse, inputs: { transcript: 'unreadable' } });

    const readout = await w.pass();

    // Only the full transcript can assert the ordering defect.
    const f = w.findingBy('retrieval_before_first_edit')!;
    expect(f.occurrenceCount).toBe(1);
    expect(f.affectedRefs.map(x => x.workerId)).toEqual([full.workerId]);
    expect(f.evidenceRefs.some(r => r.kind === 'transcript')).toBe(true);
    expect(w.runsFor(full.workerId)[0]).toMatchObject({ traceAvailability: 'full', traceSource: 'session-diagnostics' });

    const truncatedRun = w.runsFor(truncated.workerId)[0];
    expect(truncatedRun).toMatchObject({ state: 'analysed', traceAvailability: 'truncated' });
    expect(truncatedRun.traceMissing!.portions).toContain('early_tool_calls');
    expect(w.runsFor(absent.workerId)[0]).toMatchObject({ traceAvailability: 'absent', traceMissing: { reason: 'object_missing' } });
    expect(w.runsFor(unreadable.workerId)[0]).toMatchObject({ traceAvailability: 'absent', traceMissing: { reason: 'read_failed' } });

    // The other three are recorded as inconclusive, which never acts.
    const inconclusive = w.findingBy('no_action')!;
    expect(inconclusive.title).toBe('Inconclusive: evidence missing for retrieval_before_first_edit');
    expect(inconclusive.occurrenceCount).toBe(3);
    expect(inconclusive.actionState).toBe('observed');
    // A read failure is reported as degraded coverage, not as a missing transcript.
    expect(readout.stageFailures.transcript).toBe(1);
  });

  it('decision and analyser failures fail open: originals untouched, the pass completes, the next pass recovers', async () => {
    const w = new World();
    w.workspace();
    w.setMode('ws-dogfood', 'propose');
    const c = clean(w);
    const p = successWithoutPr(w);
    const s = staleKnowledge(w);
    const before = w.snapshotOriginals();

    // Decision model down for the whole pass; the analyser also breaks on one run.
    const r1 = await w.pass({ decide: 'throw', brokenWorkers: new Set([p.workerId]) });

    expect(w.runsFor(c.workerId)[0]).toMatchObject({
      state: 'skipped', finalDecision: 'skip',
      triage: { status: 'unavailable', reasonCode: 'triage_unavailable', decision: null, provenance: { rule: 'fail_open_skip', fallbackCause: 'provider_failure' } },
    });
    // No model, so the stale-knowledge session is skipped too: a model-only signal is lost, not invented.
    expect(w.runsFor(s.workerId)[0].state).toBe('skipped');
    // The hard trigger still routes to analysis; the analyser failure leaves it triaged with the reason.
    const pRun = w.runsFor(p.workerId)[0];
    expect(pRun).toMatchObject({ state: 'triaged', hardTriggered: true, errorStage: 'analyse', lastError: 'analyser exploded' });
    expect(pRun.triage).toMatchObject({ status: 'rule', provenance: { rule: 'hard_trigger' } });
    expect(r1).toMatchObject({ triaged: 3, selectedForAnalysis: 1, analysed: 0, stageErrors: [] });
    expect(r1.stageFailures.analyse).toBe(1);
    expect(w.findings.size).toBe(0);

    // Next pass: the decision model now times out, the analyser is healthy. The
    // new session fails open to skip; the stranded run is picked up and acted on once.
    const t = w.session('timeout');
    const r2 = await w.pass({ decide: 'timeout', now: new Date(NOW.getTime() + HOUR) });
    expect(w.runsFor(t.workerId)[0].triage).toMatchObject({ status: 'unavailable', provenance: { fallbackCause: 'provider_failure', rule: 'fail_open_skip' } });
    expect(w.runsFor(p.workerId)[0].state).toBe('analysed');
    expect(r2.tasksCreated).toBe(1);
    expect(w.followUpTasks()).toHaveLength(1);

    // A store outage at the very start of a pass is counted, not thrown.
    const broken = w.runStore();
    broken.listCandidates = async () => { throw new Error('db down'); };
    const r3 = await runPostSessionQualityLoop({
      now: NOW, env: {},
      sweep: o => sweepPostSessionRuns({ ...o, store: broken }),
      record: o => recordTriagedRuns({ ...o, store: w.findingStore(), analyse: w.analyse() }),
    });
    expect(r3.stageFailures.collect).toBe(1);

    // A session was added mid-test, so compare the rows that existed before the first pass.
    const originals = JSON.parse(before) as { workers: WorkerRow[]; tasks: TaskRow[] };
    const now = JSON.parse(w.snapshotOriginals()) as { workers: WorkerRow[]; tasks: TaskRow[] };
    for (const row of originals.workers) expect(now.workers.find(x => x.id === row.id)).toEqual(row);
    for (const row of originals.tasks) expect(now.tasks.find(x => x.id === row.id)).toEqual(row);
    expect(writesTo(w, 'workers')).toEqual([]);
  });

  it('moving a workspace to propose is not retroactive; moving it off stops every stage', async () => {
    const w = new World();
    w.workspace();
    const p = successWithoutPr(w);
    await w.pass();
    expect(w.findingBy('success_has_shipping_evidence')!.actionState).toBe('promoted');

    // Switch to propose and replay the old run: it was recorded under shadow, so it still files nothing.
    w.setMode('ws-dogfood', 'propose');
    const run = w.runsFor(p.workerId)[0];
    run.state = 'triaged';
    await w.pass();
    expect(w.followUpTasks()).toEqual([]);

    // A new session under propose files the (already promoted) finding once.
    successWithoutPr(w, 'no-pr-2');
    const r = await w.pass();
    expect(r.tasksCreated).toBe(1);
    expect(w.findingBy('success_has_shipping_evidence')!).toMatchObject({ occurrenceCount: 2, actionState: 'task_filed' });

    // Off: a new session is never collected.
    w.setMode('ws-dogfood', 'off');
    const late = successWithoutPr(w, 'after-off');
    const off = await w.pass();
    expect(off.evaluated).toBe(0);
    expect(w.runsFor(late.workerId)).toEqual([]);
  });
});

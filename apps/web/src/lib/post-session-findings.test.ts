import { describe, expect, it } from 'bun:test';
import type { FindingLedgerAggregate, FollowUpTaskSpec, CorrectionProposalSpec } from '@buildd/core/post-session-findings';
import type { PostSessionQualityMode } from '@buildd/core/post-session-quality';
import type { PostSessionAnalysis, PostSessionQualityFinding } from './post-session-quality-analysis';
import {
  recordPostSessionFindings,
  recordTriagedRuns,
  type FindingRunRow,
  type PostSessionFindingStore,
  type StoredFinding,
} from './post-session-findings';

const NOW = new Date('2026-10-04T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const tick = () => new Promise(r => setTimeout(r, 0));

/**
 * In-memory store with the same atomic semantics as the Postgres one: the
 * unique (workspace, signature, policy) insert, the updatedAt compare-and-set,
 * and the action claim fenced on "no action recorded yet". Every method yields
 * first so concurrent callers genuinely interleave.
 */
class FakeStore implements PostSessionFindingStore {
  runs = new Map<string, FindingRunRow & { analysed?: boolean; actError?: string }>();
  findings: StoredFinding[] = [];
  tasks = new Map<string, { workspaceId: string; spec: FollowUpTaskSpec; description: string; status: string }>();
  artifacts = new Map<string, { workspaceId: string; spec: CorrectionProposalSpec }>();
  notes: Array<{ missionId: string; title: string; body: string }> = [];
  memoryWrites = 0;
  failInsertTask = false;
  private seq = 0;

  addRun(over: Partial<FindingRunRow> = {}): FindingRunRow {
    const id = over.id ?? `run-${this.runs.size + 1}`;
    const run: FindingRunRow = {
      id,
      state: 'triaged',
      workerId: `worker-${id}`,
      taskId: `task-${id}`,
      workspaceId: 'ws-1',
      teamId: 'team-1',
      missionId: 'mission-1',
      policyVersion: 'psq-v1',
      mode: 'propose',
      // A propose run comes from a workspace configured to propose.
      gitConfig: { postSessionQuality: { mode: over.mode ?? 'propose' } },
      ...over,
    };
    this.runs.set(id, run);
    return run;
  }

  async loadRun(runId: string) { await tick(); const r = this.runs.get(runId); return r ? { ...r } : null; }

  async insertFinding(input: { workspaceId: string; signature: string; policyVersion: string; aggregate: FindingLedgerAggregate; now: Date }) {
    await tick();
    if (this.findings.some(f => f.workspaceId === input.workspaceId && f.signature === input.signature && f.policyVersion === input.policyVersion)) return null;
    const row: StoredFinding = {
      ...structuredClone(input.aggregate),
      id: `finding-${++this.seq}`,
      workspaceId: input.workspaceId,
      signature: input.signature,
      policyVersion: input.policyVersion,
      actionState: 'observed',
      actionTaskId: null,
      actionArtifactId: null,
      actionAt: null,
      updatedAt: input.now,
    };
    this.findings.push(row);
    return structuredClone(row);
  }

  async loadFinding(workspaceId: string, signature: string, policyVersion: string) {
    await tick();
    const f = this.findings.find(x => x.workspaceId === workspaceId && x.signature === signature && x.policyVersion === policyVersion);
    return f ? structuredClone(f) : null;
  }

  async updateFindingIfUnchanged(id: string, expectedUpdatedAt: Date, aggregate: FindingLedgerAggregate, updatedAt: Date) {
    await tick();
    const f = this.findings.find(x => x.id === id);
    if (!f || f.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return null;
    Object.assign(f, structuredClone(aggregate), { updatedAt });
    return structuredClone(f);
  }

  async findOpenFollowUpTask(workspaceId: string, findingId: string) {
    await tick();
    for (const [id, t] of this.tasks) {
      if (t.workspaceId === workspaceId && t.spec.context.postSessionFinding.findingId === findingId && !['completed', 'failed', 'cancelled'].includes(t.status)) return id;
    }
    return null;
  }

  async insertTask(workspaceId: string, spec: FollowUpTaskSpec) {
    await tick();
    if (this.failInsertTask) throw new Error('db down');
    const id = `followup-${++this.seq}`;
    this.tasks.set(id, { workspaceId, spec, description: spec.description, status: 'pending' });
    return id;
  }

  async deleteTask(taskId: string) { await tick(); this.tasks.delete(taskId); }

  dispatched: string[] = [];
  async dispatchTask(taskId: string) { await tick(); this.dispatched.push(taskId); }

  async claimAction(findingId: string, claim: { state: 'task_filed' | 'proposal_filed'; taskId?: string; artifactId?: string; now: Date }) {
    await tick();
    const f = this.findings.find(x => x.id === findingId);
    if (!f || f.actionTaskId || f.actionArtifactId || !['observed', 'promoted'].includes(f.actionState)) return false;
    f.actionState = claim.state;
    f.actionTaskId = claim.taskId ?? null;
    f.actionArtifactId = claim.artifactId ?? null;
    f.actionAt = claim.now;
    return true;
  }

  async markPromoted(findingId: string) {
    await tick();
    const f = this.findings.find(x => x.id === findingId);
    if (f && f.actionState === 'observed') f.actionState = 'promoted';
  }

  async upsertProposal(workspaceId: string, _missionId: string | null, spec: CorrectionProposalSpec) {
    await tick();
    for (const [id, a] of this.artifacts) if (a.workspaceId === workspaceId && a.spec.key === spec.key) return id;
    const id = `artifact-${++this.seq}`;
    this.artifacts.set(id, { workspaceId, spec });
    return id;
  }

  async appendToTask(taskId: string, text: string) {
    await tick();
    const t = this.tasks.get(taskId);
    if (t) t.description += text;
  }

  async insertWarning(note: { missionId: string; taskId: string | null; title: string; body: string }) {
    await tick();
    this.notes.push(note);
  }

  async markRunAnalysed(runId: string) {
    await tick();
    const r = this.runs.get(runId);
    if (!r || r.state !== 'triaged') return false;
    r.state = 'analysed';
    return true;
  }

  async recordFailure(runId: string, stage: 'analyse' | 'act', error: string) {
    await tick();
    const r = this.runs.get(runId);
    if (r && r.state === 'triaged') r.actError = `${stage}: ${error}`;
  }

  async listTriaged() { await tick(); return [...this.runs.values()].filter(r => r.state === 'triaged').map(r => r.id); }
}

function finding(over: Partial<PostSessionQualityFinding> = {}): PostSessionQualityFinding {
  return {
    class: 'agent_use',
    severity: 'medium',
    confidence: 0.5,
    title: 'Review or CI needed a fix loop to converge',
    evidenceRefs: [{ kind: 'pr', ref: '7' }],
    signature: 'sig-medium',
    recurrenceKey: 'post_session:agent_use:review_converges',
    proposedAction: 'adjust_guidance',
    summary: 'Review and CI converge without a fix loop. Observed: ciFixAttempts=3.',
    checkId: 'review_converges',
    relatedCheckIds: [],
    ...over,
  };
}

function analysis(findings: PostSessionQualityFinding[]): PostSessionAnalysis {
  return {
    analyserVersion: 'psa1',
    focus: null,
    coverage: { traceAvailability: 'full', traceSource: 'r2', traceMissing: { portions: [], reason: null } },
    results: [],
    verdicts: { pass: 0, fail: findings.length, inconclusive: 0, unsupported: 0, total: findings.length },
    findings,
  };
}

describe('recordPostSessionFindings — aggregation', () => {
  it('writes one ledger row, marks the run analysed and files nothing for a single medium', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1' });
    const res = await recordPostSessionFindings('run-1', analysis([finding()]), { store, now: NOW });
    expect(res.status).toBe('recorded');
    expect(store.findings).toHaveLength(1);
    expect(store.findings[0]).toMatchObject({ occurrenceCount: 1, actionState: 'observed', severity: 'medium' });
    expect(store.findings[0].affectedRefs).toEqual([{ runId: 'run-1', workerId: 'worker-run-1', taskId: 'task-run-1', seenAt: NOW.toISOString() }]);
    expect(store.tasks.size).toBe(0);
    expect(store.runs.get('run-1')!.state).toBe('analysed');
  });

  it('reprocessing the same incident neither counts it again nor files a second task', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1' });
    const crit = analysis([finding({ severity: 'critical', signature: 'sig-crit', class: 'platform', proposedAction: 'file_task' })]);
    await recordPostSessionFindings('run-1', crit, { store, now: NOW });
    // Simulate a crash before the run was marked analysed: it is processed again.
    store.runs.get('run-1')!.state = 'triaged';
    await recordPostSessionFindings('run-1', crit, { store, now: NOW });
    expect(store.findings[0].occurrenceCount).toBe(1);
    expect(store.tasks.size).toBe(1);
    expect(store.notes).toHaveLength(1);
  });

  it('an already-analysed run is a no-op', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1', state: 'analysed' });
    const res = await recordPostSessionFindings('run-1', analysis([finding()]), { store, now: NOW });
    expect(res).toEqual({ status: 'not_ready', runId: 'run-1', state: 'analysed' });
    expect(store.findings).toHaveLength(0);
  });

  it('two same-signature medium incidents aggregate and promote exactly once', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1' });
    store.addRun({ id: 'run-2' });
    store.addRun({ id: 'run-3' });
    await recordPostSessionFindings('run-1', analysis([finding()]), { store, now: NOW });
    expect(store.tasks.size).toBe(0);
    const second = await recordPostSessionFindings('run-2', analysis([finding()]), { store, now: new Date(NOW.getTime() + DAY) });
    expect(second.status).toBe('recorded');
    expect(store.findings).toHaveLength(1);
    expect(store.findings[0]).toMatchObject({ occurrenceCount: 2, actionState: 'task_filed' });
    expect(store.tasks.size).toBe(1);
    const [taskId] = store.tasks.keys();
    expect(store.findings[0].actionTaskId).toBe(taskId);
    // A third occurrence aggregates onto the same row and files nothing new.
    await recordPostSessionFindings('run-3', analysis([finding()]), { store, now: new Date(NOW.getTime() + 2 * DAY) });
    expect(store.findings[0].occurrenceCount).toBe(3);
    expect(store.tasks.size).toBe(1);
    // Medium never warns.
    expect(store.notes).toHaveLength(0);
  });

  it('concurrent same-signature medium incidents aggregate both and promote exactly once', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1' });
    store.addRun({ id: 'run-2' });
    await recordPostSessionFindings('run-1', analysis([finding()]), { store, now: NOW });
    store.addRun({ id: 'run-3' });
    await Promise.all([
      recordPostSessionFindings('run-2', analysis([finding()]), { store, now: new Date(NOW.getTime() + 1000) }),
      recordPostSessionFindings('run-3', analysis([finding()]), { store, now: new Date(NOW.getTime() + 1000) }),
    ]);
    expect(store.findings).toHaveLength(1);
    expect(store.findings[0].occurrenceCount).toBe(3);
    expect(store.tasks.size).toBe(1);
  });

  it('concurrent first sightings of a critical finding create one row and one task', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1' });
    store.addRun({ id: 'run-2' });
    const crit = () => analysis([finding({ severity: 'critical', signature: 'sig-crit', class: 'platform', proposedAction: 'file_task' })]);
    await Promise.all([
      recordPostSessionFindings('run-1', crit(), { store, now: NOW }),
      recordPostSessionFindings('run-2', crit(), { store, now: NOW }),
    ]);
    expect(store.findings).toHaveLength(1);
    expect(store.findings[0].occurrenceCount).toBe(2);
    expect(store.tasks.size).toBe(1);
    expect(store.notes).toHaveLength(1);
  });
});

describe('recordPostSessionFindings — triage outcome label', () => {
  const run = async (findings: PostSessionQualityFinding[], runOver: Partial<FindingRunRow> = {}, labelOutcome?: any) => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1', ...runOver });
    const labels: any[] = [];
    const res = await recordPostSessionFindings('run-1', analysis(findings), {
      store, now: NOW, labelOutcome: labelOutcome ?? (async (l: any) => { labels.push(l); return { ok: true }; }),
    });
    return { res, labels };
  };

  it('labels the triage decision actionable when the analysis found something', async () => {
    const { labels } = await run([finding()]);
    expect(labels).toEqual([{
      teamId: 'team-1', capability: 'buildd.post_session_triage', subject: { type: 'post_session_run', id: 'run-1' },
      source: 'post_session_analysis', label: 'actionable', observedAt: NOW,
    }]);
  });

  it('labels it not_actionable when the only finding is no_action', async () => {
    const { labels } = await run([finding({ class: 'no_action', severity: 'low', proposedAction: 'observe_only' })]);
    expect(labels[0]).toMatchObject({ label: 'not_actionable' });
  });

  it('a run with no team has no decision to label, and a failing label never fails the record', async () => {
    expect((await run([finding()], { teamId: null })).labels).toEqual([]);
    const { res } = await run([finding()], {}, async () => { throw new Error('db down'); });
    expect(res.status).toBe('recorded');
  });
});

describe('recordPostSessionFindings — policy', () => {
  it('critical: files immediately, warns on the mission, and later occurrences update the task', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1' });
    store.addRun({ id: 'run-2' });
    const crit = analysis([finding({ severity: 'critical', signature: 'sig-crit', class: 'platform', proposedAction: 'file_task', confidence: 0.3 })]);
    const res = await recordPostSessionFindings('run-1', crit, { store, now: NOW });
    expect(res.status).toBe('recorded');
    if (res.status !== 'recorded') return;
    expect(res.findings[0]).toMatchObject({ outcome: 'task_filed', reason: 'critical' });
    expect(store.tasks.size).toBe(1);
    const [[taskId, task]] = [...store.tasks];
    expect(task.spec.title).toContain('[post-session]');
    expect(task.spec.context.postSessionFinding.signature).toBe('sig-crit');
    expect(store.notes).toEqual([expect.objectContaining({ missionId: 'mission-1' })]);
    expect(store.notes[0].body).toContain(taskId);
    expect(store.dispatched).toEqual([taskId]);

    await recordPostSessionFindings('run-2', crit, { store, now: new Date(NOW.getTime() + 1000) });
    expect(store.tasks.size).toBe(1);
    expect(store.tasks.get(taskId)!.description).toContain('run-2');
    // One warning per finding, not per occurrence.
    expect(store.notes).toHaveLength(1);
  });

  it('high: files above the threshold, retains below it', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1' });
    store.addRun({ id: 'run-2' });
    await recordPostSessionFindings('run-1', analysis([finding({ severity: 'high', confidence: 0.5, signature: 'sig-low-conf' })]), { store, now: NOW });
    await recordPostSessionFindings('run-2', analysis([finding({ severity: 'high', confidence: 0.85, signature: 'sig-hi-conf' })]), { store, now: NOW });
    const low = store.findings.find(f => f.signature === 'sig-low-conf')!;
    const high = store.findings.find(f => f.signature === 'sig-hi-conf')!;
    expect(low.actionState).toBe('observed');
    expect(high.actionState).toBe('task_filed');
    expect(store.tasks.size).toBe(1);
    expect(store.notes).toHaveLength(0);
  });

  it('honours a workspace-configured confidence threshold', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1', gitConfig: { postSessionQuality: { mode: 'propose', findingPolicy: { highConfidenceThreshold: 0.95 } } } });
    await recordPostSessionFindings('run-1', analysis([finding({ severity: 'high', confidence: 0.85 })]), { store, now: NOW });
    expect(store.tasks.size).toBe(0);
  });

  it('low and no_action: aggregate only', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1' });
    await recordPostSessionFindings('run-1', analysis([
      finding({ severity: 'low', confidence: 1, signature: 'sig-l' }),
      finding({ class: 'no_action', severity: 'low', signature: 'sig-na', proposedAction: 'observe_only' }),
    ]), { store, now: NOW });
    expect(store.findings).toHaveLength(2);
    expect(store.tasks.size).toBe(0);
    expect(store.artifacts.size).toBe(0);
  });

  it('knowledge defect: one deduped correction proposal, no task, no memory write', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1' });
    store.addRun({ id: 'run-2' });
    const k = () => analysis([finding({
      class: 'knowledge', severity: 'high', confidence: 0.8, signature: 'sig-k',
      proposedAction: 'propose_memory_correction',
      title: 'Retrieved knowledge contradicts shipped state',
      evidenceRefs: [{ kind: 'memory', ref: 'mem-1' }, { kind: 'pr', ref: '99' }],
    })]);
    await recordPostSessionFindings('run-1', k(), { store, now: NOW });
    await recordPostSessionFindings('run-2', k(), { store, now: new Date(NOW.getTime() + 1000) });
    expect(store.tasks.size).toBe(0);
    expect(store.artifacts.size).toBe(1);
    const [[artifactId, a]] = [...store.artifacts];
    expect(a.spec.metadata).toMatchObject({ kind: 'memory_correction_proposal', status: 'proposed', memorySourceIds: ['mem-1'] });
    expect(store.findings[0]).toMatchObject({ actionState: 'proposal_filed', actionArtifactId: artifactId, occurrenceCount: 2 });
    expect(store.memoryWrites).toBe(0);
  });

  it('shadow mode records the finding and marks it promoted, but files nothing', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1', mode: 'shadow' as PostSessionQualityMode });
    const res = await recordPostSessionFindings('run-1', analysis([finding({ severity: 'critical', signature: 'sig-crit', class: 'platform' })]), { store, now: NOW });
    expect(store.findings[0].actionState).toBe('promoted');
    expect(store.tasks.size).toBe(0);
    expect(store.notes).toHaveLength(0);
    if (res.status === 'recorded') expect(res.findings[0].outcome).toBe('would_act');
  });

  it('a workspace moved out of propose stops filing at once, even for runs recorded under propose', async () => {
    for (const mode of ['shadow', 'off'] as const) {
      const store = new FakeStore();
      store.addRun({ id: 'run-1', mode: 'propose', gitConfig: { postSessionQuality: { mode } } });
      const res = await recordPostSessionFindings('run-1', analysis([finding({ severity: 'critical', signature: 'sig-crit', class: 'platform' })]), { store, now: NOW });
      expect(store.tasks.size).toBe(0);
      expect(store.notes).toHaveLength(0);
      expect(store.findings[0].actionState).toBe('promoted');
      if (res.status === 'recorded') expect(res.findings[0].outcome).toBe('would_act');
    }
  });

  it('a run recorded under shadow does not start filing when the workspace later moves to propose', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1', mode: 'shadow', gitConfig: { postSessionQuality: { mode: 'propose' } } });
    await recordPostSessionFindings('run-1', analysis([finding({ severity: 'critical', signature: 'sig-crit', class: 'platform' })]), { store, now: NOW });
    expect(store.tasks.size).toBe(0);
  });

  it('adopts an orphaned follow-up task left by a crash between insert and claim', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1' });
    const crit = analysis([finding({ severity: 'critical', signature: 'sig-crit', class: 'platform' })]);
    // First pass fails after the ledger write but before the task exists.
    store.failInsertTask = true;
    const failed = await recordPostSessionFindings('run-1', crit, { store, now: NOW });
    expect(failed.status).toBe('action_failed');
    expect(store.runs.get('run-1')!.state).toBe('triaged');
    expect(store.runs.get('run-1')!.actError).toContain('db down');
    // Plant an orphan as if a previous attempt inserted it and then died.
    store.failInsertTask = false;
    const orphan = await store.insertTask('ws-1', { context: { postSessionFinding: { findingId: store.findings[0].id } } } as any);
    await recordPostSessionFindings('run-1', crit, { store, now: NOW });
    expect(store.tasks.size).toBe(1);
    expect(store.findings[0].actionTaskId).toBe(orphan);
    expect(store.findings[0].occurrenceCount).toBe(1);
    expect(store.runs.get('run-1')!.state).toBe('analysed');
  });
});

describe('recordTriagedRuns', () => {
  it('analyses and records every triaged run, isolating failures', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1' });
    store.addRun({ id: 'run-2' });
    store.addRun({ id: 'run-3', state: 'skipped' });
    const summary = await recordTriagedRuns({
      store,
      now: NOW,
      analyse: async (runId) => runId === 'run-2'
        ? { status: 'error', error: 'boom' }
        : { status: 'analysed', runId, analysis: analysis([finding()]) },
    });
    expect(summary).toMatchObject({ candidates: 2, recorded: 1, analyseErrors: 1, recordErrors: 0 });
    expect(store.runs.get('run-1')!.state).toBe('analysed');
    expect(store.runs.get('run-2')!.state).toBe('triaged');
    expect(store.runs.get('run-2')!.actError).toBe('analyse: boom');
  });

  it('reports actionable, filed, suppressed-duplicate and transcript-unread counts', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1' });
    store.addRun({ id: 'run-2' });
    store.addRun({ id: 'run-3' });
    const crit = finding({ severity: 'critical', signature: 'sig-crit', class: 'platform' });
    const unread = analysis([crit]);
    unread.coverage = { traceAvailability: 'absent', traceSource: null, traceMissing: { portions: [], reason: 'read_failed' } };
    const summary = await recordTriagedRuns({
      store,
      now: NOW,
      analyse: async runId => ({
        status: 'analysed',
        runId,
        analysis: runId === 'run-3' ? unread : analysis([crit, finding({ severity: 'low', signature: 'sig-low' })]),
      }),
    });
    expect(summary).toMatchObject({
      candidates: 3,
      recorded: 3,
      // run-1 files the task; run-2 and run-3 append to it instead of filing again.
      actionable: 3,
      tasksFiled: 1,
      duplicatesSuppressed: 2,
      transcriptUnread: 1,
    });
    expect(store.tasks.size).toBe(1);
  });

  it('stops starting new runs once the time budget is spent, leaving the rest triaged', async () => {
    const store = new FakeStore();
    store.addRun({ id: 'run-1' });
    store.addRun({ id: 'run-2' });
    let started = 0;
    const summary = await recordTriagedRuns({
      store,
      now: NOW,
      shouldContinue: () => started < 1,
      analyse: async runId => { started++; return { status: 'analysed', runId, analysis: analysis([finding()]) }; },
    });
    expect(summary).toMatchObject({ candidates: 2, recorded: 1, deferred: 1 });
    expect(store.runs.get('run-2')!.state).toBe('triaged');
  });
});

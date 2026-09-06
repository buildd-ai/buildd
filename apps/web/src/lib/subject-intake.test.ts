import { describe, expect, it } from 'bun:test';
import {
  canonicalTask,
  intakeSubject,
  subjectClaimKey,
  type SubjectClaim,
  type SubjectIntakeRepository,
  type SubjectTask,
} from './subject-intake';
import { DEFAULT_SUBJECT_POLICY } from '@buildd/core/subject-anchor-observe';

const anchor = {
  version: 1 as const,
  kind: 'pull_request' as const,
  prNumber: 42,
  headSha: 'a'.repeat(40),
  source: 'system' as const,
  confidence: 'exact' as const,
};
const propose = { ...DEFAULT_SUBJECT_POLICY, mode: 'propose' as const };

class FakeRepository implements SubjectIntakeRepository<SubjectTask> {
  claim: SubjectClaim | null = null;
  tasks = new Map<string, SubjectTask>();
  reports: Array<{ taskId: string; reportingTaskId?: string | null; note: string }> = [];
  createCount = 0;

  async reserve(input: { token: string; expiresAt: Date }) {
    if (this.claim) return null;
    this.claim = {
      id: 'claim-1',
      canonicalTaskId: null,
      reservationToken: input.token,
      reservationExpiresAt: input.expiresAt,
      generation: 1,
    };
    return this.claim;
  }
  // A claim read is a SNAPSHOT: production hands back a row, not a live handle,
  // so a caller keeps looking at the generation it read while another caller
  // rotates the real row. Returning `this.claim` directly would hide every
  // stale-read bug this fake exists to expose.
  async getActiveClaim() { return this.claim ? { ...this.claim } : null; }
  async takeReservation(_id: string, expected: string | null, token: string, expiresAt: Date) {
    if (this.claim?.reservationToken !== expected) return false;
    this.claim.reservationToken = token;
    this.claim.reservationExpiresAt = expiresAt;
    return true;
  }
  async finalizeReservation(_id: string, token: string, taskId: string) {
    if (this.claim?.reservationToken !== token) return false;
    this.claim.canonicalTaskId = taskId;
    this.claim.reservationToken = null;
    this.claim.reservationExpiresAt = null;
    return true;
  }
  async releaseReservation() { this.claim = null; }
  // Mirrors the guarded UPDATE in subject-intake-db.ts, including the
  // generation compare-and-swap. `rotations` records every attempt so a test can
  // assert what the production code passed, not just what the fake accepted.
  rotations: Array<{ expectedGeneration: number; accepted: boolean }> = [];
  async rotateClaim(
    _id: string,
    canonicalTaskId: string,
    token: string,
    expiresAt: Date,
    expectedGeneration: number,
  ) {
    const accepted = Boolean(
      this.claim
      && this.claim.generation === expectedGeneration
      && this.claim.canonicalTaskId !== null
      && this.claim.reservationToken === null,
    );
    this.rotations.push({ expectedGeneration, accepted });
    if (!accepted || !this.claim) return false;
    this.claim.canonicalTaskId = canonicalTaskId;
    this.claim.reservationToken = token;
    this.claim.reservationExpiresAt = expiresAt;
    this.claim.generation += 1;
    return true;
  }
  async getTask(id: string) { return this.tasks.get(id) ?? null; }
  // Parking hook for the stale-read race. `gateConnectedCall` names the call
  // index that snapshots the chain and then blocks, so a test can hold one caller
  // between its read and its rotation while another caller finishes — the only
  // interleaving in which a stale generation reaches rotateClaim.
  connectedCalls = 0;
  gateConnectedCall: number | null = null;
  private gateRelease: (() => void) | null = null;
  private gateParked: (() => void) | null = null;
  parked: Promise<void> = new Promise(resolve => { this.gateParked = resolve; });
  releaseGate() { this.gateRelease?.(); }
  async getConnectedTasks() {
    this.connectedCalls += 1;
    // Copies, not live objects: a DB read hands back a snapshot, and a caller
    // that keeps seeing later mutations cannot act on stale state at all.
    const snapshot = [...this.tasks.values()].map(task => ({ ...task }));
    if (this.gateConnectedCall === this.connectedCalls) {
      await new Promise<void>(resolve => {
        this.gateRelease = resolve;
        this.gateParked?.();
      });
    }
    return snapshot;
  }
  async createTask(input: { id: string; subjectDedupeScope: 'active' | 'none'; subjectResolution?: 'filed_anyway' }) {
    this.createCount += 1;
    const task = {
      id: input.id,
      status: 'pending',
      parentTaskId: null,
      // Strictly increasing, unlike `new Date()`: two inserts inside one
      // millisecond would leave canonicalTask() tie-breaking on uuid order, which
      // is not how a real insert sequence behaves and makes "the newest live
      // member" mean whatever the random ids happened to sort to.
      createdAt: new Date(Date.now() + this.createCount),
      subjectDedupeScope: input.subjectDedupeScope,
      subjectResolution: input.subjectResolution,
    };
    this.tasks.set(task.id, task);
    return task;
  }
  async abortCreatedTask(taskId: string) { this.tasks.delete(taskId); }
  async updateSuperseded(taskId: string, successorTaskId: string) {
    const task = this.tasks.get(taskId)!;
    task.subjectResolution = 'superseded';
    task.subjectSupersededByTaskId = successorTaskId;
  }
  async addReport(input: { taskId: string; reportingTaskId?: string | null; note: string }) {
    this.reports.push(input);
    return `report-${this.reports.length}`;
  }
}

describe('subject intake', () => {
  it('uses exact structured keys only; semantic similarity has no key', () => {
    expect(subjectClaimKey('ws', null)).toBeNull();
    expect(subjectClaimKey('ws', { ...anchor, headSha: 'abcdef0' })).toBeNull();
    expect(subjectClaimKey('ws', anchor)?.keyType).toBe('pr_generation');
  });

  it('creates and finalizes the first atomic claimant', async () => {
    const repository = new FakeRepository();
    const result = await intakeSubject({
      workspaceId: 'ws',
      policy: propose,
      anchor,
      origin: 'webhook',
      repository,
    });
    expect(result.outcome.action).toBe('created');
    expect(repository.claim?.canonicalTaskId).toBe(result.task.id);
    expect(repository.createCount).toBe(1);
  });

  it('attaches a race loser to the live canonical without creating a sibling', async () => {
    const repository = new FakeRepository();
    const first = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'webhook', repository });
    const second = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'api', repository });
    expect(second.outcome).toEqual({
      action: 'attached',
      taskId: first.task.id,
      reportId: 'report-1',
    });
    expect(repository.createCount).toBe(1);
  });

  it('admits one creator when two requests race for the same generation', async () => {
    const repository = new FakeRepository();
    const results = await Promise.all([
      intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'webhook', repository }),
      intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'watcher', repository }),
    ]);
    expect(results.map(result => result.outcome.action).sort()).toEqual(['attached', 'created']);
    expect(repository.createCount).toBe(1);
    expect(repository.claim?.canonicalTaskId).toBeTruthy();
  });

  it('requires a nonblank file-anyway reason and links both tasks', async () => {
    const repository = new FakeRepository();
    const first = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'api', repository });
    await expect(intakeSubject({
      workspaceId: 'ws', policy: propose, anchor, origin: 'mcp', repository, fileAnywayReason: '   ',
    })).rejects.toThrow('file_anyway_reason_required');
    const result = await intakeSubject({
      workspaceId: 'ws',
      policy: propose,
      anchor,
      origin: 'mcp',
      repository,
      fileAnywayReason: 'Independent audit',
    });
    expect(result.outcome).toMatchObject({
      action: 'filed_anyway',
      relatedTaskId: first.task.id,
      reason: 'Independent audit',
    });
    expect(repository.reports).toHaveLength(2);
    expect(repository.reports.map(report => report.reportingTaskId)).toEqual([
      result.task.id,
      first.task.id,
    ]);
    const later = await intakeSubject({
      workspaceId: 'ws', policy: propose, anchor, origin: 'api', repository,
    });
    expect(later.outcome).toMatchObject({ action: 'attached', taskId: first.task.id });
  });

  it('does not allow a trusted system filer to use the human escape hatch', async () => {
    const repository = new FakeRepository();
    await expect(intakeSubject({
      workspaceId: 'ws',
      policy: propose,
      anchor,
      origin: 'webhook',
      repository,
      fileAnywayReason: 'bypass',
    })).rejects.toThrow('file_anyway_not_allowed');
  });

  it('allows a friction-report filing to use the human escape hatch', async () => {
    const repository = new FakeRepository();
    const first = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'api', repository });
    const result = await intakeSubject({
      workspaceId: 'ws',
      policy: propose,
      anchor,
      origin: 'friction',
      repository,
      fileAnywayReason: 'reported anyway',
    });
    expect(result.outcome).toMatchObject({ action: 'filed_anyway', relatedTaskId: first.task.id });
  });

  it('lets a trusted retry supersede the newest live chain member', async () => {
    const repository = new FakeRepository();
    const first = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'webhook', repository });
    first.task.parentTaskId = 'ancestor';
    repository.tasks.set('ancestor', {
      id: 'ancestor', status: 'failed', parentTaskId: null, createdAt: new Date(0),
    });
    const result = await intakeSubject({
      workspaceId: 'ws',
      policy: propose,
      anchor,
      origin: 'webhook',
      parentTaskId: first.task.id,
      repository,
    });
    expect(result.outcome).toMatchObject({ action: 'superseded', taskId: first.task.id });
    expect(first.task.subjectResolution).toBe('superseded');
    expect(first.task.subjectSupersededByTaskId).toBe(result.task.id);
  });

  it('creates with prior context when every chain member is terminal', async () => {
    const repository = new FakeRepository();
    const first = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'api', repository });
    first.task.status = 'completed';
    const result = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'api', repository });
    expect(result.outcome.action).toBe('created');
    expect(repository.reports[0]?.note).toContain('prior_terminal_context');
  });

  it('returns superseded when the claim still points at an old owner with a live successor', async () => {
    const repository = new FakeRepository();
    const first = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'api', repository });
    const successor = {
      id: 'successor',
      status: 'pending',
      parentTaskId: first.task.id,
      createdAt: new Date(Date.now() + 1),
    };
    repository.tasks.set(successor.id, successor);
    first.task.subjectResolution = 'superseded';
    first.task.subjectSupersededByTaskId = successor.id;
    const result = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'api', repository });
    expect(result.outcome).toEqual({
      action: 'superseded',
      taskId: first.task.id,
      successorTaskId: successor.id,
    });
    expect(repository.createCount).toBe(1);
  });

  it('chooses the newest nonterminal member across a retry graph', () => {
    const tasks = [
      { id: 'old-live', status: 'pending', parentTaskId: null, createdAt: new Date(1) },
      { id: 'new-terminal', status: 'failed', parentTaskId: 'old-live', createdAt: new Date(3) },
      { id: 'new-live', status: 'assigned', parentTaskId: 'new-terminal', createdAt: new Date(2) },
    ];
    expect(canonicalTask(tasks)?.id).toBe('new-live');
  });

  // ── generation: the rotation counter is the optimistic lock ────────────────
  // The schema promises "monotonic counter bumped on each supersession". Nothing
  // wrote it, so every row sat at 1 and rotateClaim's guards
  // (canonical_task_id IS NOT NULL AND reservation_token IS NULL) were passable
  // by a caller working from state it read BEFORE another caller's rotation:
  // an ABA lost update. These tests pin the counter's two jobs — it advances,
  // and a rotation quoting a superseded value is refused.

  it('refuses a rotation quoting a stale generation and re-reads instead', async () => {
    const repository = new FakeRepository();
    const first = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'webhook', repository });
    first.task.parentTaskId = 'ancestor';
    repository.tasks.set('ancestor', {
      id: 'ancestor', status: 'failed', parentTaskId: null, createdAt: new Date(0),
    });
    const retry = () => intakeSubject({
      workspaceId: 'ws',
      policy: propose,
      anchor,
      origin: 'webhook',
      parentTaskId: first.task.id,
      repository,
    });

    // Caller B reads the claim at generation 1 and the pre-race chain, then parks.
    repository.gateConnectedCall = 1;
    const slow = retry();
    await repository.parked;

    // Caller A runs a complete trusted retry: claim rotates to generation 2 and
    // the canonical owner becomes A's successor.
    repository.gateConnectedCall = null;
    const fast = await retry();
    expect(fast.outcome).toMatchObject({ action: 'superseded', taskId: first.task.id });

    // B now attempts its rotation with the generation it read.
    repository.releaseGate();
    const slowResult = await slow;

    // The stale rotation was refused...
    expect(repository.rotations).toContainEqual({ expectedGeneration: 1, accepted: false });
    // ...and B restarted, so it supersedes what A actually installed rather than
    // rotating A's successor away behind its back.
    expect(slowResult.outcome).toMatchObject({
      action: 'superseded',
      taskId: fast.task.id,
      successorTaskId: slowResult.task.id,
    });
    // One unbroken chain: T0 -> A's successor -> B's successor. Overwriting
    // first.task's edge with B's successor is the lost update this guards.
    expect(first.task.subjectSupersededByTaskId).toBe(fast.task.id);
    expect(repository.tasks.get(fast.task.id)?.subjectSupersededByTaskId).toBe(slowResult.task.id);
    // Two accepted rotations, one per successor.
    expect(repository.claim?.generation).toBe(3);
  });

  it('advances the counter on the terminal-canonical rotation and quotes the current value', async () => {
    const repository = new FakeRepository();
    const first = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'api', repository });
    first.task.status = 'completed';
    const second = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'api', repository });
    expect(second.outcome.action).toBe('created');
    repository.tasks.get(second.task.id)!.status = 'failed';
    const third = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'api', repository });
    expect(third.outcome.action).toBe('created');

    // Each rotation quotes the generation it read — a hardcoded value would make
    // the second attempt quote a value the row no longer carries.
    expect(repository.rotations).toEqual([
      { expectedGeneration: 1, accepted: true },
      { expectedGeneration: 2, accepted: true },
    ]);
    expect(repository.claim?.generation).toBe(3);
  });

  it('gives up instead of retrying forever when a rotation can never be accepted', async () => {
    const repository = new FakeRepository();
    const first = await intakeSubject({ workspaceId: 'ws', policy: propose, anchor, origin: 'api', repository });
    first.task.status = 'completed';
    // A rotation that always loses (in production: a caller quoting a generation
    // the row will never carry again) used to recurse without bound.
    repository.rotateClaim = async () => false;
    await expect(intakeSubject({
      workspaceId: 'ws', policy: propose, anchor, origin: 'api', repository,
    })).rejects.toThrow('subject_claim_contended');
    // The failed attempts created nothing.
    expect(repository.createCount).toBe(1);
  });

  it('keeps observe mode behavior unchanged', async () => {
    const repository = new FakeRepository();
    const result = await intakeSubject({
      workspaceId: 'ws',
      policy: DEFAULT_SUBJECT_POLICY,
      anchor,
      origin: 'webhook',
      repository,
    });
    expect(result.outcome.action).toBe('created');
    expect(repository.claim).toBeNull();
  });
});

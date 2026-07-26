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
    };
    return this.claim;
  }
  async getActiveClaim() { return this.claim; }
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
  async rotateClaim(_id: string, canonicalTaskId: string, token: string, expiresAt: Date) {
    if (!this.claim) return false;
    this.claim.canonicalTaskId = canonicalTaskId;
    this.claim.reservationToken = token;
    this.claim.reservationExpiresAt = expiresAt;
    return true;
  }
  async getTask(id: string) { return this.tasks.get(id) ?? null; }
  async getConnectedTasks() { return [...this.tasks.values()]; }
  async createTask(input: { id: string; subjectDedupeScope: 'active' | 'none'; subjectResolution?: 'filed_anyway' }) {
    this.createCount += 1;
    const task = {
      id: input.id,
      status: 'pending',
      parentTaskId: null,
      createdAt: new Date(),
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

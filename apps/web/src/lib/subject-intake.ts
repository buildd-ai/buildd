import type { SubjectIntakeOutcome, TaskSubjectAnchor } from '@buildd/shared';
import type {
  SubjectFilingOrigin,
  SubjectPolicy,
} from '@buildd/core/subject-anchor-observe';
import { createHash, randomUUID } from 'node:crypto';

export type { SubjectIntakeOutcome } from '@buildd/shared';

export interface SubjectTask {
  id: string;
  status: string;
  parentTaskId: string | null;
  createdAt: Date;
  hasOpenWorkerPr?: boolean;
  subjectDedupeScope?: 'active' | 'retry_chain' | 'none' | null;
  subjectResolution?: string | null;
  subjectSupersededByTaskId?: string | null;
}

export interface SubjectClaim {
  id: string;
  canonicalTaskId: string | null;
  reservationToken: string | null;
  reservationExpiresAt: Date | null;
  /**
   * Rotation counter, and the optimistic-lock token for {@link
   * SubjectIntakeRepository.rotateClaim}. Every caller that rotates a claim must
   * pass back the generation it read, so a rotation computed from stale state
   * fails instead of overwriting a successor installed in the meantime.
   */
  generation: number;
}

export interface SubjectIntakeRepository<TTask extends SubjectTask> {
  reserve(input: {
    workspaceId: string;
    keyType: string;
    keyHash: string;
    token: string;
    expiresAt: Date;
  }): Promise<SubjectClaim | null>;
  getActiveClaim(workspaceId: string, keyType: string, keyHash: string): Promise<SubjectClaim | null>;
  takeReservation(claimId: string, expectedToken: string | null, token: string, expiresAt: Date): Promise<boolean>;
  finalizeReservation(claimId: string, token: string, taskId: string): Promise<boolean>;
  releaseReservation(claimId: string, token: string, restoreCanonicalTaskId?: string | null): Promise<void>;
  /**
   * Reuse an owned claim for the next generation: drop the canonical owner, take
   * a fresh reservation, bump `generation`. Guarded on `expectedGeneration` —
   * returns false when the row has rotated since it was read, which the caller
   * MUST treat as "re-read and start over", never as a no-op.
   */
  rotateClaim(
    claimId: string,
    canonicalTaskId: string,
    token: string,
    expiresAt: Date,
    expectedGeneration: number,
  ): Promise<boolean>;
  getTask(taskId: string): Promise<TTask | null>;
  getConnectedTasks(taskId: string): Promise<TTask[]>;
  createTask(input: { id: string; subjectDedupeScope: 'active' | 'none'; subjectResolution?: 'filed_anyway' }): Promise<TTask>;
  abortCreatedTask(taskId: string): Promise<void>;
  updateSuperseded(taskId: string, successorTaskId: string): Promise<void>;
  addReport(input: {
    taskId: string;
    reportingTaskId?: string | null;
    origin: SubjectFilingOrigin;
    reporterId?: string | null;
    note: string;
    anchor: TaskSubjectAnchor;
  }): Promise<string>;
}

export interface SubjectIntakeInput<TTask extends SubjectTask> {
  workspaceId: string;
  policy: Required<SubjectPolicy>;
  anchor: TaskSubjectAnchor | null;
  origin: SubjectFilingOrigin;
  reporterId?: string | null;
  parentTaskId?: string | null;
  fileAnywayReason?: unknown;
  normalizedIntentId?: string | null;
  note?: string;
  repository: SubjectIntakeRepository<TTask>;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const TRUSTED_RETRY_ORIGINS = new Set<SubjectFilingOrigin>(['webhook', 'watcher']);
const FILE_ANYWAY_ORIGINS = new Set<SubjectFilingOrigin>(['dashboard', 'api', 'mcp']);
const RESERVATION_MS = 15_000;
/**
 * Bound on the re-read-and-start-over loop below. Every retry is triggered by
 * losing a guarded write (a reservation takeover, or a `generation` mismatch on
 * rotation), and each one re-reads fresh state, so real contention clears in one
 * or two passes. The cap exists because the alternative is unbounded recursion
 * hammering the DB: before the generation lock a rotation could effectively only
 * fail transiently, but a caller quoting a value the row will never carry again
 * would otherwise retry forever.
 */
const MAX_INTAKE_ATTEMPTS = 5;

export function subjectClaimKey(
  workspaceId: string,
  anchor: TaskSubjectAnchor | null,
  normalizedIntentId?: string | null,
): { keyType: string; keyHash: string } | null {
  let keyType: string;
  let parts: Array<string | number | null>;

  if (
    anchor?.kind === 'pull_request'
    && anchor.prNumber
    && anchor.headSha
    && anchor.headSha.length >= 40
  ) {
    keyType = 'pr_generation';
    parts = [workspaceId, anchor.prNumber, anchor.headSha];
  } else if (anchor?.kind === 'error' && anchor.errorSignature) {
    keyType = 'error';
    parts = [workspaceId, anchor.errorSignature, anchor.subjectMissionId ?? null];
  } else if (anchor?.kind === 'mission' && anchor.subjectMissionId && normalizedIntentId?.trim()) {
    keyType = 'mission_intent';
    parts = [workspaceId, anchor.subjectMissionId, normalizedIntentId.trim()];
  } else {
    return null;
  }

  return {
    keyType,
    keyHash: createHash('sha256').update(JSON.stringify(parts)).digest('hex'),
  };
}

function isLive(task: SubjectTask): boolean {
  return !TERMINAL.has(task.status) || (task.status === 'completed' && task.hasOpenWorkerPr === true);
}

export function canonicalTask<TTask extends SubjectTask>(tasks: TTask[]): TTask | null {
  const ordered = tasks
    .filter(task => task.subjectDedupeScope !== 'none')
    .sort((a, b) =>
    b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  return ordered.find(isLive) ?? ordered[0] ?? null;
}

async function waitForCanonical<TTask extends SubjectTask>(
  input: SubjectIntakeInput<TTask>,
  key: { keyType: string; keyHash: string },
): Promise<SubjectClaim> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const claim = await input.repository.getActiveClaim(input.workspaceId, key.keyType, key.keyHash);
    if (!claim) throw new Error('subject_claim_disappeared');
    if (claim.canonicalTaskId) return claim;
    if (claim.reservationExpiresAt && claim.reservationExpiresAt <= new Date()) return claim;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('subject_claim_pending');
}

export async function intakeSubject<TTask extends SubjectTask>(
  input: SubjectIntakeInput<TTask>,
  attempt = 0,
): Promise<{ task: TTask; outcome: SubjectIntakeOutcome }> {
  const restart = () => {
    if (attempt + 1 >= MAX_INTAKE_ATTEMPTS) throw new Error('subject_claim_contended');
    return intakeSubject(input, attempt + 1);
  };
  if (input.fileAnywayReason !== undefined && typeof input.fileAnywayReason !== 'string') {
    throw new Error('file_anyway_reason_required');
  }
  const rawReason = typeof input.fileAnywayReason === 'string' ? input.fileAnywayReason : null;
  const reason = rawReason?.trim() ?? null;
  if (rawReason !== null && !reason) throw new Error('file_anyway_reason_required');
  if (reason && !FILE_ANYWAY_ORIGINS.has(input.origin)) {
    throw new Error('file_anyway_not_allowed');
  }

  const key = subjectClaimKey(input.workspaceId, input.anchor, input.normalizedIntentId);
  if (input.policy.mode === 'observe' || !key || !input.anchor) {
    const task = await input.repository.createTask({
      id: randomUUID(),
      subjectDedupeScope: 'active',
    });
    return { task, outcome: { action: 'created', taskId: task.id } };
  }

  const token = randomUUID();
  const expiresAt = new Date(Date.now() + RESERVATION_MS);
  let claim = await input.repository.reserve({
    workspaceId: input.workspaceId,
    ...key,
    token,
    expiresAt,
  });

  if (claim) {
    try {
      const task = await input.repository.createTask({
        id: randomUUID(),
        subjectDedupeScope: 'active',
      });
      if (!await input.repository.finalizeReservation(claim.id, token, task.id)) {
        await input.repository.abortCreatedTask(task.id);
        throw new Error('subject_claim_finalize_failed');
      }
      return { task, outcome: { action: 'created', taskId: task.id } };
    } catch (error) {
      await input.repository.releaseReservation(claim.id, token);
      throw error;
    }
  }

  claim = await waitForCanonical(input, key);
  if (!claim.canonicalTaskId) {
    const recovered = await input.repository.takeReservation(
      claim.id,
      claim.reservationToken,
      token,
      expiresAt,
    );
    if (!recovered) return restart();
    try {
      const task = await input.repository.createTask({
        id: randomUUID(),
        subjectDedupeScope: 'active',
      });
      if (!await input.repository.finalizeReservation(claim.id, token, task.id)) {
        await input.repository.abortCreatedTask(task.id);
        throw new Error('subject_claim_finalize_failed');
      }
      return { task, outcome: { action: 'created', taskId: task.id } };
    } catch (error) {
      await input.repository.releaseReservation(claim.id, token);
      throw error;
    }
  }

  const connected = await input.repository.getConnectedTasks(claim.canonicalTaskId);
  const canonical = canonicalTask(connected);
  if (!canonical) throw new Error('subject_canonical_missing');
  const claimedTask = connected.find(task => task.id === claim.canonicalTaskId);
  const existingSuccessor = claimedTask?.subjectSupersededByTaskId
    ? connected.find(task => task.id === claimedTask.subjectSupersededByTaskId)
    : null;
  if (
    existingSuccessor
    && (
      isLive(existingSuccessor)
      || claimedTask?.subjectResolution === 'reconciled'
      || existingSuccessor.subjectResolution === 'reconciled'
    )
  ) {
    return {
      task: existingSuccessor,
      outcome: {
        action: 'superseded',
        taskId: claimedTask!.id,
        successorTaskId: existingSuccessor.id,
      },
    };
  }

  if (reason) {
    const task = await input.repository.createTask({
      id: randomUUID(),
      subjectDedupeScope: 'none',
      subjectResolution: 'filed_anyway',
    });
    await input.repository.addReport({
      taskId: canonical.id,
      reportingTaskId: task.id,
      origin: input.origin,
      reporterId: input.reporterId,
      note: `filed_anyway:${reason}`,
      anchor: input.anchor,
    });
    await input.repository.addReport({
      taskId: task.id,
      reportingTaskId: canonical.id,
      origin: input.origin,
      reporterId: input.reporterId,
      note: `related_canonical:${canonical.id}`,
      anchor: input.anchor,
    });
    return {
      task,
      outcome: { action: 'filed_anyway', taskId: task.id, relatedTaskId: canonical.id, reason },
    };
  }

  const trustedRetry = Boolean(
    input.parentTaskId
    && TRUSTED_RETRY_ORIGINS.has(input.origin)
    && connected.some(task => task.id === input.parentTaskId),
  );
  if (trustedRetry) {
    const successorId = randomUUID();
    if (!await input.repository.rotateClaim(claim.id, successorId, token, expiresAt, claim.generation)) {
      return restart();
    }
    try {
      const successor = await input.repository.createTask({
        id: successorId,
        subjectDedupeScope: 'active',
      });
      await input.repository.updateSuperseded(canonical.id, successor.id);
      if (!await input.repository.finalizeReservation(claim.id, token, successor.id)) {
        await input.repository.abortCreatedTask(successor.id);
        throw new Error('subject_claim_finalize_failed');
      }
      return {
        task: successor,
        outcome: { action: 'superseded', taskId: canonical.id, successorTaskId: successor.id },
      };
    } catch (error) {
      await input.repository.releaseReservation(claim.id, token, canonical.id);
      throw error;
    }
  }

  if (!isLive(canonical)) {
    const successorId = randomUUID();
    if (!await input.repository.rotateClaim(claim.id, successorId, token, expiresAt, claim.generation)) {
      return restart();
    }
    try {
      const task = await input.repository.createTask({
        id: successorId,
        subjectDedupeScope: 'active',
      });
      await input.repository.addReport({
        taskId: task.id,
        reportingTaskId: canonical.id,
        origin: input.origin,
        reporterId: input.reporterId,
        note: `prior_terminal_context:${canonical.id}`,
        anchor: input.anchor,
      });
      if (!await input.repository.finalizeReservation(claim.id, token, task.id)) {
        await input.repository.abortCreatedTask(task.id);
        throw new Error('subject_claim_finalize_failed');
      }
      return { task, outcome: { action: 'created', taskId: task.id } };
    } catch (error) {
      await input.repository.releaseReservation(claim.id, token, canonical.id);
      throw error;
    }
  }

  const reportId = await input.repository.addReport({
    taskId: canonical.id,
    origin: input.origin,
    reporterId: input.reporterId,
    note: input.note?.trim() || 'subject_filing_attached',
    anchor: input.anchor,
  });
  return {
    task: canonical,
    outcome: { action: 'attached', taskId: canonical.id, reportId },
  };
}

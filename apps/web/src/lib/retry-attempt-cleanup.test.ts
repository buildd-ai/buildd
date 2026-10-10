import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { db } from '@buildd/core/db';
import { workspaces, tasks, workers } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { cancelRetryAttemptsForMergedPr } from './retry-attempt-cleanup';

describe('cancelRetryAttemptsForMergedPr', () => {
  let workspaceId: string;

  beforeAll(async () => {
    // Create a test workspace
    const ws = await db.insert(workspaces).values({
      id: crypto.randomUUID(),
      name: 'test-workspace',
      slug: `test-slug-${Date.now()}`,
      teamId: crypto.randomUUID(),
      accessMode: 'open',
      gitConfig: {},
    }).returning({ id: workspaces.id });
    workspaceId = ws[0].id;
  });

  afterEach(async () => {
    // Clean up test tasks
    await db.delete(tasks).where(eq(tasks.workspaceId, workspaceId));
  });

  it('should cancel pending retry attempts for merged PR', async () => {
    const prNumber = 1001;
    const conflictRetryTask = await db.insert(tasks).values({
      id: crypto.randomUUID(),
      workspaceId,
      title: 'conflict retry for PR 1001',
      taskClass: 'attempt',
      status: 'pending',
      conflictRetryPrNumber: prNumber,
      conflictRetryHeadSha: 'abc123',
    }).returning({ id: tasks.id });

    const ciRetryTask = await db.insert(tasks).values({
      id: crypto.randomUUID(),
      workspaceId,
      title: 'CI retry for PR 1001',
      taskClass: 'attempt',
      status: 'pending',
      ciRetryPrNumber: prNumber,
      ciRetryHeadSha: 'def456',
    }).returning({ id: tasks.id });

    // Unrelated task
    const otherTask = await db.insert(tasks).values({
      id: crypto.randomUUID(),
      workspaceId,
      title: 'other task for PR 1002',
      taskClass: 'attempt',
      status: 'pending',
      conflictRetryPrNumber: 1002,
      conflictRetryHeadSha: 'ghi789',
    }).returning({ id: tasks.id });

    await cancelRetryAttemptsForMergedPr({
      workspaceId,
      prNumber,
      reason: 'PR merged',
    });

    // Check that the target tasks are cancelled
    const conflictAfter = await db.query.tasks.findFirst({
      where: eq(tasks.id, conflictRetryTask[0].id),
      columns: { status: true },
    });
    expect(conflictAfter?.status).toBe('cancelled');

    const ciAfter = await db.query.tasks.findFirst({
      where: eq(tasks.id, ciRetryTask[0].id),
      columns: { status: true },
    });
    expect(ciAfter?.status).toBe('cancelled');

    // Check that unrelated task is untouched
    const otherAfter = await db.query.tasks.findFirst({
      where: eq(tasks.id, otherTask[0].id),
      columns: { status: true },
    });
    expect(otherAfter?.status).toBe('pending');
  });

  it('should cancel assigned retry attempts', async () => {
    const prNumber = 1003;
    const assignedTask = await db.insert(tasks).values({
      id: crypto.randomUUID(),
      workspaceId,
      title: 'assigned conflict retry',
      taskClass: 'attempt',
      status: 'assigned',
      conflictRetryPrNumber: prNumber,
      conflictRetryHeadSha: 'jkl012',
    }).returning({ id: tasks.id });

    await cancelRetryAttemptsForMergedPr({
      workspaceId,
      prNumber,
      reason: 'PR closed',
    });

    const after = await db.query.tasks.findFirst({
      where: eq(tasks.id, assignedTask[0].id),
      columns: { status: true },
    });
    expect(after?.status).toBe('cancelled');
  });

  it('should complete in_review attempts instead of cancelling', async () => {
    const prNumber = 1004;
    const inReviewTask = await db.insert(tasks).values({
      id: crypto.randomUUID(),
      workspaceId,
      title: 'reviewer retry in review',
      taskClass: 'attempt',
      status: 'in_review',
      reviewerRetryPrNumber: prNumber,
      reviewerRetryHeadSha: 'mno345',
    }).returning({ id: tasks.id });

    await cancelRetryAttemptsForMergedPr({
      workspaceId,
      prNumber,
      reason: 'PR merged',
    });

    const after = await db.query.tasks.findFirst({
      where: eq(tasks.id, inReviewTask[0].id),
      columns: { status: true },
    });
    expect(after?.status).toBe('completed');
  });

  it('should not affect completed or cancelled attempts', async () => {
    const prNumber = 1005;

    const completedTask = await db.insert(tasks).values({
      id: crypto.randomUUID(),
      workspaceId,
      title: 'completed attempt',
      taskClass: 'attempt',
      status: 'completed',
      conflictRetryPrNumber: prNumber,
      conflictRetryHeadSha: 'pqr678',
    }).returning({ id: tasks.id });

    const cancelledTask = await db.insert(tasks).values({
      id: crypto.randomUUID(),
      workspaceId,
      title: 'already cancelled attempt',
      taskClass: 'attempt',
      status: 'cancelled',
      conflictRetryPrNumber: prNumber,
      conflictRetryHeadSha: 'stu901',
    }).returning({ id: tasks.id });

    await cancelRetryAttemptsForMergedPr({
      workspaceId,
      prNumber,
      reason: 'PR merged',
    });

    const completedAfter = await db.query.tasks.findFirst({
      where: eq(tasks.id, completedTask[0].id),
      columns: { status: true },
    });
    expect(completedAfter?.status).toBe('completed');

    const cancelledAfter = await db.query.tasks.findFirst({
      where: eq(tasks.id, cancelledTask[0].id),
      columns: { status: true },
    });
    expect(cancelledAfter?.status).toBe('cancelled');
  });

  it('should handle multiple tasks for same PR in different states', async () => {
    const prNumber = 1006;

    const pendingTask = await db.insert(tasks).values({
      id: crypto.randomUUID(),
      workspaceId,
      title: 'pending attempt',
      taskClass: 'attempt',
      status: 'pending',
      ciRetryPrNumber: prNumber,
      ciRetryHeadSha: 'vwx234',
    }).returning({ id: tasks.id });

    const assignedTask = await db.insert(tasks).values({
      id: crypto.randomUUID(),
      workspaceId,
      title: 'assigned attempt',
      taskClass: 'attempt',
      status: 'assigned',
      ciRetryPrNumber: prNumber,
      ciRetryHeadSha: 'vwx234',
    }).returning({ id: tasks.id });

    const inProgressTask = await db.insert(tasks).values({
      id: crypto.randomUUID(),
      workspaceId,
      title: 'in progress attempt',
      taskClass: 'attempt',
      status: 'in_progress',
      ciRetryPrNumber: prNumber,
      ciRetryHeadSha: 'vwx234',
    }).returning({ id: tasks.id });

    await cancelRetryAttemptsForMergedPr({
      workspaceId,
      prNumber,
      reason: 'PR merged',
    });

    // All should be cancelled
    for (const taskId of [pendingTask[0].id, assignedTask[0].id, inProgressTask[0].id]) {
      const task = await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
        columns: { status: true },
      });
      expect(task?.status).toBe('cancelled');
    }
  });

  it('should do nothing when no retry tasks exist for PR', async () => {
    const prNumber = 1007;

    // Should not throw
    await cancelRetryAttemptsForMergedPr({
      workspaceId,
      prNumber,
      reason: 'PR merged',
    });

    // Verify workspace still exists
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
    });
    expect(ws).toBeTruthy();
  });
});

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { Artifact } from '@buildd/core/db/schema';
import type { NotifyPayload } from './notify';

// Mock modules
const mockNotifyTeamOf = mock(async (subject: any, event: string, payload: any) => {});
const mockIsReviewArtifact = mock((artifact: any) => false);
const mockDb = {
  query: {
    tasks: {
      findFirst: mock(async () => null),
    },
    workspaces: {
      findFirst: mock(async () => ({ teamId: 'team-1' })),
    },
  },
};

mock.module('@/lib/notify', () => ({
  notifyTeamOf: mockNotifyTeamOf,
  resolveNotifyPlan: () => ({ pushover: true, webhook: false, noop: false }),
}));

mock.module('@/lib/artifact-prominence', () => ({
  isReviewArtifact: mockIsReviewArtifact,
}));

mock.module('@buildd/core/db', () => ({
  db: mockDb,
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: 'workspaces',
  tasks: 'tasks',
}));

import {
  shouldNotifyOnArtifact,
  notifyArtifactReady,
} from './artifact-notify';

describe('shouldNotifyOnArtifact', () => {
  beforeEach(() => {
    mockIsReviewArtifact.mockReset();
    mockDb.query.tasks.findFirst.mockReset();
  });

  it('returns false if artifact is not for review', async () => {
    mockIsReviewArtifact.mockReturnValue(false);

    const result = await shouldNotifyOnArtifact(
      { id: 'art-1', type: 'screenshot' } as Artifact,
      'task-1'
    );

    expect(result).toBe(false);
  });

  it('returns false if artifact is for review but task not found', async () => {
    mockIsReviewArtifact.mockReturnValue(true);
    mockDb.query.tasks.findFirst.mockResolvedValue(null);

    const result = await shouldNotifyOnArtifact(
      { id: 'art-1', type: 'report' } as Artifact,
      'task-1'
    );

    expect(result).toBe(false);
  });

  it('returns false if task exists but context.notifyOnArtifact is not set', async () => {
    mockIsReviewArtifact.mockReturnValue(true);
    mockDb.query.tasks.findFirst.mockResolvedValue({
      id: 'task-1',
      context: {},
    });

    const result = await shouldNotifyOnArtifact(
      { id: 'art-1', type: 'report' } as Artifact,
      'task-1'
    );

    expect(result).toBe(false);
  });

  it('returns false if task.context.notifyOnArtifact is false', async () => {
    mockIsReviewArtifact.mockReturnValue(true);
    mockDb.query.tasks.findFirst.mockResolvedValue({
      id: 'task-1',
      context: { notifyOnArtifact: false },
    });

    const result = await shouldNotifyOnArtifact(
      { id: 'art-1', type: 'report' } as Artifact,
      'task-1'
    );

    expect(result).toBe(false);
  });

  it('returns true if artifact is for review and task has notifyOnArtifact=true', async () => {
    mockIsReviewArtifact.mockReturnValue(true);
    mockDb.query.tasks.findFirst.mockResolvedValue({
      id: 'task-1',
      workspaceId: 'ws-1',
      context: { notifyOnArtifact: true },
    });

    const result = await shouldNotifyOnArtifact(
      { id: 'art-1', type: 'report' } as Artifact,
      'task-1'
    );

    expect(result).toBe(true);
  });

  it('handles corrupt context gracefully', async () => {
    mockIsReviewArtifact.mockReturnValue(true);
    mockDb.query.tasks.findFirst.mockResolvedValue({
      id: 'task-1',
      context: null,
    });

    const result = await shouldNotifyOnArtifact(
      { id: 'art-1', type: 'report' } as Artifact,
      'task-1'
    );

    expect(result).toBe(false);
  });
});

describe('notifyArtifactReady', () => {
  beforeEach(() => {
    mockNotifyTeamOf.mockReset();
    mockDb.query.workspaces.findFirst.mockReset();
    mockDb.query.workspaces.findFirst.mockResolvedValue({ teamId: 'team-1' });
  });

  it('sends notification with artifact title and deep link', async () => {
    const artifact = {
      id: 'art-1',
      title: 'Analysis Report',
      type: 'report',
    } as Artifact;

    await notifyArtifactReady(artifact, 'task-1', 'ws-1');

    expect(mockNotifyTeamOf).toHaveBeenCalledTimes(1);
    const [subject, event, payload] = mockNotifyTeamOf.mock.calls[0] as any[];
    expect(event).toBe('artifactReady');
    expect(payload.title).toContain('Analysis Report');
    expect(payload.message).toBeDefined();
  });

  it('includes workspace context in notification subject', async () => {
    const artifact = { id: 'art-1', title: 'Report', type: 'report' } as Artifact;

    await notifyArtifactReady(artifact, 'task-1', 'ws-1');

    const [subject] = mockNotifyTeamOf.mock.calls[0] as any[];
    expect(subject.workspaceId).toBe('ws-1');
  });

  it('constructs URL to task artifact', async () => {
    const artifact = { id: 'art-1', title: 'Report', type: 'report' } as Artifact;

    await notifyArtifactReady(artifact, 'task-1', 'ws-1');

    const [, , payload] = mockNotifyTeamOf.mock.calls[0] as any[];
    expect(payload.url).toContain('task-1');
    expect(payload.url).toContain('art-1');
  });

  it('handles missing workspace gracefully', async () => {
    mockDb.query.workspaces.findFirst.mockResolvedValue(null);
    const artifact = { id: 'art-1', title: 'Report', type: 'report' } as Artifact;

    // Should not throw
    await notifyArtifactReady(artifact, 'task-1', 'ws-1');

    // May or may not notify depending on implementation choice
  });

  it('does not throw on network errors', async () => {
    mockNotifyTeamOf.mockRejectedValue(new Error('Network error'));
    const artifact = { id: 'art-1', title: 'Report', type: 'report' } as Artifact;

    // Should not throw
    await expect(notifyArtifactReady(artifact, 'task-1', 'ws-1')).resolves.toBeUndefined();
  });
});

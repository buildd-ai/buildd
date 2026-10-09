import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActionQueueCard } from './ActionQueueCard';
import type { ActionQueueItem } from '@/lib/action-queue';

const REASON = 'The change adds a table and a migration, and workspace policy requires a person for both. The migration index also collides with the base branch. Proposed policy additions: a manifest file as dependency_bump.';

const item = {
  subjectKey: 'review-1',
  chip: 'REVIEW',
  prNumber: 7,
  workspaceId: 'ws-example',
  taskTitle: 'Add an incident table',
  prUrl: 'https://example.test/o/r/pull/7',
  machineStatus: 'CI running',
  humanReview: {
    label: 'Review on GitHub',
    reason: REASON,
    decision: 'Approve the additive migration after the branch refresh lands.',
    blockers: [{ kind: 'migration', text: 'Adds one table' }],
  },
} as unknown as ActionQueueItem;

describe('human PR review card', () => {
  it('leads with the decision, tags the why, and folds the full reason', () => {
    const html = renderToStaticMarkup(<ActionQueueCard item={item} />);
    expect(html).toContain('Approve the additive migration after the branch refresh lands.');
    expect(html).toContain('migration');
    expect(html).toContain('CI running');
    expect(html).toContain('Details');
    expect(html).not.toContain('Proposed policy additions');
    expect(html).not.toContain('Review required ·');
    expect(html).toContain('/pull/7/files');
  });
});

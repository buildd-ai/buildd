import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WaitingOnYouReviewCard } from './WaitingOnYouReviewCard';
import type { ActionQueueItem } from '@/lib/action-queue';

function item(partial: Partial<ActionQueueItem> = {}): ActionQueueItem {
  return {
    subjectKey: 'https://github.com/org/repo/pull/2054',
    chip: 'REVIEW',
    prUrl: 'https://github.com/org/repo/pull/2054',
    prNumber: 2054,
    taskId: 'task-2',
    taskTitle: '[WU-2] Health tab restructure',
    workspaceId: 'ws-1',
    workspaceName: 'buildd',
    ...partial,
  };
}

describe('WaitingOnYouReviewCard mission context', () => {
  it('shows the mission the review unblocks', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({ missionId: 'mis-2', missionTitle: 'Health analytics restructure' })}
      />,
    );
    expect(html).toContain('Health analytics restructure');
    expect(html).toContain('/app/missions/mis-2');
  });

  it('marks a mission-less card as unlinked work', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard item={item({ workspaceName: '__coordination' })} />,
    );
    expect(html).toContain('No mission · __coordination');
  });
});

describe('WaitingOnYouReviewCard recommendation', () => {
  it('shows what the reviewer said to do next', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          escalationReason: 'Touches the token refresh path',
          recommendation: 'Confirm the refresh lock by hand, then merge.',
        })}
      />,
    );
    expect(html).toContain('Agent recommends:');
    expect(html).toContain('Confirm the refresh lock by hand, then merge.');
  });

  it('stays quiet when there is no recommendation', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard item={item({ escalationReason: 'Touches auth' })} />,
    );
    expect(html).not.toContain('Agent recommends');
    expect(html).not.toContain('No handoff recommendation');
  });
});

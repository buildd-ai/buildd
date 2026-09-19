import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActionQueueItem } from '@/lib/action-queue';

mock.module('next/navigation', () => ({
  usePathname: () => '/app/home',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { WaitingOnYouMergeCard } = await import('./WaitingOnYouMergeCard');

function item(partial: Partial<ActionQueueItem> = {}): ActionQueueItem {
  return {
    subjectKey: 'https://github.com/org/repo/pull/2052',
    chip: 'MERGE',
    prUrl: 'https://github.com/org/repo/pull/2052',
    prNumber: 2052,
    taskId: 'task-1',
    taskTitle: 'Release attribution: match squash-merge commits',
    workspaceId: 'ws-1',
    workspaceName: 'buildd',
    ...partial,
  };
}

describe('WaitingOnYouMergeCard mission context', () => {
  it('shows initiative › mission instead of the bare workspace name', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouMergeCard
        item={item({
          initiativeId: 'ini-1',
          initiativeTitle: 'Release intelligence',
          missionId: 'mis-1',
          missionTitle: 'Release attribution',
        })}
      />,
    );
    expect(html).toContain('Release intelligence › Release attribution');
    expect(html).toContain('/app/missions/mis-1');
    expect(html).not.toContain('>buildd<');
  });

  it('marks a mission-less card as unlinked work', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouMergeCard item={item({ workspaceName: '__coordination' })} />,
    );
    expect(html).toContain('No mission · __coordination');
  });

  it('renders no context line when nothing is known', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouMergeCard item={item({ workspaceName: undefined })} />,
    );
    expect(html).not.toContain('No mission');
  });
});

describe('WaitingOnYouMergeCard unblock clause', () => {
  it('does not repeat the mission name already shown on the context line', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouMergeCard
        item={item({
          unblockCount: 1,
          missionId: 'mis-1',
          missionTitle: 'Weekly mobile UI audit',
          unblockMissionTitle: 'Weekly mobile UI audit',
        })}
      />,
    );
    expect(html.match(/Weekly mobile UI audit/g)).toHaveLength(1);
    expect(html).toContain('unblocks 1 task');
  });

  it('names the blocked mission when it differs from the PR own mission', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouMergeCard
        item={item({
          unblockCount: 2,
          missionId: 'mis-1',
          missionTitle: 'Release attribution',
          unblockMissionTitle: 'Health analytics restructure',
        })}
      />,
    );
    expect(html).toContain('unblocks 2 tasks in Health analytics restructure');
    expect(html).toContain('Release attribution');
  });
});

describe('WaitingOnYouMergeCard mission-PR merge gate', () => {
  const BLOCKED_REASON =
    "This mission's work is not finished — 2 task PR(s) still open on the integration branch: "
    + 'PR #2514 (fix retry logic), PR #2516 (add timeout). Cancel the remaining task(s), or let '
    + 'them land, then merge.';

  it('disables the merge affordance and names the blocking PRs when guardMissionPrMerge refuses', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouMergeCard item={item({ missionMergeBlockedReason: BLOCKED_REASON })} />,
    );
    expect(html).toContain('PR #2514');
    expect(html).toContain('PR #2516');
    expect(html).toContain('cursor-not-allowed');
  });

  it('renders the normal actionable Merge button once the gate clears (reason absent)', () => {
    const html = renderToStaticMarkup(<WaitingOnYouMergeCard item={item()} />);
    expect(html).not.toContain('cursor-not-allowed');
    expect(html).toContain('>Merge<');
  });
});

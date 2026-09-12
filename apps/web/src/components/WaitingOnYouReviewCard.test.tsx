import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActionQueueItem } from '@/lib/action-queue';

mock.module('next/navigation', () => ({
  usePathname: () => '/app/home',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { WaitingOnYouReviewCard } = await import('./WaitingOnYouReviewCard');

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

describe('WaitingOnYouReviewCard reviewer verdict', () => {
  // Regression: a terminal approve whose head has since advanced (a dispatched
  // conflict retry) must still be visible on the card — never blank, never
  // reading as unreviewed.
  it('renders the stored verdict — reviewer, confidence, summary, and the approved SHA', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          reviewerVerdict: {
            verdict: 'approve',
            confidence: 0.92,
            summary: 'All defects fixed and tested.',
            approvedSha: 'abc1234567',
            postedToGithub: true,
          },
        })}
      />,
    );
    expect(html).toContain('Approved');
    expect(html).toContain('0.92');
    expect(html).toContain('All defects fixed and tested.');
    expect(html).toContain('abc1234');
  });

  it('renders the staleness qualifier when the head has moved past the approved SHA', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          reviewerVerdict: {
            verdict: 'approve',
            confidence: 0.92,
            summary: 'All defects fixed and tested.',
            approvedSha: 'abc1234567',
            postedToGithub: true,
          },
          approvalStale: { approvedSha: 'abc1234567', commitsSince: 2 },
        })}
      />,
    );
    // Must not read as unreviewed: the approval is still shown, qualified.
    expect(html).toContain('Approved');
    expect(html).toContain('2 commits since');
  });

  it('flags a verdict that never made it to GitHub', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          reviewerVerdict: {
            verdict: 'approve',
            confidence: 0.92,
            summary: 'All defects fixed and tested.',
            approvedSha: 'abc1234567',
            postedToGithub: false,
          },
        })}
      />,
    );
    expect(html).toContain('not posted to GitHub');
  });

  it('renders nothing extra when there is no stored verdict', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard item={item({ escalationReason: 'Touches auth' })} />,
    );
    expect(html).not.toContain('approved at');
  });
});

describe('WaitingOnYouReviewCard action hierarchy', () => {
  it('offers Apply / Apply with corrections / Merge anyway, with Apply as the filled primary action', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({ escalationReason: 'Touches schema.ts', recommendation: 'Guard the null-overwrite.' })}
      />,
    );
    expect(html).toContain('>Apply<');
    expect(html).toContain('Apply with corrections');
    expect(html).toContain('Merge anyway');
    // Apply is the filled/primary button (bg-accent); Merge anyway is a bare text link.
    const applyIdx = html.indexOf('>Apply<');
    const mergeAnywayIdx = html.indexOf('Merge anyway');
    expect(applyIdx).toBeGreaterThan(-1);
    expect(mergeAnywayIdx).toBeGreaterThan(applyIdx);
  });

  it('renders no "Merge" as a bare/primary button — merge is demoted', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard item={item({ escalationReason: 'Touches schema.ts' })} />,
    );
    // The old bare "Merge" primary CTA must not exist; only "Merge anyway" as a link.
    expect(html).not.toMatch(/>\s*Merge\s*<\/button>/);
  });

  it('renders no action row when the card has no PR (nothing to apply to or merge)', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard item={item({ prNumber: undefined })} />,
    );
    expect(html).not.toContain('Apply with corrections');
    expect(html).not.toContain('Merge anyway');
  });
});

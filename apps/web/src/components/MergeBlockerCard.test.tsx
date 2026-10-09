import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActionQueueCard } from '../app/app/(protected)/home/ActionQueueCard';
import type { ActionQueueItem } from '@/lib/action-queue';

const REVIEWER_ESSAY =
  'Implementation matches the spec, but the PR touches the schema and a generated migration, which the workspace policy marks as human-review-required.';

function item(partial: Partial<ActionQueueItem> = {}): ActionQueueItem {
  return {
    subjectKey: 'https://github.com/org/repo/pull/4100',
    chip: 'RESOLVING',
    prUrl: 'https://github.com/org/repo/pull/4100',
    prNumber: 4100,
    taskId: 'task-1',
    taskTitle: 'feat(missions): keep mission integration branches merged up with dev automatically',
    workspaceName: 'buildd',
    missionId: 'mis-1',
    missionTitle: 'Mission delivery',
    escalationReason: REVIEWER_ESSAY,
    recommendation: 'Have a person review the migration before merging.',
    mergeConflict: true,
    conflictReason: 'Migration 0235 collides with another change',
    ...partial,
  };
}

function render(i: ActionQueueItem) {
  // Through ActionQueueCard, so the links are the ones Home actually renders.
  const html = renderToStaticMarkup(<ActionQueueCard item={i} />);
  const [collapsed, details = ''] = html.split('<details');
  return { html, collapsed, details };
}

/** Visible text of an HTML fragment. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('MergeBlockerCard (via ActionQueueCard)', () => {
  it('resolving, no task yet: state, one reason, "Fixing…", and nothing else collapsed', () => {
    const { collapsed, details } = render(item());
    expect(text(collapsed)).toBe(
      'Resolving merge conflict Fixing… Keep mission integration branches merged up with dev automatically Migration 0235 collides with another change',
    );
    expect(collapsed).toContain('data-needs-you="false"');
    // Reviewer prose and the raw merge state live behind Details only.
    expect(collapsed).not.toContain('human-review-required');
    expect(details).toContain('human-review-required');
    expect(details).toContain('review the migration');
    expect(details).toContain('conflicts with its base');
  });

  it('resolving with a live attempt: View task links to it', () => {
    const { collapsed } = render(item({ conflictRetryTaskId: 'retry-2', conflictRetryIteration: 2 }));
    expect(collapsed).toContain('View task');
    expect(collapsed).toContain('/app/tasks/retry-2');
    expect(collapsed).not.toContain('Fixing…');
  });

  it('blocked on a person: Fix conflict points at the PR, Last attempt sits in Details', () => {
    const { collapsed, details } = render(item({
      chip: 'BLOCKED',
      deadZoneExhausted: true,
      deadZoneLastRetryTaskId: 'retry-3',
    }));
    expect(collapsed).toContain('data-needs-you="true"');
    expect(collapsed).toContain('Merge blocked · automatic fixes ran out');
    expect(collapsed).toContain('Fix conflict');
    expect(collapsed).toContain('href="https://github.com/org/repo/pull/4100"');
    expect(collapsed).not.toContain('Last attempt');
    expect(details).toContain('Last attempt');
  });

  it('never offers Merge, Retry or Dismiss in any state', () => {
    for (const i of [
      item(),
      item({ conflictRetryTaskId: 'retry-1', conflictRetryIteration: 1 }),
      item({ chip: 'BLOCKED', deadZoneExhausted: true }),
      item({ chip: 'BLOCKED' }),
    ]) {
      const visible = text(render(i).html);
      expect(visible).not.toMatch(/\bMerge\b(?! blocked)/);
      expect(visible).not.toContain('Retry');
      expect(visible).not.toContain('Dismiss');
    }
  });

  // ~393pt phone: the collapsed card is three single-line rows (state +
  // action, title, reason). Each is truncated rather than wrapped, so a long
  // title or reason can never grow the card.
  it('stays three single-line rows at phone width', () => {
    const long = 'x'.repeat(400);
    const { collapsed } = render(item({ taskTitle: long, conflictReason: long }));
    expect(collapsed).toContain('data-testid="merge-blocker-state"');
    expect(collapsed.match(/class="[^"]*\btruncate\b[^"]*"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(collapsed).not.toContain('line-clamp');
    expect(collapsed).not.toContain('<textarea');
  });

  it('ActionQueueCard routes conflict cards here, and leaves red-CI BLOCKED alone', () => {
    expect(renderToStaticMarkup(<ActionQueueCard item={item()} />)).toContain('data-testid="merge-blocker-card"');
    const ciBlocked = renderToStaticMarkup(
      <ActionQueueCard
        item={item({
          chip: 'BLOCKED',
          mergeConflict: undefined,
          ciGate: { kind: 'blocked', reason: 'CI failing — no fix in flight', recommendation: null },
        })}
      />,
    );
    expect(ciBlocked).not.toContain('merge-blocker-card');
  });
});

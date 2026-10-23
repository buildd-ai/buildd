/**
 * Every question and review card on Home is the one decision card the
 * mission page draws (Navigation d25d923d R-16, AC-10): `● <task> · <age>`,
 * the why, the decision as a question, a primary and one alternative with
 * their effects, then Answer differently / Not now. Not the queue card's
 * eyebrow, Details disclosure and single Answer or Review on GitHub button.
 * Fixtures are illustrative.
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('next/navigation', () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => '/app/home', useSearchParams: () => new URLSearchParams() }));
const { DecisionCard } = await import('./DecisionCard');
const { reviewApprovalView } = await import('./NeedsYouCards');
const { default: SharedDecisionCard } = await import('@/components/DecisionCard');
const { approvalView } = await import('@/lib/needs-you-card');
const { admitWaitingTasks, deriveHomeAttention } = await import('@/lib/home-attention');
import type { ActionQueueItem } from '@/lib/action-queue';
import type { HomeAttentionItem } from '@/lib/home-attention';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const PR = 'https://example.test/o/r/pull/7';
const derive = (queue: ActionQueueItem[]) => deriveHomeAttention({ queue, missions: [], questions: [], held: [], isActionable: () => true });
const html = (item: HomeAttentionItem) => renderToStaticMarkup(<DecisionCard item={item} onDone={() => {}} />);

/** The queue card's shape, which no question or review card on Home may keep. */
function expectSharedShape(markup: string) {
  expect(markup).toContain('data-testid="needs-you-card"');
  expect(markup).toContain('data-testid="question-subject"');
  expect(markup).toContain('data-testid="decision-question"');
  expect(markup).toContain('data-testid="decision-not-now"');
  expect(markup).not.toContain('<details');
  expect(markup).not.toContain('data-testid="needs-you-actions"');
}

describe('a waiting task from the needs-input feed', () => {
  const waiting = [{
    id: 'task-q', title: 'Mirror the runner image', workerId: 'worker-q', askedAt: new Date(NOW - 60_000).toISOString(),
    waitingFor: {
      type: 'question', prompt: 'How should registry credentials be set up?', context: 'CI has no registry secrets, so every release skips the mirror.',
      options: [{ label: 'Provide a token', description: 'Stored as a team secret', recommended: true }, { label: "I'll set them myself", description: 'Resumes when CI sees them' }],
    },
  }];
  const [item] = admitWaitingTasks([], waiting as never, t => `/app/tasks/${t.id}`);

  it('carries the full question and the worker the answer goes to', () => {
    expect(item.question).toMatchObject({ workerId: 'worker-q', taskId: 'task-q', label: 'Mirror the runner image', href: '/app/tasks/task-q' });
    expect(item.question?.question.options.map(o => o.label)).toEqual(['Provide a token', "I'll set them myself"]);
  });

  it('renders as the shared card: subject, why, question, options with effects, Answer differently', () => {
    const markup = html(item);
    expectSharedShape(markup);
    expect(markup).toContain('Mirror the runner image');
    expect(markup).toContain('CI has no registry secrets');
    expect(markup).toContain('How should registry credentials be set up?');
    expect(markup.match(/data-testid="decision-option"/g)).toHaveLength(2);
    expect(markup).toContain('Stored as a team secret');
    expect(markup).toContain('data-testid="decision-answer-differently"');
  });

  it('an option wraps inside the card at 390 instead of running past its edge (.btn is nowrap)', () => {
    const options = html(item).match(/<button[^>]*data-testid="decision-option"[^>]*>/g) ?? [];
    expect(options).toHaveLength(2);
    for (const o of options) expect(o).toMatch(/\bwhitespace-normal\b.*\bmin-w-0\b|\bmin-w-0\b.*\bwhitespace-normal\b/);
  });

  it('a waiting task with no worker named keeps its link card (nowhere to post an answer)', () => {
    const [bare] = admitWaitingTasks([], [{ ...waiting[0], workerId: undefined }] as never, t => `/app/tasks/${t.id}`);
    expect(bare.question).toBeUndefined();
  });
});

describe('a QUESTION chip from the action queue', () => {
  const [item] = derive([{ subjectKey: 'q', chip: 'QUESTION', taskId: 'task-a', taskTitle: 'Improve navigation', workerId: 'worker-a', question: 'Keep the old URL as a redirect?' } as ActionQueueItem]);

  it('is the shared card answering the same worker, with a free-text answer and no Answer link', () => {
    expect(item.question).toMatchObject({ workerId: 'worker-a', taskId: 'task-a', label: 'Improve navigation' });
    const markup = html(item);
    expectSharedShape(markup);
    expect(markup).toContain('Keep the old URL as a redirect?');
    // No options: the card offers a written answer (the box, or Answer differently opening it).
    expect(markup).toMatch(/data-testid="decision-answer-(?:form|differently)"/);
    expect(markup).not.toContain('>Answer<');
  });
});

describe('a review a person must give', () => {
  const review = { subjectKey: 'r', chip: 'REVIEW', prNumber: 7, workspaceId: 'ws', taskId: 'task-r', taskTitle: 'Requester trigger and backfill', prUrl: PR, machineStatus: 'CI passed',
    humanReview: { label: 'Review on GitHub', decision: 'Protected migration paths changed.', reason: 'Protected migration paths changed.', blockers: [] } } as ActionQueueItem;
  const [item] = derive([review]);

  it('is an approval with Approve and Request changes, each with its effect, and the diff linked', () => {
    const view = reviewApprovalView(item);
    expect(view).toMatchObject({ kind: 'approval', question: 'Approve Requester trigger and backfill?', diffHref: `${PR}/files`, shortcut: false });
    expect(view?.options.map(o => [o.label, o.effect])).toEqual([['Approve', 'Merges when green'], ['Request changes', 'Builder revises it']]);
    expect(view?.summary).toBe('Protected migration paths changed. CI passed.');
  });

  it('renders exactly as the mission page renders the same approval', () => {
    const view = reviewApprovalView(item)!;
    const mission = approvalView({
      key: view.key, task: view.task, askedAt: null, reason: 'Protected migration paths changed. CI passed.',
      diffHref: `${PR}/files`, approveHref: PR, changesHref: `${PR}/files`,
    });
    const markup = html(item);
    expectSharedShape(markup);
    expect(markup).not.toContain('Review on GitHub');
    expect(markup).not.toContain('View task');
    expect(markup).toBe(renderToStaticMarkup(<SharedDecisionCard view={mission} now={NOW} testId="needs-you-card" />));
  });

  it('a review with no PR to decide on keeps the queue card', () => {
    const [bare] = derive([{ ...review, prUrl: undefined, humanReview: null, verdictSummary: 'Needs a look.', taskId: 'task-r', missionId: 'm-1' } as ActionQueueItem]);
    expect(reviewApprovalView(bare)).toBeNull();
  });
});

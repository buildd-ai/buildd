/**
 * Phone Home and the layout's needs-input banner tell one story: a task the
 * banner would name is in Home's inbox and its count, and the banner steps
 * aside on a phone while Home is up (it would only repeat the inbox).
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/home' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {} }),
  usePathname: () => '/app/home',
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { HomeBody } = await import('./HomeBody');
const { default: NeedsInputBanner } = await import('@/components/NeedsInputBanner');
const { NeedsInputContext } = await import('@/components/needs-input-context');
const { deriveHomeAttention } = await import('@/lib/home-attention');
const { isActionableChip } = await import('@/lib/action-queue');
const { bannerHiddenSnapshot } = await import('@/lib/needs-input-hidden');
type WaitingTask = import('@/components/needs-input-context').WaitingTask;

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const review = { subjectKey: 'review', chip: 'REVIEW' as const, prNumber: 7, workspaceId: 'ws-1', taskTitle: 'A change', prUrl: 'https://github.com/example/project/pull/7', humanReview: { label: 'Review PR', reason: 'Protected paths changed.', decision: 'Protected paths changed.', blockers: [] } };
const waiting: WaitingTask = { id: 'task-waiting', title: 'Pick the rollout order', workspaceId: 'ws-1', missionId: null, waitingFor: { type: 'question', prompt: 'Ship to canary first?', options: ['Yes', 'No'] } };

function mount(tasks: WaitingTask[], questions: Parameters<typeof deriveHomeAttention>[0]['questions'] = []) {
  const items = deriveHomeAttention({ queue: [review], questions, held: [], missions: [], isActionable: isActionableChip });
  act(() => root.render(
    <NeedsInputContext.Provider value={{ tasks, count: tasks.filter(t => !t.answerSent).length, alertPermission: 'unsupported', enableAlerts() {} }}>
      <NeedsInputBanner />
      <HomeBody items={items} ask={null} counts={{ openMissions: 0, executingMissions: 0, liveAgents: 0, slots: { used: 0, total: 1 } }} milestones={[]} quietMissions={0} />
    </NeedsInputContext.Provider>,
  ));
}
const cardCount = () => container.querySelectorAll('[data-testid="needs-you-card"]').length;

describe('phone Home and the needs-input banner', () => {
  // Home's list holds every task the banner would name, at every width, so
  // the banner steps aside on Home on desktop too, not only on a phone.
  it('a waiting task the banner knows is in the inbox and the count, and the banner steps aside at every width', () => {
    mount([waiting]);
    expect(cardCount()).toBe(2);
    expect(container.textContent).toContain('2 things need you.');
    const cards = [...container.querySelectorAll('[data-testid="needs-you-card"]')];
    expect(cards.map(c => c.getAttribute('data-kind')).sort()).toEqual(['question', 'queue']);
    expect(container.textContent).toContain('Ship to canary first?');
    expect(bannerHiddenSnapshot()).toBe(true);
    expect(container.querySelector('[data-testid="global-needs-input-banner"]')).toBeNull();
  });

  it('a task already in the inbox from the server is not listed twice', () => {
    mount([waiting], [{ workerId: 'w-1', taskId: 'task-waiting', label: 'rollout', runnerName: null, askedAt: null, href: '/app/tasks/task-waiting', question: { headline: 'Ship to canary first?', body: null, options: [], noteId: null } }]);
    expect(cardCount()).toBe(2);
    expect(container.textContent).toContain('2 things need you.');
  });

  it('an answered task is not admitted: it no longer needs the person', () => {
    mount([{ ...waiting, waitingFor: null, answerSent: true }]);
    expect(cardCount()).toBe(1);
    expect(container.textContent).toContain('1 thing needs you.');
  });

  it('the hold is released when Home unmounts, so other pages keep the banner', () => {
    mount([waiting]);
    act(() => root.render(<></>));
    expect(bannerHiddenSnapshot()).toBe(false);
  });
});

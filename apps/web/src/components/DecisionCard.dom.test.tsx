/**
 * The one decision card, mounted (happy-dom), Navigation d25d923d R-16:
 * the task and its age, the summary naming what waits, the question, a
 * primary and an alternative with their effects and desktop tips, Answer
 * differently and Not now; ⌘⏎ picks the focused card's primary and never an
 * approval; after an answer the card reads `You chose <option>`.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let refreshed = 0;
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => { refreshed++; } }),
  usePathname: () => '/app/missions/m1',
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: DecisionCard } = await import('./DecisionCard');
const { approvalView, decisionFromQuestion } = await import('@/lib/needs-you-card');

// The card ticks from the real clock once mounted, so ages are measured from it.
const T0 = Date.now();
const task = { id: 't1', title: 'Mirror the runner image to Docker Hub', href: '/app/tasks/t1' };

const decision = () => decisionFromQuestion({
  key: 'q:t1',
  question: {
    headline: 'How should Docker Hub credentials be set up?', body: null, noteId: null,
    context: 'CI has no Docker Hub secrets, so every release skips the image mirror',
    options: [
      { label: 'Provide a token', description: 'Recommended by the agent. You paste a Docker Hub access token next; buildd stores it as a team secret scoped to this repo.', recommended: true },
      { label: "I'll set them myself", description: 'Resumes when CI sees them', recommended: false },
    ],
  },
  task, askedAt: T0 - 4 * 60_000,
  dependents: ['The release publishes an image digest', 'A runner bundle on every release'],
  answer: { kind: 'worker', workerId: 'w1', taskId: 't1', noteId: null },
});

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; body: unknown }[] = [];

beforeEach(() => {
  refreshed = 0;
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, status: 200, json: async () => ({ path: 'resume', message: 'Answer sent.' }) } as Response;
  }) as unknown as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
});

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[];
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

describe('DecisionCard', () => {
  it('reads top to bottom: the task and its age, the why and who waits, the question, two options with effects, then the text buttons', () => {
    act(() => root.render(<DecisionCard view={decision()} now={T0} />));
    const subject = q('[data-testid="decision-subject"]')!;
    expect(subject.textContent).toBe('●Mirror the runner image to Docker Hub· asked 4m ago');
    expect(subject.querySelector('a')!.getAttribute('href')).toBe('/app/tasks/t1');
    expect(q('[data-testid="decision-summary"]')!.textContent).toContain('The release publishes an image digest and A runner bundle on every release wait on this.');
    expect(q('[data-testid="decision-question"]')!.textContent).toBe('How should Docker Hub credentials be set up?');
    const options = qa('[data-testid="decision-option"]');
    expect(options.map(o => o.textContent)).toEqual(['Provide a tokenRecommended by the agent…', "I'll set them myselfResumes when CI sees them"]);
    expect(options[0].getAttribute('data-primary')).toBe('true');
    expect(options[0].getAttribute('aria-keyshortcuts')).toBe('Meta+Enter Control+Enter');
    // The order on screen: subject, summary, question, options, then Answer differently and Not now.
    const html = container.innerHTML;
    const at = (s: string) => html.indexOf(s);
    expect(at('decision-subject')).toBeLessThan(at('decision-summary'));
    expect(at('decision-summary')).toBeLessThan(at('decision-question'));
    expect(at('decision-question')).toBeLessThan(at('decision-option'));
    expect(at('decision-option')).toBeLessThan(at('decision-answer-differently'));
    expect(q('[data-testid="decision-not-now"]')!.textContent).toBe('Not now');
    // No option named Not now or skip.
    expect(options.some(o => /not now|skip/i.test(o.textContent ?? ''))).toBe(false);
  });

  it('a long effect keeps its first clause on the button and the whole as a tip above it', () => {
    act(() => root.render(<DecisionCard view={decision()} now={T0} />));
    const tip = q('[data-testid="decision-option-tip"]')!;
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.textContent).toContain('buildd stores it as a team secret scoped to this repo');
    expect(tip.className).toContain('bottom-full');
    expect(tip.className).toContain('md:group-hover:block');
    expect(qa('[data-testid="decision-option"]')[0].getAttribute('aria-describedby')).toBe(tip.id);
  });

  it('tapping an option answers the worker and the card collapses to You chose', async () => {
    act(() => root.render(<DecisionCard view={decision()} now={T0} />));
    await act(async () => { qa('[data-testid="decision-option"]')[1].click(); });
    await flush();
    expect(calls[0].url).toContain('/api/workers/w1/respond');
    expect(calls[0].body).toMatchObject({ message: "I'll set them myself" });
    const card = q('[data-testid="decision-card"]')!;
    expect(card.getAttribute('data-answered')).toBe('true');
    expect(card.textContent).toContain("You chose I'll set them myself");
    expect(refreshed).toBe(1);
  });

  it('⌘⏎ picks the primary of the focused card only', async () => {
    act(() => root.render(<DecisionCard view={decision()} now={T0} />));
    const second = qa('[data-testid="decision-option"]')[1] as HTMLButtonElement;
    await act(async () => {
      second.focus();
      second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ message: 'Provide a token' });
  });

  it('Answer differently opens a free-text answer; Not now folds the card', async () => {
    act(() => root.render(<DecisionCard view={decision()} now={T0} />));
    expect(q('[data-testid="decision-answer-form"]')).toBeNull();
    await act(async () => { q('[data-testid="decision-answer-differently"]')!.click(); });
    const input = q('[data-testid="decision-answer-form"] input') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => { q('[data-testid="decision-not-now"]')!.click(); });
    const folded = q('[data-testid="decision-card"]')!;
    expect(folded.getAttribute('data-later')).toBe('true');
    expect(folded.textContent).toContain('Not now');
    expect(calls).toHaveLength(0);
  });

  it('an approval is Approve and Request changes as links to the diff, with no keyboard shortcut', async () => {
    const view = approvalView({
      key: 'a:t2', task: { id: 't2', title: 'Requester trigger and backfill', href: '/app/tasks/t2' }, askedAt: T0 - 60_000,
      reason: 'Workspace policy needs a person', dependents: ['Prove checks on integrated UI'],
      diffHref: 'https://example.test/pull/5/files', approveHref: 'https://example.test/pull/5', changesHref: 'https://example.test/pull/5/files',
    });
    act(() => root.render(<DecisionCard view={view} now={T0} />));
    const options = qa('[data-testid="decision-option"]');
    expect(options.map(o => o.tagName)).toEqual(['A', 'A']);
    expect(options.map(o => o.textContent)).toEqual(['ApproveMerges when green', 'Request changesBuilder revises it']);
    expect(options[0].getAttribute('aria-keyshortcuts')).toBeNull();
    expect(q('[data-testid="decision-diff"]')!.getAttribute('href')).toBe('https://example.test/pull/5/files');
    expect(q('[data-testid="decision-card"]')!.getAttribute('aria-label')).toBe('Approval required');
    await act(async () => {
      options[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    });
    expect(calls).toHaveLength(0);
  });

  it('an organizer question answers through the mission note reply', async () => {
    const view = decisionFromQuestion({
      key: 'note:n1',
      question: { headline: 'Keep the legacy export?', body: null, noteId: 'n1', options: [{ label: 'Keep', description: 'The old CSV stays', recommended: true }, { label: 'Drop', description: 'It goes in this release', recommended: false }] },
      task: null, mission: { id: 'm1', title: 'Billing exports', href: '/app/missions/m1' }, askedAt: T0,
      answer: { kind: 'note', missionId: 'm1', noteId: 'n1' },
    });
    act(() => root.render(<DecisionCard view={view} now={T0} />));
    expect(q('[data-testid="decision-subject"]')!.textContent).toContain('Billing exports');
    await act(async () => { qa('[data-testid="decision-option"]')[0].click(); });
    await flush();
    expect(calls[0].url).toBe('/api/missions/m1/notes/n1/reply');
    expect(calls[0].body).toEqual({ type: 'reply', title: 'Keep' });
    expect(q('[data-testid="decision-card"]')!.textContent).toContain('You chose Keep');
  });
});

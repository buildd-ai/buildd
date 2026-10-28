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
const { optionOutcomes } = await import('@buildd/core/question-waits');
type QuestionWaits = import('@buildd/core/question-waits').QuestionWaits;

// The card ticks from the real clock once mounted, so ages are measured from it.
const T0 = Date.now();
const task = { id: 't1', title: 'Mirror the runner image to Docker Hub', href: '/app/tasks/t1' };

/** What the projection (lib/question-waits.ts) returns for the asking task: two tasks waiting, in a chain. */
const projection = (): QuestionWaits => {
  const base: QuestionWaits = {
    taskId: 't1', mission: null, hiddenCount: 1, beyondCount: 0, lanes: [], criteria: null,
    waiting: [
      { id: 'd1', title: 'The release publishes an image digest', depth: 1, missionId: null, missionTitle: null, workspaceName: null, after: null, alsoWaitsOnOther: false },
      { id: 'd2', title: 'A runner bundle on every release', depth: 2, missionId: null, missionTitle: null, workspaceName: null, after: { id: 'd1', title: 'The release publishes an image digest' }, alsoWaitsOnOther: false },
    ],
    askedAt: new Date(T0 - 4 * 60_000).toISOString(), expiresAt: new Date(T0 + 210 * 60_000 + 20_000).toISOString(),
    onExpiry: { action: 'default', option: 'Provide a token' }, options: [],
  };
  return { ...base, options: optionOutcomes([{ label: 'Provide a token', outcome: 'finishes', recommended: true }, { label: "I'll set them myself", outcome: 'continues' }], base) };
};

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
  waits: projection(),
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
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 20)); }); };

describe('DecisionCard', () => {
  it('reads top to bottom: the task and its age, the why and who waits, the question, two options with effects, then the text buttons', () => {
    act(() => root.render(<DecisionCard view={decision()} now={T0} undoMs={0} />));
    const subject = q('[data-testid="question-subject"]')!;
    expect(subject.textContent).toBe('●Mirror the runner image to Docker Hub· asked 4m ago');
    expect(subject.querySelector('a')!.getAttribute('href')).toBe('/app/tasks/t1');
    expect(q('[data-testid="decision-summary"]')!.textContent).toContain("Blocks The release publishes an image digest, then A runner bundle on every release and 1 task you can't see.");
    expect(q('[data-testid="decision-question"]')!.textContent).toBe('How should Docker Hub credentials be set up?');
    const options = qa('[data-testid="decision-option"]');
    expect(options.map(o => o.textContent)).toEqual([
      'Provide a tokenRecommended by the agent…' + "Finishes the task: The release publishes an image digest and 1 task you can't see start",
      "I'll set them myselfResumes when CI sees them" + "Keeps working: The release publishes an image digest and 1 task you can't see keep waiting",
    ]);
    expect(options[0].getAttribute('data-primary')).toBe('true');
    expect(options[0].getAttribute('aria-keyshortcuts')).toBe('Meta+Enter Control+Enter');
    // The order on screen: subject, summary, question, options, then Answer differently and Not now.
    const html = container.innerHTML;
    const at = (s: string) => html.indexOf(s);
    expect(at('question-subject')).toBeLessThan(at('decision-summary'));
    expect(at('decision-summary')).toBeLessThan(at('decision-question'));
    expect(at('decision-question')).toBeLessThan(at('decision-option'));
    expect(at('decision-option')).toBeLessThan(at('decision-answer-differently'));
    expect(at('decision-not-now')).toBeLessThan(at('decision-expiry'));
    expect(q('[data-testid="decision-not-now"]')!.textContent).toBe('Not now');
    // No option named Not now or skip.
    expect(options.some(o => /not now|skip/i.test(o.textContent ?? ''))).toBe(false);
  });

  // Living Spec 1b257609 r2 R-6 to R-9: the projection fills the existing lines, adds no block.
  it('names the waiting work in the summary as links, each fact once, and the expiry in the footer', () => {
    act(() => root.render(<DecisionCard view={decision()} now={T0} undoMs={0} />));
    const links = [...q('[data-testid="decision-waits"]')!.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([['The release publishes an image digest', '/app/tasks/d1'], ['A runner bundle on every release', '/app/tasks/d2']]);
    expect(q('[data-testid="decision-expiry"]')!.textContent).toBe('Expires in 3h 30m. Goes with Provide a token.');
    // No id in the text, and the chain named once in the summary.
    expect(container.textContent).not.toMatch(/\bd[12]\b/);
    expect(container.textContent!.split('A runner bundle on every release').length - 1).toBe(1);
  });

  it('with no projection the card shows only the agent\'s why and no footer', () => {
    act(() => root.render(<DecisionCard view={{ ...decision(), waits: null, options: decision().options.map(o => ({ ...o, downstream: null })) }} now={T0} undoMs={0} />));
    expect(q('[data-testid="decision-waits"]')).toBeNull();
    expect(q('[data-testid="decision-expiry"]')).toBeNull();
    expect(q('[data-testid="decision-option-downstream"]')).toBeNull();
  });

  it('a long effect keeps its first clause on the button and the whole as a tip above it', () => {
    act(() => root.render(<DecisionCard view={decision()} now={T0} undoMs={0} />));
    const tip = q('[data-testid="decision-option-tip"]')!;
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.textContent).toContain('buildd stores it as a team secret scoped to this repo');
    expect(tip.className).toContain('bottom-full');
    expect(tip.className).toContain('md:group-hover:block');
    expect(qa('[data-testid="decision-option"]')[0].getAttribute('aria-describedby')).toBe(tip.id);
  });

  it('tapping an option answers the worker and the card collapses to You chose · Undo', async () => {
    act(() => root.render(<DecisionCard view={decision()} now={T0} undoMs={0} />));
    await act(async () => { qa('[data-testid="decision-option"]')[1].click(); });
    await flush();
    expect(calls[0].url).toContain('/api/workers/w1/respond');
    expect(calls[0].body).toMatchObject({ message: "I'll set them myself" });
    const card = q('[data-testid="decision-card"]')!;
    expect(card.getAttribute('data-answered')).toBe('true');
    expect(card.textContent).toContain("You chose I'll set them myself");
    expect(q('[data-testid="decision-undo"]')).toBeNull();
    expect(refreshed).toBe(1);
  });

  const heldView = (kind: 'worker' | 'note' | 'criteria') => {
    if (kind === 'worker') return decision();
    if (kind === 'note') return decisionFromQuestion({
      key: 'note:n1',
      question: { headline: 'Keep?', body: null, noteId: 'n1', options: [{ label: 'Keep', description: 'x', recommended: true }, { label: 'Drop', description: 'y', recommended: false }] },
      task: null, mission: { id: 'm1', title: 'Billing', href: '/app/missions/m1' }, askedAt: T0,
      answer: { kind: 'note', missionId: 'm1', noteId: 'n1' },
    });
    return null;
  };

  for (const kind of ['worker', 'note'] as const) {
    it(`${kind}: Undo inside the window cancels the send, so nothing is committed and re-answering sends once`, async () => {
      act(() => root.render(<DecisionCard view={heldView(kind)!} now={T0} undoMs={150} />));
      await act(async () => { qa('[data-testid="decision-option"]')[0].click(); });
      expect(q('[data-testid="decision-card"]')!.getAttribute('data-answered')).toBe('true');
      expect(calls).toHaveLength(0);
      await act(async () => { q('[data-testid="decision-undo"]')!.click(); });
      await act(async () => { await new Promise(r => setTimeout(r, 250)); });
      expect(calls).toHaveLength(0);
      expect(q('[data-testid="decision-card"]')!.getAttribute('data-answered')).toBeNull();
      await act(async () => { qa('[data-testid="decision-option"]')[1].click(); });
      await act(async () => { await new Promise(r => setTimeout(r, 250)); });
      expect(calls).toHaveLength(1);
      expect(q('[data-testid="decision-undo"]')).toBeNull();
    });
  }

  it('leaving the page inside the window still sends the answer once', async () => {
    // The held send is kind-agnostic (pick wraps every commit), so the worker and note runs above cover the hold;
    // here: leaving inside the window still sends exactly once.
    act(() => root.render(<DecisionCard view={decision()} now={T0} undoMs={10_000} />));
    await act(async () => { qa('[data-testid="decision-option"]')[0].click(); });
    expect(calls).toHaveLength(0);
    act(() => root.unmount());
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(calls).toHaveLength(1);
    root = createRoot(container);
  });

  it('after the window the answer is committed: one send, no Undo, a second tap is not possible', async () => {
    act(() => root.render(<DecisionCard view={decision()} now={T0} undoMs={0} />));
    await act(async () => { qa('[data-testid="decision-option"]')[1].click(); });
    await flush();
    expect(calls).toHaveLength(1);
    expect(q('[data-testid="decision-undo"]')).toBeNull();
    expect(q('[data-testid="decision-option"]')).toBeNull();
  });

  it('already answered: the card shows no Undo', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 409, json: async () => ({ error: 'already_answered', recordedAnswer: 'Provide a token' }) }) as Response) as unknown as typeof fetch;
    act(() => root.render(<DecisionCard view={decision()} now={T0} undoMs={0} />));
    await act(async () => { qa('[data-testid="decision-option"]')[1].click(); });
    await flush();
    expect(q('[data-testid="decision-undo"]')).toBeNull();
  });

  it('after an answer, focus moves into the next open card, whatever its testId', async () => {
    act(() => root.render(
      <>
        <DecisionCard view={decision()} now={T0} undoMs={0} testId="needs-you-card" />
        <DecisionCard view={{ ...decision(), key: 'q:t2' }} now={T0} undoMs={0} testId="needs-you-card" />
      </>,
    ));
    const cards = qa('[data-testid="needs-you-card"]');
    await act(async () => { cards[0].querySelectorAll<HTMLElement>('[data-testid="decision-option"]')[1].click(); });
    await flush();
    expect(cards[0].getAttribute('data-answered')).toBe('true');
    expect(cards[1].contains(document.activeElement)).toBe(true);
  });

  it('focus goes to the next card after this one, not the first open card on the page', async () => {
    act(() => root.render(
      <>
        <DecisionCard view={{ ...decision(), key: 'q:a' }} now={T0} undoMs={0} />
        <DecisionCard view={{ ...decision(), key: 'q:b' }} now={T0} undoMs={0} />
        <DecisionCard view={{ ...decision(), key: 'q:c' }} now={T0} undoMs={0} />
      </>,
    ));
    const cards = qa('[data-testid="decision-card"]');
    await act(async () => { cards[1].querySelectorAll<HTMLElement>('[data-testid="decision-option"]')[1].click(); });
    await flush();
    expect(cards[2].contains(document.activeElement)).toBe(true);
  });

  it('answering the only card does not throw and moves focus nowhere', async () => {
    act(() => root.render(<DecisionCard view={decision()} now={T0} undoMs={0} />));
    await act(async () => { qa('[data-testid="decision-option"]')[0].click(); });
    await flush();
    expect(q('[data-testid="decision-card"]')!.getAttribute('data-answered')).toBe('true');
    expect(q('[data-testid="decision-undo"]')).toBeNull();
  });

  it('⌘⏎ picks the primary of the focused card only', async () => {
    act(() => root.render(<DecisionCard view={decision()} now={T0} undoMs={0} />));
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
    act(() => root.render(<DecisionCard view={decision()} now={T0} undoMs={0} />));
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

  it('an option label wraps inside the card instead of running past it (no sideways scroll at 320)', () => {
    act(() => root.render(<DecisionCard view={decision()} now={T0} undoMs={0} />));
    for (const o of qa('[data-testid="decision-option"]')) {
      expect(o.className).toContain('whitespace-normal');
      expect(o.className).toContain('h-auto');
      expect(o.className).toContain('[overflow-wrap:anywhere]');
      expect(o.className).toContain('w-full');
    }
    // Side by side when they fit, each growing to share the row.
    expect(q('[data-testid="decision-options"]')!.className).toContain('flex-wrap');
  });

  it('with no structured options the card is the question and Answer differently, no dark bar', async () => {
    const view = decisionFromQuestion({
      key: 'note:n2', question: { headline: 'Keep the legacy export?', body: null, noteId: 'n2', options: [{ label: 'Kept the export since two teams still read it', recommended: true }] },
      task: null, mission: { id: 'm1', title: 'Billing exports', href: '/app/missions/m1' }, askedAt: T0,
      answer: { kind: 'note', missionId: 'm1', noteId: 'n2' },
    });
    act(() => root.render(<DecisionCard view={view} now={T0} undoMs={0} />));
    expect(qa('[data-testid="decision-option"]')).toHaveLength(0);
    expect(container.querySelector('.btn-ink')).toBeNull();
    expect(q('[data-testid="decision-question"]')!.textContent).toBe('Keep the legacy export?');
    expect(q('[data-testid="decision-answer-form"]')).toBeNull();
    await act(async () => { q('[data-testid="decision-answer-differently"]')!.click(); });
    expect(q('[data-testid="decision-answer-form"] input')).not.toBeNull();
  });

  it('an approval is Approve and Request changes as links to the diff, with no keyboard shortcut', async () => {
    const view = approvalView({
      key: 'a:t2', task: { id: 't2', title: 'Requester trigger and backfill', href: '/app/tasks/t2' }, askedAt: T0 - 60_000,
      reason: 'Workspace policy needs a person',
      diffHref: 'https://example.test/pull/5/files', approveHref: 'https://example.test/pull/5', changesHref: 'https://example.test/pull/5/files',
    });
    act(() => root.render(<DecisionCard view={view} now={T0} undoMs={0} />));
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
    act(() => root.render(<DecisionCard view={view} now={T0} undoMs={0} />));
    expect(q('[data-testid="question-subject"]')!.textContent).toContain('Billing exports');
    await act(async () => { qa('[data-testid="decision-option"]')[0].click(); });
    await flush();
    expect(calls[0].url).toBe('/api/missions/m1/notes/n1/reply');
    expect(calls[0].body).toEqual({ type: 'reply', title: 'Keep' });
    expect(q('[data-testid="decision-card"]')!.textContent).toContain('You chose Keep');
    expect(q('[data-testid="decision-undo"]')).toBeNull();
  });

  it('visual review: fixes merged, awaiting a person: the real options, no stale note, Mark all fixed is handed to the host', async () => {
    const view: import('@/lib/needs-you-card').DecisionView = {
      key: 'visual-review:m1:fix_check', kind: 'decision', task: null, mission: { id: 'm1', title: 'Spec page', href: '/app/missions/m1' }, label: 'Visual review',
      askedAt: T0 - 60_000, summary: '24 fixes merged with no new screenshot.', question: 'Are the 24 fixed screens fixed?',
      options: [
        { label: 'Mark all fixed', effect: 'Clears the review for these screens', tip: null, recommended: true },
        { label: 'Review screens', effect: 'Look at each before opening the merge', tip: null, recommended: false },
      ],
      dependents: [], diffHref: null, shortcut: false,
      answer: { kind: 'visual', missionId: 'm1', reviewHref: '/app/missions/m1', markFixed: [{ artifactIds: ['a1', 'a2'], expected: { a1: 'issue', a2: 'issue' } }], startKey: null, skips: ['The review is wrong or stuck', 'Ship it anyway'] },
    };
    const acted: string[] = [];
    act(() => root.render(<DecisionCard view={view} now={T0} undoMs={0} pageMissionId="m1" visualAct={async l => { acted.push(l); }} />));
    expect(q('[data-testid="question-subject"]')!.textContent).toBe('●Visual review· asked 1m ago');
    expect(q('[data-testid="question-subject"] a')).toBeNull();
    expect(qa('[data-testid="decision-option"]').map(o => o.textContent?.split('Clears')[0].split('Look')[0].split('Merge')[0])).toEqual(['Mark all fixed', 'Review screens']);
    // The two Skip choices sit under Answer differently, never as a typed reason or a bare Skip.
    expect(q('[data-testid="decision-skips"]')).toBeNull();
    await act(async () => { q('[data-testid="decision-answer-differently"]')!.click(); });
    expect(qa('[data-testid="decision-skip"]').map(b => b.textContent)).toEqual(['The review is wrong or stuck', 'Ship it anyway']);
    expect(q('[data-testid="decision-answer-form"]')).toBeNull();
    await act(async () => { qa('[data-testid="decision-option"]')[0].click(); });
    await flush();
    expect(acted).toEqual(['Mark all fixed']);
    expect(q('[data-answered="true"]')!.textContent).toContain('You chose Mark all fixed');
    expect(q('[data-testid="decision-undo"]')).toBeNull();
  });
  it('criteria escalation: the asking task and its age, the requirements in words, a short question, Answer differently files the answer as mission work', async () => {
    const { criteriaEscalationDecision } = await import('@/lib/mission-decisions');
    const SPEC = 'Windows runner through WSL2: one guided setup';
    const view = criteriaEscalationDecision({
      missionId: 'm1', workspaceId: 'w1', fileWorkHref: '/app/tasks/new?missionId=m1',
      mission: { id: 'm1', title: SPEC, href: '/app/missions/m1' },
      asker: { id: 't9', title: 'Verify WSL2 guided setup', href: '/app/tasks/t9' },
      askedAt: T0 - 2 * 60 * 60_000,
      unmet: { count: 4, state: 'not checked', names: ['WSL2 install step', 'Runner starts on boot', 'Setup reports progress', 'Errors say what to change'] },
    });
    act(() => root.render(<DecisionCard view={view} now={T0} undoMs={0} pageMissionId="m1" />));
    expect(q('[data-testid="question-subject"]')!.textContent).toBe('●Verify WSL2 guided setup· asked 2h ago');
    expect(q('[data-testid="decision-summary"]')!.textContent).toContain('4 requirements not checked: WSL2 install step, Runner starts on boot, Setup reports progress and 1 more.');
    expect(q('[data-testid="decision-question"]')!.textContent).toBe('Ship without these 4 checks?');
    // The spec title appears at most once on the card (here: not at all).
    expect((container.textContent!.match(new RegExp(SPEC, 'g')) ?? []).length).toBeLessThanOrEqual(1);
    expect(q('[data-testid="decision-not-now"]')).not.toBeNull();
    await act(async () => { q('[data-testid="decision-answer-differently"]')!.click(); });
    const input = q('[data-testid="decision-answer-form"] input') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'Check the install step by hand on a clean machine');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (q('[data-testid="decision-answer-form"] button[type="submit"]') as HTMLButtonElement).click(); });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/tasks');
    expect(calls[0].body).toMatchObject({ workspaceId: 'w1', missionId: 'm1', title: 'Check the install step by hand on a clean machine' });
    expect(q('[data-answered="true"]')!.textContent).toContain('You chose Check the install step by hand on a clean machine');
    expect(q('[data-testid="decision-undo"]')).toBeNull();
  });
});

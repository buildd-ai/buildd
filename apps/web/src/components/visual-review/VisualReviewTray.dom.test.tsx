/**
 * VisualReviewTray and VisualReviewAsk, mounted (happy-dom): shots grouped by
 * route with phone and desktop paired, human-review markers, "Review N"
 * opening the deck at the head of the queue, and the inline actions a phase
 * with no shots offers, all through callbacks.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 * Illustrative fixtures only.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { buildVisualReviewFixtureModel } = await import('@/lib/visual-review-model.fixtures');
const { screensToReview } = await import('@/lib/visual-review-model');
const { default: VisualReviewTray } = await import('./VisualReviewTray');
const { default: VisualReviewAsk } = await import('./VisualReviewAsk');

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

const render = (el: React.ReactElement) => act(() => root.render(el));
const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const flush = () => act(async () => { await Promise.resolve(); });

describe('VisualReviewTray with shots', () => {
  const model = buildVisualReviewFixtureModel('needs_you', { scenario: 'deck' });

  it('groups by route and pairs phone before desktop', () => {
    render(<VisualReviewTray model={model} />);
    const groups = qa('visual-review-route');
    const routes = [...new Set(model.cells.map(c => c.route))];
    expect(groups.map(g => g.dataset.route)).toEqual(routes);
    for (const g of groups) {
      const vps = [...g.querySelectorAll<HTMLElement>('[data-testid="visual-review-thumb"]')].map(t => t.dataset.viewport);
      expect(vps).toEqual(['mobile', 'desktop'].filter(v => vps.includes(v)));
    }
    expect(qa('visual-review-thumb')).toHaveLength(model.cells.length);
  });

  it('shows each thumb its human-review marker and a phone-sized frame of at least 64px', () => {
    render(<VisualReviewTray model={model} />);
    for (const t of qa('visual-review-thumb')) {
      const cell = model.cells.find(c => c.key === t.dataset.cell)!;
      expect(t.dataset.marker).toBe(cell.marker);
      const frame = t.querySelector<HTMLElement>('[data-testid="visual-review-frame"]')!;
      // The base (below md) height class: h-16 = 64px or more.
      const base = frame.className.split(/\s+/).find(c => /^h-\d+$/.test(c))!;
      expect(Number(base.slice(2)) * 4).toBeGreaterThanOrEqual(64);
    }
    expect(container.querySelectorAll('[data-marker="confirmed"]').length).toBe(model.summary.confirmed);
  });

  it('"Review N" opens the deck at the first cell in the queue; a thumb opens at its cell', () => {
    const onReview = mock((_k: string | null) => {});
    render(<VisualReviewTray model={model} onReview={onReview} />);
    const btn = q('visual-review-review-button')!;
    // The deck's own count (screensToReview), the one the Line and the Ask use
    // too: a fix check waits on you as much as an unsure shot does.
    expect(model.summary.fixChecks).toBeGreaterThan(0);
    expect(screensToReview(model)).toBe(model.summary.awaitingHuman + model.summary.fixChecks);
    expect(btn.textContent).toContain(`Review ${screensToReview(model)}`);
    act(() => btn.click());
    expect(onReview).toHaveBeenLastCalledWith(model.queue[0]);
    const thumb = qa('visual-review-thumb')[2];
    act(() => thumb.click());
    expect(onReview).toHaveBeenLastCalledWith(thumb.dataset.cell!);
  });

  it('with nothing awaiting you the button offers the screens, not a review count', () => {
    const done = buildVisualReviewFixtureModel('reviewed');
    expect(screensToReview(done)).toBe(0);
    render(<VisualReviewTray model={done} onReview={() => {}} />);
    expect(q('visual-review-review-button')!.textContent).toBe(`All ${done.cells.length} screens`);
  });

  it('after a fix merges, a thumb says so in plain words and never names a round', () => {
    render(<VisualReviewTray model={model} />);
    const thumb = (key: string) => qa('visual-review-thumb').find(t => t.dataset.cell === key)!;
    const settled = thumb('/app/inbox|mobile|');
    expect(settled.dataset.marker).toBe('fix_merged');
    expect(settled.textContent).toContain('Fix merged');
    expect(settled.getAttribute('aria-label')).toContain('fix merged, waiting for a new screenshot');
    const check = thumb('/app/tasks/:id|mobile|');
    expect(check.dataset.fixCheck).toBe('check');
    expect(check.textContent).toContain('After fix');
    expect(check.getAttribute('aria-label')).toContain('fix merged, new screenshot to check');
    for (const t of [settled, check]) {
      expect(t.textContent).not.toMatch(/round|R\d/i);
      expect(t.getAttribute('aria-label')).not.toMatch(/round/i);
    }
  });

  it('with no callback there is nothing to click', () => {
    render(<VisualReviewTray model={model} />);
    expect(q('visual-review-review-button')).toBeNull();
    expect(qa('visual-review-thumb').every(t => t.tagName !== 'BUTTON')).toBe(true);
  });
});

describe('VisualReviewTray with no shots', () => {
  it('no browser runner: turn off for this mission, or skip this audit', async () => {
    const onTurnOff = mock(async () => {});
    const onSkip = mock(async () => {});
    render(<VisualReviewTray model={buildVisualReviewFixtureModel('no_browser_runner')} actions={{ onTurnOff, onSkip }} />);
    expect(container.textContent).toContain('no browser runner is online');
    act(() => q('visual-review-action-turn-off')!.click());
    await flush();
    expect(onTurnOff).toHaveBeenCalledTimes(1);
    act(() => q('visual-review-action-skip')!.click());
    await flush();
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('boot failure: the question with its answer buttons', async () => {
    const m = buildVisualReviewFixtureModel('boot_failed');
    const onAnswer = mock(async (_a: string, _t: { workerId: string; taskId: string }) => {});
    render(<VisualReviewTray model={m} actions={{ onAnswer, answerOptions: ['Try again', 'Skip the audit'] }} />);
    expect(container.textContent).toContain('the dev server exited on start');
    const opts = qa('visual-review-answer-option');
    expect(opts.map(o => o.textContent)).toEqual(['Try again', 'Skip the audit']);
    act(() => opts[0].click());
    await flush();
    expect(onAnswer).toHaveBeenCalledWith('Try again', { workerId: m.bootFailure!.workerId, taskId: m.bootFailure!.taskId });
    expect(q('visual-review-answer-sent')).not.toBeNull();
  });

  it('stalled and failed offer retry (and skip)', async () => {
    const onRetry = mock(async () => {});
    const onSkip = mock(async () => {});
    render(<VisualReviewTray model={buildVisualReviewFixtureModel('stalled')} actions={{ onRetry, onSkip }} />);
    act(() => q('visual-review-action-retry')!.click());
    await flush();
    expect(onRetry).toHaveBeenCalledTimes(1);
    render(<VisualReviewTray model={buildVisualReviewFixtureModel('failed')} actions={{ onRetry, onSkip }} />);
    expect(q('visual-review-action-retry')).not.toBeNull();
    expect(q('visual-review-action-skip')).not.toBeNull();
  });

  it('shows an action error and re-enables the button', async () => {
    const onRetry = mock(async () => { throw new Error('Nope'); });
    render(<VisualReviewTray model={buildVisualReviewFixtureModel('stalled')} actions={{ onRetry }} />);
    act(() => q('visual-review-action-retry')!.click());
    await flush();
    await flush();
    expect(q('visual-review-action-error')!.textContent).toContain('Nope');
    expect((q('visual-review-action-retry') as HTMLButtonElement).disabled).toBe(false);
  });

  it('queued and waiting phases explain themselves with no actions', () => {
    render(<VisualReviewTray model={buildVisualReviewFixtureModel('queued')} actions={{ onRetry: () => {}, onSkip: () => {} }} />);
    expect(container.textContent).toContain('Waiting for a browser runner');
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('VisualReviewAsk', () => {
  it('renders only when the audit needs you', () => {
    render(<VisualReviewAsk model={buildVisualReviewFixtureModel('fixing')} />);
    expect(q('visual-review-ask')).toBeNull();
  });

  it('a question shows the prompt and answers through the callback, free text included', async () => {
    const m = buildVisualReviewFixtureModel('needs_you', { needsYou: 'question' });
    const onAnswer = mock(async (_a: string, _t: { workerId: string; taskId: string }) => {});
    render(<VisualReviewAsk model={m} onAnswer={onAnswer} answerOptions={['Use the demo account']} />);
    expect(q('visual-review-ask')!.textContent).toContain('Which account should I sign in with');
    act(() => q('visual-review-reply')!.click());
    const input = container.querySelector<HTMLInputElement>('input')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'The admin one');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => { input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    expect(onAnswer).toHaveBeenCalledWith('The admin one', { workerId: m.needsYou!.workerId!, taskId: m.needsYou!.taskId! });
  });

  it('unsure screens offer Review N at the first unsure cell', () => {
    const m = buildVisualReviewFixtureModel('needs_you', { scenario: 'deck' });
    const onReview = mock((_k: string | null) => {});
    render(<VisualReviewAsk model={m} onReview={onReview} />);
    expect(q('visual-review-ask')!.textContent).toContain('the agent was unsure about');
    act(() => q('visual-review-ask-review')!.click());
    expect(onReview).toHaveBeenCalledWith(m.queue[0]);
  });

  it('the round cap asks for your call', () => {
    const m = buildVisualReviewFixtureModel('needs_you', { needsYou: 'round_cap' });
    render(<VisualReviewAsk model={m} onReview={() => {}} />);
    expect(q('visual-review-ask')!.textContent).toContain('Issues remain after 2 rounds');
  });
});

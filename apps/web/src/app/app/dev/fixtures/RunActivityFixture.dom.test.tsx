/**
 * The run-activity fixture in a browser (happy-dom): what each scenario puts in
 * the DOM. Layout (overflow at 360px, 44px tap targets) cannot be measured here;
 * scripts/qa/plans/run-activity.json asserts it in a real browser.
 *
 * Lifecycle and steering assertions use the merged mission components. The
 * remaining ordering assertion is activated when step C lands. Runs in its
 * own process (scripts/run-unit-tests.ts), so the globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/dev/fixtures?state=run-activity' });

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));
mock.module('@/lib/pusher-client', () => ({
  subscribeToChannel: () => null,
  unsubscribeFromChannel: () => {},
  getSubscribedChannel: () => null,
  CHANNEL_PREFIX: 'buildd-',
}));

const { default: RunActivityFixture } = await import('./RunActivityFixture');
const {
  ATTEMPT_FLIP,
  FAILED_ERROR,
  LEGACY_LATEST_HEADLINE,
  LEGACY_PERCENT_STREAM,
  STEERING_MESSAGES,
  WAITING_PROMPT,
} = await import('./run-activity-fixtures');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(scenario: string): Promise<HTMLElement> {
  window.history.replaceState(null, '', `/app/dev/fixtures?state=run-activity&scenario=${scenario}`);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<RunActivityFixture />); });
  const section = host.querySelector<HTMLElement>(`[data-testid="run-activity-${scenario}"]`);
  if (!section) throw new Error(`scenario ${scenario} did not render`);
  return section;
}

const text = (el: Element) => el.textContent ?? '';
/** Every "<n>%" label in the rendered text. */
const percentLabels = (el: Element) => text(el).match(/\b\d{1,3}\s*%/g) ?? [];
const stepStates = (el: Element) =>
  Object.fromEntries([...el.querySelectorAll('[data-testid="run-evidence-rail"] li')].map(li => [li.getAttribute('data-phase'), li.getAttribute('data-state')]));

describe('legacy worker with a non-monotonic percent stream', () => {
  test('shows no earlier stream value and never a field of percentage labels', async () => {
    const s = await mount('legacy-percent-stream');
    for (const stale of LEGACY_PERCENT_STREAM.slice(0, -1)) {
      expect(text(s)).not.toContain(`${stale}%`);
    }
    expect(percentLabels(s).length).toBeLessThanOrEqual(1);
  });

  test('leads with the observed lifecycle and the latest meaningful action', async () => {
    const s = await mount('legacy-percent-stream');
    expect(s.querySelector('[data-testid="worker-current-action"]')?.textContent).toContain(LEGACY_LATEST_HEADLINE);
    expect(text(s)).toContain('http.ts');
    const steps = stepStates(s);
    expect(steps).toMatchObject({ started: 'done', changed: 'done', committed: 'done' });
    expect(steps.pr_open).not.toBe('done');
  });

  test('no percent label remains', async () => { expect(percentLabels(await mount('legacy-percent-stream'))).toEqual([]); });
});

describe('research task', () => {
  test('lights no code phase it never observed', async () => {
    const s = await mount('research-lifecycle');
    const steps = stepStates(s);
    expect(steps.started).toBe('done');
    for (const k of ['changed', 'committed', 'pushed', 'pr_open', 'ci', 'review', 'merged']) expect(steps[k]).not.toBe('done');
    expect(percentLabels(s)).toEqual([]);
  });

  test('artifact runs omit irrelevant phases', async () => {
    const s = await mount('research-lifecycle');
    for (const phase of ['committed', 'pushed', 'pr_open', 'ci', 'review', 'merged']) expect(s.querySelector(`[data-phase="${phase}"]`)).toBeNull();
  });
});

describe('waiting for input and error are explicit', () => {
  test('a waiting worker shows the question, its options and no live Now strip', async () => {
    const s = await mount('waiting-input');
    expect(s.querySelector('[data-testid="worker-view"]')?.getAttribute('data-state')).toBe('waiting');
    expect(s.querySelector('[data-testid="worker-needs-input-banner"]')).not.toBeNull();
    expect(text(s)).toContain(WAITING_PROMPT);
    expect(text(s)).toContain('Per request');
    expect(text(s)).toContain('Per client');
    expect(s.querySelector('[data-testid="worker-now-strip"]')).toBeNull();
  });

  test('a failed run shows its error and the failure evidence, not a live strip', async () => {
    const s = await mount('error');
    expect(s.querySelector('[data-testid="task-evidence"]')).not.toBeNull();
    expect(text(s)).toContain('test failure');
    expect(text(s)).toContain('expected 8000 to be at most 5000');
    expect(s.querySelector('[data-testid="run-activity-worker-error"]')?.textContent).toBe(FAILED_ERROR);
    expect(s.querySelector('[data-testid="worker-now-strip"]')).toBeNull();
  });
});

describe('steering message delivery states', () => {
  test('each human message has a distinct visible delivery label', async () => {
    const s = await mount('steering-acks');
    for (const [state, label] of Object.entries({ queued: 'Queued', delivered: 'Delivered', acknowledged: 'Read by the agent', undelivered: 'Not delivered' })) {
      const message = STEERING_MESSAGES[state as keyof typeof STEERING_MESSAGES];
      const bubble = [...s.querySelectorAll('p')].find(p => p.textContent === message)!.parentElement!;
      expect(text(bubble)).toContain(label);
      if (state === 'undelivered') expect(bubble.querySelector('button')?.textContent).toContain('Resend');
    }
  });

});

describe('attempts with equal timestamps', () => {
  test('a status flip changes the badge, never the order', async () => {
    const s = await mount('attempts-tie');
    const order = () => [...s.querySelectorAll('[data-worker-id]')].map(r => r.getAttribute('data-worker-id'));
    const before = order();
    expect(before.length).toBe(3);
    const flip = s.querySelector<HTMLButtonElement>('[data-testid="run-activity-flip-status"]')!;
    await act(async () => { flip.click(); });
    expect(order()).toEqual(before);
    expect(s.querySelector(`[data-worker-id="${ATTEMPT_FLIP.id}"]`)?.getAttribute('data-status')).toBe(ATTEMPT_FLIP.to);
    await act(async () => { flip.click(); });
    expect(order()).toEqual(before);
  });

  test.todo('C: the same order for every permutation of the input (createdAt, then id)');
});

/**
 * MissionBranchPanel mounted (happy-dom): shown only when informative, one
 * action only for a real owner decision, and "Report a Buildd problem" for a
 * failed check but never for a screen finding.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionBranchPanel } = await import('./MissionBranchPanel');
const { resolveVisualReviewPolicy } = await import('@/lib/workflow/visual-review-policy');
const { deriveMissionVisualReview } = await import('@/lib/workflow/visual-review-state');
const { presentVisualReview } = await import('@/lib/workflow/visual-review-presentation');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: string[] = [];

const audit = { id: 'a1', createdAt: '2026-10-01T00:00:00Z', errorType: null };
const review = (over: Record<string, unknown> = {}) => ({
  phase: 'reviewed' as const, screens: 4, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false,
  needsYouReason: null, captured: 0, expected: null, ...over,
});
const branch = (pr: Record<string, unknown> | null) => ({
  headSha: 'abcdef1234', base: 'dev', workLanded: true,
  integrationPr: pr ? { number: 9, state: 'open' as const, ready: false, blocked: false, ...pr } : null,
});
const presentation = (over: Record<string, unknown> = {}, opts = {}) =>
  presentVisualReview(deriveMissionVisualReview({
    policy: resolveVisualReviewPolicy({}),
    uiChange: { state: 'yes', source: 'diff', uiFiles: 2 },
    audit: null, review: null, waiver: null, branch: branch({}), ...over,
  } as never), opts);

async function mount(p: ReturnType<typeof presentation>, extra: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(<MissionBranchPanel missionId="m1" presentation={p} {...extra} />);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls = [];
  globalThis.fetch = (async (url: string) => { calls.push(String(url)); return new Response('{}', { status: 200 }); }) as typeof fetch;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

describe('MissionBranchPanel', () => {
  it('renders nothing when the branch has nothing to say', async () => {
    await mount(presentation({ uiChange: { state: 'no', source: null, uiFiles: 0 } }));
    expect(container.querySelector('[data-testid="mission-branch-panel"]')).toBeNull();
  });

  it('shows the state, branch and PR, with no action while the system is verifying', async () => {
    await mount(presentation({ audit, review: review({ phase: 'capturing', captured: 2, expected: 5 }) }));
    expect(container.querySelector('[data-testid="mission-branch-panel-label"]')?.textContent).toBe('Checking screens');
    expect(container.querySelector('[data-testid="mission-branch-panel-facts"]')?.textContent).toBe('into dev · PR #9 · abcdef1');
    expect(container.querySelector('button, a')).toBeNull();
  });

  it('Ready to merge offers Merge now only when a person is to merge', async () => {
    const ready = { audit, review: review(), auditedSha: 'abcdef1234', branch: branch({ ready: true }) };
    await mount(presentation(ready), { prUrl: 'https://github.com/o/r/pull/9' });
    expect(container.querySelector('[data-testid="mission-branch-panel-label"]')?.textContent).toBe('Ready to merge');
    expect(container.querySelector('[data-testid="mission-branch-merge"]')).toBeNull();
    await mount(presentation(ready, { ownerMergesIntegration: true }), { prUrl: 'https://github.com/o/r/pull/9' });
    expect(container.querySelector('[data-testid="mission-branch-merge"]')?.textContent).toBe('Merge now');
  });

  it('a failed check offers the report, which posts to the report route only', async () => {
    await mount(presentation({ audit, review: review({ phase: 'failed' }), autoRetriesLeft: 0 }));
    const btn = container.querySelector('[data-testid="mission-branch-report"]') as HTMLButtonElement;
    expect(btn.textContent).toBe('Report a Buildd problem');
    await act(async () => { btn.click(); });
    expect(calls).toEqual(['/api/missions/m1/visual-review/report']);
    expect(container.querySelector('[data-testid="mission-branch-reported"]')).not.toBeNull();
  });

  it('a screen finding never offers the report', async () => {
    await mount(presentation({ audit, review: review({ phase: 'fixing', effectiveIssues: 1, openFixes: 1 }) }));
    expect(container.querySelector('[data-testid="mission-branch-report"]')).toBeNull();
    expect(container.querySelector('[data-testid="mission-branch-panel-label"]')?.textContent).toBe('Fixing 1 issue');
  });

  it('under ask the one action is Run visual review, never a Run or Waive pair', async () => {
    await mount(presentation({ policy: resolveVisualReviewPolicy({ workspace: 'ask' }) }));
    expect(container.querySelector('[data-testid="mission-branch-run"]')?.textContent).toBe('Run visual review');
    expect(container.textContent).not.toMatch(/waive/i);
  });

  it('a closed mission shows the state without actions', async () => {
    await mount(presentation({ policy: resolveVisualReviewPolicy({ workspace: 'ask' }) }), { readonly: true });
    expect(container.querySelector('button, a')).toBeNull();
  });
});

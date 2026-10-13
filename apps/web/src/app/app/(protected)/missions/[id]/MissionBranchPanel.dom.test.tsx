/**
 * MissionBranchPanel mounted (happy-dom): draws the one presentation, offers
 * the owner nothing under an automatic policy, and files the sanitized report.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { presentVisualReview, type VisualReviewPresentation } from '@/lib/workflow/visual-review-copy';
import { deriveMissionVisualReview } from '@/lib/workflow/visual-review-state';
import { resolveVisualReviewPolicy } from '@/lib/workflow/visual-review-policy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionBranchPanel } = await import('./MissionBranchPanel');

const pres = (over: Parameters<typeof deriveMissionVisualReview>[0] extends infer T ? Partial<T> : never = {}): VisualReviewPresentation =>
  presentVisualReview(deriveMissionVisualReview({
    policy: resolveVisualReviewPolicy({ workspace: 'automatic' }),
    uiChange: { state: 'yes', source: 'diff', uiFiles: 2 },
    audit: null, review: null, waiver: null,
    branch: { headSha: 'abc1234', base: 'dev', integrationPr: { number: 9, state: 'open', ready: false, blocked: false }, workLanded: true },
    ...over,
  } as Parameters<typeof deriveMissionVisualReview>[0]));

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('MissionBranchPanel', () => {
  it('says Verifying in plain words and offers the owner nothing under automatic', () => {
    act(() => root.render(<MissionBranchPanel missionId="m1" presentation={pres()} branch="mission/x" integrationPr={{ number: 9, href: null }} />));
    const panel = container.querySelector('[data-testid="mission-branch-panel"]')!;
    expect(panel.getAttribute('data-stage')).toBe('verifying');
    expect(panel.getAttribute('data-needs-owner')).toBe('false');
    expect(container.textContent).toContain('Verifying');
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toMatch(/waive|run visual/i);
  });

  it('renders nothing when there is nothing informative', () => {
    const p = pres({ uiChange: { state: 'no', source: null, uiFiles: 0 }, branch: { headSha: null, base: 'dev', integrationPr: null, workLanded: false } });
    act(() => root.render(<MissionBranchPanel missionId="m1" presentation={p} />));
    expect(container.innerHTML).toBe('');
  });

  it('a closed mission shows the no-impact decision as a record line', () => {
    const p = pres({
      uiChange: { state: 'no', source: 'diff', uiFiles: 0 },
      autoDecision: { basis: 'rule', at: '2026-10-02T00:00:00Z', headSha: 'abc1234' },
    });
    act(() => root.render(<MissionBranchPanel missionId="m1" presentation={p} showRecord />));
    expect(container.querySelector('[data-testid="mission-branch-record"]')?.textContent).toMatch(/^Visual review not needed\./);
  });

  it('Report a Buildd problem posts once and thanks the person', async () => {
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({}) } as Response; }) as unknown as typeof fetch;
    const p = pres({
      audit: { id: 'a', createdAt: '2026-10-01T00:00:00Z', errorType: null },
      review: { phase: 'failed', screens: 0, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false, needsYouReason: null, captured: 0, expected: null },
      autoRetriesLeft: 0,
    });
    act(() => root.render(<MissionBranchPanel missionId="m1" presentation={p} />));
    const btn = container.querySelector('[data-testid="mission-branch-report"]') as HTMLButtonElement;
    expect(btn.textContent).toBe('Report a Buildd problem');
    await act(async () => { btn.click(); });
    expect(calls).toEqual(['/api/missions/m1/visual-review/report']);
    expect(container.textContent).toContain('Thanks');
    globalThis.fetch = real;
  });
});

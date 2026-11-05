/**
 * Review by risk on the Merge Policy page (spec 62e985a8 R-5, R-7). Runs in
 * its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1', width: 1280, height: 900 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ReviewByRiskFacts, ReviewByRiskFields, ReleaseSummaryCard, draftOf, policyOfDraft } = await import('./ReviewByRiskSection');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

describe('ReviewByRiskSection', () => {
  it('R-5: while on, an area with no paths says nothing waits for a person', () => {
    act(() => root.render(<ReviewByRiskFacts policy={{ enabled: true, areas: { dataMigrations: ['db/'] } }} />));
    const notes = host.querySelector('[data-testid="review-by-risk-empty-areas"]')?.textContent ?? '';
    expect(notes).toContain('Access: no paths listed. Nothing waits for a person.');
    expect(notes).toContain('Credentials: no paths listed');
    expect(notes).not.toContain('Data migrations');
  });

  it('shows no empty-area note while the mode is off', () => {
    act(() => root.render(<ReviewByRiskFacts policy={null} />));
    expect(host.textContent).toContain('Review by risk: Off');
    expect(host.querySelector('[data-testid="review-by-risk-empty-areas"]')).toBeNull();
  });

  it('the fields round-trip the stored shape, one path per line', () => {
    const d = draftOf({ enabled: true, areas: { access: ['apps/auth/', 'apps/session.ts'] } });
    expect(d.paths.access).toBe('apps/auth/\napps/session.ts');
    expect(policyOfDraft({ ...d, paths: { ...d.paths, credentials: ' secrets/ \n\n' } }))
      .toEqual({ enabled: true, areas: { access: ['apps/auth/', 'apps/session.ts'], credentials: ['secrets/'] } });
    expect(policyOfDraft(draftOf(null))).toEqual({ enabled: false });
    const onChange = mock(() => {});
    act(() => root.render(<ReviewByRiskFields draft={d} onChange={onChange} />));
    expect(host.querySelector('[data-testid="review-by-risk-empty-areas"]')?.textContent).toContain('Credentials');
  });

  it('R-7: the release summary lists its lines and approves the exact commit it describes', async () => {
    const head = 'c'.repeat(40);
    const calls: Array<{ method: string; body?: string }> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', body: init?.body as string | undefined });
      if (init?.method === 'POST') return new Response(JSON.stringify({ approved: true, headSha: head }), { status: 200 });
      return new Response(JSON.stringify({
        required: true, approved: false, omitted: 0,
        summary: { headSha: head, source: 'develop', target: 'release' },
        lines: ['Release develop into release by merge, at ccccccc: 1 PR.', '#5 A change. (built ahead of approval)'],
      }), { status: 200 });
    }) as typeof fetch;
    await act(async () => { root.render(<ReleaseSummaryCard workspaceId="ws-1" canApprove />); });
    expect(host.textContent).toContain('Release develop into release by merge');
    expect(host.textContent).toContain('built ahead of approval');
    const button = host.querySelector('[data-testid="release-summary-approve"]') as HTMLButtonElement;
    await act(async () => { button.click(); });
    expect(calls.find((c) => c.method === 'POST')?.body).toBe(JSON.stringify({ headSha: head }));
  });
});

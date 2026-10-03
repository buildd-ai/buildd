/**
 * ReadinessCard, mounted (happy-dom): one row per readiness item, ticking
 * fixable rows and proposing posts their ids (dry run first, then confirm),
 * and a repo-less workspace gets the link affordance instead of a checklist.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/workspaces/ws-1/config' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { WorkspaceReadinessItem, WorkspaceReadinessReport } from '@buildd/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/workspaces/ws-1/config',
  useSearchParams: () => new URLSearchParams(''),
}));
mock.module('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>{children as never}</a>
  ),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ReadinessCard } = await import('./ReadinessCard');

const item = (over: Partial<WorkspaceReadinessItem>): WorkspaceReadinessItem => ({
  id: 'test-command',
  label: 'Test command',
  status: 'missing',
  importance: 'core',
  evidence: [{ kind: 'absent', note: 'No test script found.' }],
  fix: { kind: 'scaffold', summary: 'Document the test command in the agent instructions.', templateId: 'agent-instructions' },
  ...over,
});

const report = (over: Partial<WorkspaceReadinessReport> = {}): WorkspaceReadinessReport => ({
  items: [
    item({ id: 'agent-instructions', label: 'Agent instructions' }),
    item({ id: 'test-command', label: 'Test command', status: 'detected', value: 'bun test', fix: null }),
    item({ id: 'typecheck-command', label: 'Typecheck command', status: 'unknown', fix: null }),
    item({ id: 'spec-root', label: 'Spec directory', importance: 'recommended', fix: { kind: 'scaffold', summary: 'Add a specs directory.', templateId: 'spec-root' } }),
    item({ id: 'release-path', label: 'Release path', importance: 'recommended', waived: { reason: 'Not released from here', at: '2026-01-01T00:00:00.000Z' } }),
  ],
  nextStep: 'propose-fixes',
  skill: 'workspace-onboarding',
  truncated: false,
  ...over,
});

interface Call { url: string; method: string; body: any }
let calls: Call[];
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

function stubFetch(routes: Record<string, (body: any) => { status?: number; json: unknown }>) {
  calls = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({}), { status: 404 });
    const r = routes[key](body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const mount = async () => {
  act(() => root.render(<ReadinessCard workspaceId="ws-1" />));
  await flush();
};

describe('ReadinessCard rows', () => {
  it('renders one row per item with its status, and ticks only fixable ones', async () => {
    stubFetch({ '/readiness': () => ({ json: report() }) });
    await mount();

    for (const [id, status] of [
      ['agent-instructions', 'missing'],
      ['test-command', 'detected'],
      ['typecheck-command', 'unknown'],
      ['spec-root', 'missing'],
      ['release-path', 'missing'],
    ] as const) {
      expect(q(`readiness-row-${id}`)?.getAttribute('data-status')).toBe(status);
    }
    expect(q('readiness-status-test-command')?.textContent).toBe('Found');
    expect(q('readiness-status-typecheck-command')?.textContent).toBe('Could not tell');
    expect(q('readiness-status-agent-instructions')?.textContent).toBe('Missing');
    expect(q('readiness-status-release-path')?.textContent).toBe('Waived');
    expect(q('readiness-dot-agent-instructions')?.getAttribute('data-tone')).toBe('warning');
    expect(q('readiness-dot-test-command')?.getAttribute('data-tone')).toBe('ok');

    expect(q('readiness-select-agent-instructions')).not.toBeNull();
    expect(q('readiness-select-spec-root')).not.toBeNull();
    expect(q('readiness-select-test-command')).toBeNull();
    expect(q('readiness-select-typecheck-command')).toBeNull();
    expect(q('readiness-select-release-path')).toBeNull();
    expect(q('readiness-row-release-path')?.textContent).toContain('Not released from here');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('puts core items before recommended ones', async () => {
    stubFetch({ '/readiness': () => ({ json: report() }) });
    await mount();
    const order = Array.from(container.querySelectorAll('[data-testid^="readiness-row-"]')).map((e) => e.getAttribute('data-testid'));
    expect(order.indexOf('readiness-row-typecheck-command')).toBeLessThan(order.indexOf('readiness-row-spec-root'));
  });

  it('shows the error and a retry when the report cannot load', async () => {
    stubFetch({ '/readiness': () => ({ status: 502, json: { error: 'GitHub unavailable' } }) });
    await mount();
    expect(q('readiness-error')?.textContent).toContain('GitHub unavailable');
  });
});

describe('ReadinessCard propose', () => {
  const scaffoldPreview = {
    files: [{ path: 'CLAUDE.md', group: 'docs', itemIds: ['agent-instructions'], commitMessage: 'docs: add', content: '# Example' }],
    skipped: [],
    prs: [{ group: 'docs', title: 'docs: add agent instructions', paths: ['CLAUDE.md'] }],
  };

  it('posts the ticked item ids as a dry run, then confirms the same ids', async () => {
    stubFetch({
      '/readiness': () => ({ json: report() }),
      '/onboarding/scaffold': (body) => ({ json: body.confirm ? { ...scaffoldPreview, task: { id: 't1' } } : scaffoldPreview }),
    });
    await mount();

    expect((q('readiness-propose') as HTMLButtonElement).disabled).toBe(true);
    act(() => { (q('readiness-select-agent-instructions') as HTMLInputElement).click(); });
    act(() => { (q('readiness-select-spec-root') as HTMLInputElement).click(); });
    expect((q('readiness-propose') as HTMLButtonElement).disabled).toBe(false);

    act(() => { q('readiness-propose')!.click(); });
    await flush();

    const dry = calls.filter((c) => c.url.includes('/onboarding/scaffold'));
    expect(dry).toHaveLength(1);
    expect(dry[0].method).toBe('POST');
    expect(dry[0].body.itemIds).toEqual(['agent-instructions', 'spec-root']);
    expect(dry[0].body.confirm).toBeUndefined();
    expect(q('readiness-preview')?.textContent).toContain('CLAUDE.md');
    expect(q('readiness-created')).toBeNull();

    act(() => { q('readiness-confirm')!.click(); });
    await flush();

    const all = calls.filter((c) => c.url.includes('/onboarding/scaffold'));
    expect(all).toHaveLength(2);
    expect(all[1].body.itemIds).toEqual(['agent-instructions', 'spec-root']);
    expect(all[1].body.confirm).toBe(true);
    expect(q('readiness-created')).not.toBeNull();
  });

  it('shows the route error and no preview when the dry run is refused', async () => {
    stubFetch({
      '/readiness': () => ({ json: report() }),
      '/onboarding/scaffold': () => ({ status: 409, json: { error: 'A scaffold task is already open' } }),
    });
    await mount();
    act(() => { (q('readiness-select-agent-instructions') as HTMLInputElement).click(); });
    act(() => { q('readiness-propose')!.click(); });
    await flush();
    expect(q('readiness-action-error')?.textContent).toContain('already open');
    expect(q('readiness-preview')).toBeNull();
  });

  it('changing the selection discards a stale preview', async () => {
    stubFetch({
      '/readiness': () => ({ json: report() }),
      '/onboarding/scaffold': () => ({ json: scaffoldPreview }),
    });
    await mount();
    act(() => { (q('readiness-select-agent-instructions') as HTMLInputElement).click(); });
    act(() => { q('readiness-propose')!.click(); });
    await flush();
    expect(q('readiness-preview')).not.toBeNull();
    act(() => { (q('readiness-select-spec-root') as HTMLInputElement).click(); });
    expect(q('readiness-preview')).toBeNull();
  });
});

describe('ReadinessCard steps', () => {
  it('a workspace with no repo shows the link affordance, not a checklist', async () => {
    stubFetch({
      '/readiness': () => ({ json: report({ items: [], nextStep: 'link-repo' }) }),
      '/api/github/installations': () => ({ json: { configured: true, installations: [{ id: 'i1', accountLogin: 'example-org' }] } }),
    });
    await mount();
    expect(q('repo-link-card')).not.toBeNull();
    expect(q('readiness-row-agent-instructions')).toBeNull();
  });

  it('the first-mission step links to the new-mission form with this workspace', async () => {
    stubFetch({ '/readiness': () => ({ json: report({ nextStep: 'first-mission' }) }) });
    await mount();
    expect(q('readiness-mission-link')?.getAttribute('href')).toBe('/app/missions/new?workspace=ws-1');
  });

  it('the author-spec step shows the spec wizard', async () => {
    stubFetch({ '/readiness': () => ({ json: report({ nextStep: 'author-spec' }) }) });
    await mount();
    expect(q('spec-wizard')).not.toBeNull();
    expect(q('readiness-next-step')?.getAttribute('data-step')).toBe('author-spec');
  });

  it('the review-policy step offers the policy review on a detected-but-unconfirmed policy', async () => {
    stubFetch({
      '/readiness': () => ({
        json: report({
          nextStep: 'review-policy',
          items: [item({ id: 'merge-policy', label: 'Merge policy', status: 'detected', value: 'migrations', fix: { kind: 'apply-config', summary: 'Review it.' } })],
        }),
      }),
    });
    await mount();
    expect(q('readiness-review-policy')).not.toBeNull();
    expect(q('readiness-select-merge-policy')).toBeNull();
  });
});

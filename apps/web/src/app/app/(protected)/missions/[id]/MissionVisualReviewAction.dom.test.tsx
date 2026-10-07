/**
 * The mission header's proactive "Visual review" (happy-dom): a mission
 * command that previews and then POSTs the mission's surface-audit endpoint,
 * never the generic task composer. Runs in its own process.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = mock(() => {});
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionVisualReviewAction } = await import('./MissionVisualReviewAction');
const { MissionVisualReviewProvider } = await import('./MissionVisualReview');
const { buildVisualReviewFixtureModel } = await import('@/lib/visual-review-model.fixtures');

const PREVIEW = {
  existing: null,
  routes: ['/app/missions/:id', '/app/home'],
  viewports: ['mobile', 'desktop'],
  capture: { branch: 'mission', ref: 'buildd/mission-x', pageSource: 'sandbox' },
  browserRunnerOnline: true,
  executorLocal: false,
};

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; method?: string }[] = [];
let replies: { GET: { ok?: boolean; json?: unknown }; POST: { ok?: boolean; status?: number; json?: unknown } };

function stubFetch() {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method });
    const r = method === 'POST' ? replies.POST : replies.GET;
    const ok = r.ok ?? true;
    return { ok, status: (r as { status?: number }).status ?? (ok ? 200 : 500), json: async () => r.json ?? {} } as Response;
  }) as unknown as typeof fetch;
}

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function click(el: Element | null) {
  if (!el) throw new Error('element not found');
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  refresh.mockClear();
  replies = { GET: { json: { preview: PREVIEW } }, POST: { json: { created: true, taskId: 'audit-1', status: 'pending' } } };
  stubFetch();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

async function mount(node = <MissionVisualReviewAction missionId="m1" />) {
  act(() => root.render(node));
  await flush();
}

describe('MissionVisualReviewAction', () => {
  it('is a button reachable at phone and desktop width, not a link to the task composer', async () => {
    await mount();
    const btn = q('mission-visual-review-action')!;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-label')).toBe('Visual review');
    // One short word on a phone, the full name at md+.
    expect(btn.querySelector('.md\\:hidden')?.textContent).toBe('Visual');
    expect(btn.querySelector('.hidden.md\\:inline')?.textContent).toBe('Visual review');
    expect(btn.className).toContain('min-h-11');
    expect(document.querySelector('a[href*="/tasks/new"]')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('opens a short sheet of what buildd knows, with no task fields', async () => {
    await mount();
    await click(q('mission-visual-review-action'));
    expect(calls).toEqual([{ url: '/api/missions/m1/surface-audit', method: 'GET' }]);
    expect(q('visual-review-routes')?.textContent).toBe('/app/missions/:id, /app/home');
    expect(q('visual-review-facts')?.textContent).toContain('Phone and Desktop');
    expect(q('visual-review-capture')?.textContent).toBe('A local build of the mission branch (buildd/mission-x)');
    const sheet = q('mission-visual-review-sheet')!;
    expect(sheet.querySelectorAll('input, textarea, select').length).toBe(0);
    expect(sheet.textContent).not.toMatch(/Any role|Title|Description|Output requirement|Depends on/);
    expect(q('visual-review-run')?.textContent).toBe('Run visual review');
  });

  it('with no screens known yet, says they are detected from the mission\'s changes', async () => {
    replies.GET = { json: { preview: { ...PREVIEW, routes: [] } } };
    await mount();
    await click(q('mission-visual-review-action'));
    expect(q('visual-review-routes')?.textContent).toBe('Detected from the mission\'s changes');
  });

  it('"Run visual review" POSTs the mission endpoint, says it is queued and refreshes the page', async () => {
    await mount();
    await click(q('mission-visual-review-action'));
    await click(q('visual-review-run'));
    expect(calls.filter(c => c.method === 'POST')).toEqual([{ url: '/api/missions/m1/surface-audit', method: 'POST' }]);
    expect(calls.some(c => c.url.includes('/api/tasks'))).toBe(false);
    expect(q('visual-review-outcome')?.textContent).toContain('Visual review queued');
    expect(q('visual-review-run')).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('an audit already on the mission is shown, and no second one is offered', async () => {
    replies.GET = { json: { preview: { ...PREVIEW, existing: { taskId: 'audit-0', status: 'in_progress' }, capture: null } } };
    await mount();
    await click(q('mission-visual-review-action'));
    expect(q('visual-review-outcome')?.textContent).toContain('already on this mission');
    expect(q('visual-review-run')).toBeNull();
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('the server answering "already exists" does not duplicate', async () => {
    replies.POST = { json: { created: false, taskId: 'audit-0', status: 'pending' } };
    await mount();
    await click(q('mission-visual-review-action'));
    await click(q('visual-review-run'));
    expect(q('visual-review-outcome')?.getAttribute('data-outcome')).toBe('existing');
    expect(q('visual-review-outcome')?.textContent).toContain('Nothing was duplicated');
  });

  it('no browser runner: says so with the next step, and still queues only the visual review', async () => {
    replies.GET = { json: { preview: { ...PREVIEW, browserRunnerOnline: false } } };
    await mount();
    await click(q('mission-visual-review-action'));
    expect(q('visual-review-browser-note')?.textContent).toContain('No runner with a browser is online');
    expect(q('visual-review-browser-note')?.textContent).toContain('start a runner');
    await click(q('visual-review-run'));
    expect(calls.filter(c => c.method === 'POST').map(c => c.url)).toEqual(['/api/missions/m1/surface-audit']);
  });

  it('a refusal is shown as an error and the action stays', async () => {
    replies.POST = { ok: false, status: 409, json: { error: 'This mission is already closed, so a visual review cannot be added.', code: 'mission_closed' } };
    await mount();
    await click(q('mission-visual-review-action'));
    await click(q('visual-review-run'));
    expect(q('visual-review-error')?.textContent).toContain('already closed');
    expect(q('visual-review-run')).not.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('?visualReview=1 arrives with the sheet open', async () => {
    await mount(<MissionVisualReviewAction missionId="m1" initialOpen />);
    expect(q('mission-visual-review-sheet')).not.toBeNull();
    expect(q('visual-review-run')).not.toBeNull();
  });

  it('with an audit on the mission, the sheet is the visual review itself', async () => {
    const model = buildVisualReviewFixtureModel('queued');
    await mount(
      <MissionVisualReviewProvider missionId={model.missionId} visual={model}>
        <MissionVisualReviewAction missionId={model.missionId} />
      </MissionVisualReviewProvider>,
    );
    await click(q('mission-visual-review-action'));
    expect(q('visual-review-surface')?.getAttribute('data-phase')).toBe('queued');
    expect(q('visual-review-run')).toBeNull();
    expect(calls).toEqual([]);
  });
});

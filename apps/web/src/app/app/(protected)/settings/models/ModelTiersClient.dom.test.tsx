/**
 * Model tiers: one tier x surface table rendered from the cells read model,
 * mounted in happy-dom with a stubbed fetch. Fixtures are illustrative.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  usePathname: () => '/app/settings/models',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ModelTiersClient } = await import('./ModelTiersClient');
const { CELLS_BODY, MODELS, POOLS_BODY } = await import('./model-tiers-fixtures');

const requests: Array<{ url: string; method: string; body: any }> = [];
beforeEach(() => {
  requests.length = 0;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    requests.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method !== 'GET') return new Response('{"ok":true}', { status: 200 });
    if (u.startsWith('/api/model-tiers/cells')) return new Response(JSON.stringify(CELLS_BODY), { status: 200 });
    if (u.startsWith('/api/model-tiers/pools/')) {
      return new Response(JSON.stringify({ changes: [
        { id: 'c1', kind: 'revert', at: '2026-09-20T10:00:00Z', actor: 'system', after: null, reason: 'merged rate 40% vs primary 75% over 30 runs' },
        { id: 'c2', kind: 'dial', at: '2026-09-10T10:00:00Z', actor: 'admin', after: { dial: 4 }, reason: 'dial set to 4' },
      ] }), { status: 200 });
    }
    if (u.startsWith('/api/model-tiers/pools')) return new Response(JSON.stringify(POOLS_BODY), { status: 200 });
    if (u.startsWith('/api/models')) return new Response(JSON.stringify({ models: MODELS, catalogComplete: true }), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(isAdmin = true) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<ModelTiersClient teamId="team-demo" teamName="Demo" isAdmin={isAdmin} />); });
  await flush();
  await flush();
}
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('element not found');
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
  await flush();
};
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const stateOf = (surface: string, tier: string) => q(`[data-testid="cell-${surface}-${tier}"] [data-testid="cell-state"]`)?.textContent;

describe('ModelTiersClient: the table', () => {
  it('is one table with a cell per tier x surface', async () => {
    await mount();
    const table = q('[data-testid="tier-table"]')!;
    expect(table.textContent).toContain('Coding');
    expect(table.textContent).toContain('Chat');
    for (const tier of ['premium-plus', 'premium', 'standard', 'budget']) {
      expect(q(`[data-testid="tier-row-${tier}"]`)).not.toBeNull();
      expect(q(`[data-testid="cell-agent-${tier}"]`)).not.toBeNull();
      expect(q(`[data-testid="cell-chat-${tier}"]`)).not.toBeNull();
    }
  });

  it('says each state in words', async () => {
    await mount();
    expect(stateOf('agent', 'premium-plus')).toBe('always this model');
    expect(stateOf('agent', 'premium')).toBe('learning 12 of 40');
    expect(stateOf('agent', 'standard')).toBe('deepseek/deepseek-v4-pro matches · 50% there');
    expect(stateOf('agent', 'budget')).toBe('back to primary · qwen/qwen3-coder slipped');
    expect(stateOf('chat', 'premium')).toBe('no quality signal');
  });

  it('shows the primary with its price', async () => {
    await mount();
    const cell = q('[data-testid="cell-agent-standard"]')!;
    expect(cell.querySelector('[data-testid="cell-primary"]')!.textContent).toBe('claude-sonnet-5');
    expect(cell.querySelector('[data-testid="cell-price"]')!.textContent).toBe('$2/$10');
  });

  it('greys a primary the team did not set and footnotes its source; the team\'s own rows carry no mark', async () => {
    await mount();
    const own = q('[data-testid="cell-agent-standard"] [data-testid="cell-primary"]')!;
    expect(own.className).toContain('text-text-primary');
    expect(own.querySelector('[data-testid="cell-source-mark"]')).toBeNull();

    const def = q('[data-testid="cell-agent-premium-plus"] [data-testid="cell-primary"]')!;
    expect(def.className).toContain('text-text-muted');
    expect(def.querySelector('[data-testid="cell-source-mark"]')!.textContent).toBe('*');
    expect(q('[data-testid="source-note-default"]')!.textContent).toBe('* buildd default');
    expect(q('[data-testid="source-note-service"]')!.textContent).toContain('policy service');
    expect(q('[data-testid="source-note-workspace"]')).toBeNull();
  });

  it('marks only a cell with a running experiment as testing', async () => {
    await mount();
    expect(q('[data-testid="cell-agent-budget"] [data-testid="cell-testing"]')!.textContent).toContain('testing');
    expect(document.querySelectorAll('[data-testid="cell-testing"]').length).toBe(1);
  });

  it('collapses workspace overrides into one link that lists them', async () => {
    await mount();
    const link = q('[data-testid="tier-overrides"]')!;
    expect(link.textContent).toBe('2 workspaces differ');
    expect(q('[data-testid="tier-overrides-list"]')).toBeNull();
    await click(link);
    expect(q('[data-testid="tier-overrides-list"]')!.textContent).toContain('standard · Chat: 2 workspaces keep its own model');
  });

  it('has none of the removed controls: no pinned, split, weights, Apply, win or mistakes columns, no inline change log', async () => {
    await mount();
    const text = host.textContent!;
    for (const gone of ['pinned', 'split', 'Apply', 'Win', 'Mistakes', 'Traffic', 'Changes', 'Base models']) {
      expect(text).not.toContain(gone);
    }
    expect(q('[data-testid="pool-weight"]')).toBeNull();
    expect(q('[data-testid="tier-pools"]')).toBeNull();
    expect(q('[data-testid="tier-split"]')).toBeNull();
    expect(requests.some((r) => r.url.startsWith('/api/model-tiers/pools/'))).toBe(false);
  });

  it('gives members the table without edit buttons', async () => {
    await mount(false);
    const cell = q('[data-testid="cell-agent-premium"]')!;
    expect(cell.tagName).toBe('DIV');
    await click(cell);
    expect(q('[data-testid="cell-editor"]')).toBeNull();
  });
});

describe('ModelTiersClient: the cell editor', () => {
  it('opens anchored to the clicked cell', async () => {
    await mount();
    const cell = q('[data-testid="cell-agent-premium"]')!;
    cell.getBoundingClientRect = () => ({ left: 420, right: 760, top: 200, bottom: 244, width: 340, height: 44, x: 420, y: 200, toJSON: () => ({}) }) as DOMRect;
    await click(cell);
    const panel = q('[data-testid="cell-editor-panel"]')!;
    expect(panel.style.left).toBe('420px');
    expect(panel.style.top).toBe('248px');
    expect(panel.querySelector('[data-testid="cell-editor"]')!.getAttribute('data-cell')).toBe('agent-premium');
  });

  it('holds the primary, the may-also-use list, the dial and a plain learning status, with no percentage input', async () => {
    await mount();
    await click(q('[data-testid="cell-agent-premium"]'));
    const ed = q('[data-testid="cell-editor"]')!;
    expect(ed.querySelector('[data-testid="cell-primary-picker"]')!.getAttribute('data-value')).toBe("anthropic::claude-opus-5");
    expect([...ed.querySelectorAll('[data-testid="cell-alternate"]')].map((li) => li.textContent)).toEqual(['claude-sonnet-5Remove']);
    expect(ed.querySelector('[data-testid="cell-dial-3"]')).toBeNull();
    await click(ed.querySelector('[data-testid="cell-advanced-toggle"]'));
    expect(ed.querySelector('[data-testid="cell-dial-3"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(ed.querySelector('[data-testid="cell-learning"]')!.textContent).toContain('12 of 40 graded runs');
    expect(ed.querySelector('input[type="number"]')).toBeNull();
    expect(ed.querySelector('input')).toBeNull();
  });

  it('Save sets the dial against the pool\'s latest version; Cancel writes nothing', async () => {
    await mount();
    await click(q('[data-testid="cell-agent-premium"]'));
    expect((q('[data-testid="cell-save"]') as HTMLButtonElement).disabled).toBe(true);
    await click(q('[data-testid="cell-cancel"]'));
    expect(q('[data-testid="cell-editor"]')).toBeNull();
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);

    await click(q('[data-testid="cell-agent-premium"]'));
    await click(q('[data-testid="cell-advanced-toggle"]'));
    await click(q('[data-testid="cell-dial-5"]'));
    await click(q('[data-testid="cell-save"]'));
    const writes = requests.filter((r) => r.method !== 'GET');
    expect(writes).toEqual([{ url: '/api/model-tiers/cells', method: 'PATCH', body: { teamId: 'team-demo', tier: 'premium', surface: 'agent', dial: 5, expectedVersion: 7 } }]);
    expect(q('[data-testid="cell-editor"]')).toBeNull();
  });

  it('removing an alternate deletes that arm at the current version', async () => {
    await mount();
    await click(q('[data-testid="cell-agent-premium"]'));
    await click(q('[data-testid="cell-alternate-remove"]'));
    await click(q('[data-testid="cell-save"]'));
    const writes = requests.filter((r) => r.method !== 'GET');
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual(['DELETE /api/model-tiers/pools/pool-prem/arms/arm-sonnet?teamId=team-demo&expectedVersion=7']);
  });

  it('premium-plus has no alternates or dial', async () => {
    await mount();
    await click(q('[data-testid="cell-agent-premium-plus"]'));
    expect(q('[data-testid="cell-alternates"]')).toBeNull();
    expect(q('[data-testid="cell-routing"]')).toBeNull();
    expect(q('[data-testid="cell-learning"]')!.textContent).toBe('Premium-plus always uses its primary.');
  });
});

describe('ModelTiersClient: what ran and history', () => {
  it('a routing tier\'s name opens what ran with share, changes merged, passed review and cost per run', async () => {
    await mount();
    expect(q('[data-testid="tier-name-premium-plus"]')!.tagName).toBe('SPAN');
    await click(q('[data-testid="tier-name-standard"]'));
    const sheet = q('[data-testid="what-ran-sheet"]')!;
    const rows = [...sheet.querySelectorAll('[data-testid="what-ran-agent"] [data-testid="what-ran-model"]')];
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('claude-sonnet-5');
    expect(rows[0].textContent).toContain('60%');
    expect(rows[0].textContent).toContain('80%');
    expect(rows[0].textContent).toContain('$0.42');
    expect(rows[0].textContent).toContain('80% (20 of 25)');
    expect(rows[0].textContent).toContain('$0.42 per run');
    // too few graded runs for a percentage: counts, not 75%
    expect(rows[1].textContent).toContain('Changes merged3 of 4');
    expect(rows[1].textContent).toContain('Passed reviewnot measured');
    expect(sheet.querySelector('[data-testid="what-ran-denominator"]')!.textContent).toContain('Share of 50 runs');
    const recent = sheet.querySelector('[data-testid="what-ran-recent"]')!;
    expect(recent.textContent).toContain('Add retry to webhook sender');
    expect(recent.textContent).toContain('Changes merged');
    expect(recent.textContent).toContain('Not merged');
    expect(recent.textContent).not.toContain('not graded');
    expect(recent.querySelector('a')!.getAttribute('href')).toBe('/app/tasks/task-b');
  });

  it('the chat variant shows satisfied, thumbs, re-asked and cost per conversation', async () => {
    await mount();
    await click(q('[data-testid="tier-name-premium"]'));
    const chat = q('[data-testid="what-ran-chat"]')!;
    expect(chat.textContent).toContain('Satisfied');
    expect(chat.textContent).toContain('per conversation');
    expect(chat.textContent).toContain('9 up · 1 down');
    expect(chat.textContent).not.toContain('Merged');
  });

  it('History lists every cell\'s changes with their reason, and links to what ran', async () => {
    await mount();
    await click(q('[data-testid="tiers-history"]'));
    const list = q('[data-testid="history-changes"]')!;
    expect(list.textContent).toContain('Returned to primary');
    expect(list.textContent).toContain('merged rate 40% vs primary 75% over 30 runs');
    expect(list.textContent).toContain('Changed how far traffic may move');
    expect(list.textContent).not.toContain('system:succession');
    await click(q('[data-testid="history-what-ran-standard"]'));
    expect(q('[data-testid="what-ran-sheet"]')).not.toBeNull();
  });
});

describe('ModelTiersClient: load failure', () => {
  it('says what happened and offers Retry instead of a bare status code', async () => {
    const ok = globalThis.fetch;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/model-tiers/cells')) return new Response('oops', { status: 500 });
      return ok(url, init);
    }) as unknown as typeof fetch;
    await mount();
    const err = q('[data-testid="load-error"]')!;
    expect(err).not.toBeNull();
    expect(err.textContent).toContain("couldn't load");
    expect(err.textContent).toContain('Retry');
    expect(err.textContent).toContain('HTTP 500'); // only inside Details
    const summary = err.querySelector('details > summary');
    expect(summary?.textContent).toBe('Details');
    expect(err.textContent!.replace(err.querySelector('details')!.textContent!, '')).not.toContain('HTTP 500');
    globalThis.fetch = ok;
    await click([...err.querySelectorAll('button')].find((b) => b.textContent === 'Retry'));
    expect(q('[data-testid="load-error"]')).toBeNull();
  });
});

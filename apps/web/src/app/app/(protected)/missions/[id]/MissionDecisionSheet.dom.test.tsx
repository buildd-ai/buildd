/**
 * MissionDecisionSheet mounted (happy-dom): the interactive half of the
 * decision sheet for a mission whose completion is blocked on a missing visual
 * audit. Runs in its own process, so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { GoalCriterion } from '@buildd/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = mock(() => {});
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionDecisionSheet } = await import('./MissionDecisionSheet');

const CRITERIA: GoalCriterion[] = [{ type: 'command', command: 'bun test' }];
const AUDIT = { paths: ['apps/web/src/app/page.tsx', 'apps/web/src/components/Nav.tsx'], executorLocal: false };

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; method?: string; body: any }[] = [];

type Reply = { ok?: boolean; status?: number; json?: unknown; throws?: boolean };
let replies: Record<string, Reply> = {};

function stubFetch(next: Record<string, Reply>) {
  calls = [];
  replies = next;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(replies).find(k => u.endsWith(k));
    const r = (key && replies[key]) || { ok: true, json: {} };
    if (r.throws) throw new Error('network down');
    const ok = r.ok ?? true;
    return { ok, status: r.status ?? (ok ? 200 : 500), json: async () => r.json ?? {} } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  refresh.mockClear();
  stubFetch({});
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const buttons = () => [...container.querySelectorAll('button')] as HTMLButtonElement[];
const button = (label: string) => buttons().find(b => b.textContent?.trim() === label);
const reasonField = () => container.querySelector('[data-testid="surface-audit-reason"]') as HTMLTextAreaElement | null;

function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

async function mount(props: { criteriaUnmet?: boolean } = {}) {
  await act(async () => {
    root.render(
      <MissionDecisionSheet
        missionId="m1"
        goalCriteria={CRITERIA}
        failingCriterionIndex={0}
        fileWorkHref="/app/tasks/new?missionId=m1"
        criteriaUnmet={props.criteriaUnmet ?? false}
        surfaceAudit={AUDIT}
      />,
    );
  });
  await flush();
}

const click = async (el: HTMLElement | undefined) => { await act(async () => { el!.click(); }); await flush(); };

describe('MissionDecisionSheet (mounted): visual audit', () => {
  it('blocks a waiver reason under 10 characters on the client, with no request', async () => {
    await mount();
    await click(button('Waive with reason'));
    type(reasonField()!, 'too short');
    await click(button('Save reason and complete'));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('at least 10 characters');
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([]);
    expect(container.querySelector('[data-testid="surface-audit-waived"]')).toBeNull();
  });

  it('counts the trimmed reason: ten spaces and a letter is still too short', async () => {
    await mount();
    await click(button('Waive with reason'));
    type(reasonField()!, '          a');
    await click(button('Save reason and complete'));
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([]);
  });

  it('sends the waiver with the completion, then records the reason it sent', async () => {
    stubFetch({ '/api/missions/m1': { ok: true, json: { id: 'm1' } } });
    await mount();
    await click(button('Waive with reason'));
    type(reasonField()!, '  Copy-only change, no layout touched.  ');
    await click(button('Save reason and complete'));

    const patch = calls.find(c => c.method === 'PATCH')!;
    expect(patch.url).toBe('/api/missions/m1');
    expect(patch.body).toEqual({ surfaceAuditWaiver: 'Copy-only change, no layout touched.', status: 'completed' });
    expect(container.querySelector('[data-testid="surface-audit-waived"]')?.textContent)
      .toContain('Reason recorded: Copy-only change, no layout touched.');
    expect(refresh).toHaveBeenCalled();
  });

  it('records nothing when the server refuses the waiver, and shows no API wording', async () => {
    stubFetch({
      '/api/missions/m1': { ok: false, status: 409, json: { code: 'surface_audit_missing', error: 'Create a `[surface audit]` task via manage_missions' } },
    });
    await mount();
    await click(button('Waive with reason'));
    type(reasonField()!, 'Copy-only change, no layout touched.');
    await click(button('Save reason and complete'));

    expect(container.querySelector('[data-testid="surface-audit-waived"]')).toBeNull();
    const alert = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('Nothing was recorded');
    expect(container.textContent).not.toContain('manage_missions');
    expect(container.textContent).not.toContain('[surface audit]');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('with goal criteria also unmet, waives the audit only and never completes the mission', async () => {
    await mount({ criteriaUnmet: true });
    await click(button('Waive with reason'));
    type(reasonField()!, 'Copy-only change, no layout touched.');
    await click(button('Waive the audit'));

    expect(calls.find(c => c.method === 'PATCH')!.body).toEqual({ surfaceAuditWaiver: 'Copy-only change, no layout touched.' });
    expect(container.querySelector('[data-testid="criteria-decision"]')).not.toBeNull();
  });

  it('"Run visual audit" asks for the audit and says so', async () => {
    stubFetch({ '/surface-audit': { ok: true, json: { created: true, taskId: 't1', status: 'pending' } } });
    await mount();
    await click(button('Run visual audit'));

    const post = calls.find(c => c.url === '/api/missions/m1/surface-audit')!;
    expect(post.method).toBe('POST');
    expect(container.querySelector('[data-testid="surface-audit-requested"]')?.textContent).toContain('was added');
    expect(button('Run visual audit')).toBeUndefined();
  });

  it('says so when an audit is already on the mission', async () => {
    stubFetch({ '/surface-audit': { ok: true, json: { created: false, taskId: 't1', status: 'running' } } });
    await mount();
    await click(button('Run visual audit'));
    expect(container.querySelector('[data-testid="surface-audit-requested"]')?.textContent).toContain('already on this mission');
  });

  it('keeps both actions when adding the audit fails', async () => {
    stubFetch({ '/surface-audit': { ok: false, status: 409, json: { error: 'This mission is already closed, so a visual audit cannot be added.' } } });
    await mount();
    await click(button('Run visual audit'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('already closed');
    expect(button('Run visual audit')).toBeDefined();
    expect(button('Waive with reason')).toBeDefined();
  });
});

describe('MissionDecisionSheet (mounted): Jev suggestion', () => {
  it('pre-selects a suggested waiver, shows why, and prefills an editable reason without acting', async () => {
    stubFetch({
      '/surface-audit/advice': {
        ok: true,
        json: { advice: { recommend: 'waive', why: 'These changes look unlikely to change what is rendered.', waiverDraft: 'Owner review: no visual change expected.' } },
      },
    });
    await mount();

    expect(container.querySelector('[data-testid="surface-audit-advice"]')?.textContent).toContain('unlikely to change what is rendered');
    expect(container.querySelector('[data-recommended="true"]')?.textContent).toContain('Waive with reason');
    expect(reasonField()!.value).toBe('Owner review: no visual change expected.');
    // The person always confirms: nothing was sent but the suggestion request.
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(['POST /api/missions/m1/surface-audit/advice']);

    type(reasonField()!, 'My own reason, not the draft.');
    await click(button('Save reason and complete'));
    expect(calls.find(c => c.method === 'PATCH')!.body.surfaceAuditWaiver).toBe('My own reason, not the draft.');
  });

  it('pre-selects a suggested audit without running it', async () => {
    stubFetch({ '/surface-audit/advice': { ok: true, json: { advice: { recommend: 'audit', why: 'These changes can change what people see.' } } } });
    await mount();

    expect(container.querySelector('[data-recommended="true"]')?.textContent).toContain('Run visual audit');
    expect(reasonField()).toBeNull();
    expect(calls.some(c => c.url === '/api/missions/m1/surface-audit')).toBe(false);
  });

  it('never overwrites a reason the person already started typing', async () => {
    let release: () => void = () => {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: undefined });
      await new Promise<void>(r => { release = r; });
      return { ok: true, status: 200, json: async () => ({ advice: { recommend: 'waive', why: 'Unlikely to change.', waiverDraft: 'Draft that must not win.' } }) } as Response;
    }) as unknown as typeof fetch;
    await mount();
    await click(button('Waive with reason'));
    type(reasonField()!, 'Typed before the suggestion arrived.');
    await act(async () => { release(); });
    await flush();
    expect(reasonField()!.value).toBe('Typed before the suggestion arrived.');
  });

  for (const [name, reply] of [
    ['an HTTP error', { ok: false, status: 500, json: {} }],
    ['a network failure', { throws: true }],
    ['no suggestion', { ok: true, json: { advice: null } }],
    ['a malformed suggestion', { ok: true, json: { advice: { recommend: 'maybe', why: 'x' } } }],
  ] as [string, Reply][]) {
    it(`fails soft on ${name}: both actions live, nothing pre-selected`, async () => {
      stubFetch({ '/surface-audit/advice': reply });
      await mount();

      expect(container.querySelector('[data-recommended="true"]')).toBeNull();
      expect(container.querySelector('[data-testid="surface-audit-advice"]')).toBeNull();
      expect(reasonField()).toBeNull();
      expect(button('Run visual audit')?.disabled).toBe(false);
      expect(button('Waive with reason')?.disabled).toBe(false);
    });
  }
});

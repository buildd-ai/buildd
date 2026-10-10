/**
 * MissionSettings → Complete (happy-dom): a blocked completion opens the
 * decision sheet instead of a request that can only fail.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = mock(() => {});
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh }),
}));
mock.module('@/lib/pusher-client', () => ({
  subscribeToChannel: () => null,
  unsubscribeFromChannel: () => {},
  CHANNEL_PREFIX: 'test-',
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionSettings } = await import('./MissionSettings');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; method?: string; body: any }[] = [];
let patchReply: { ok: boolean; status: number; json: unknown } | 'throw' = { ok: true, status: 200, json: {} };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  refresh.mockClear();
  calls = [];
  patchReply = { ok: true, status: 200, json: {} };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url).includes('/advice')) return { ok: false, status: 500, json: async () => ({}) } as Response;
    if (init?.method === 'PATCH') {
      if (patchReply === 'throw') throw new Error('network down');
      return { ok: patchReply.ok, status: patchReply.status, json: async () => patchReply.json } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const button = (label: string) =>
  ([...container.querySelectorAll('button')] as HTMLButtonElement[]).find(b => b.textContent?.trim() === label);
const patches = () => calls.filter(c => c.method === 'PATCH');

const AUDIT = { paths: ['apps/web/src/app/page.tsx'], executorLocal: false };
const DECISION = { goalCriteria: [], failingCriterionIndex: null, fileWorkHref: '/x', criteriaUnmet: false };

async function mount(extra: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(
      <MissionSettings
        missionId="m1"
        currentStatus="active"
        cronExpression={null}
        workspaceId="ws-1"
        roles={[]}
        hasSchedule={false}
        isHeld={false}
        displayState="review"
        {...(extra as object)}
      />,
    );
  });
}
const click = async (el: HTMLElement | undefined) => { await act(async () => { el!.click(); }); await flush(); };

describe('Complete in the settings drawer', () => {
  it('opens the decision sheet without any PATCH when the page knows the audit is missing', async () => {
    await mount({ completionDecision: { ...DECISION, surfaceAudit: AUDIT } });
    await click(button('Complete mission'));
    expect(patches()).toHaveLength(0);
    expect(container.querySelector('[data-testid="mission-complete-decision"]')).not.toBeNull();
    expect(button('Run visual audit')).toBeDefined();
    expect(button('Waive with reason')).toBeDefined();
  });

  it('routes a surface_audit_missing refusal into the same sheet, not a generic error', async () => {
    patchReply = { ok: false, status: 409, json: { code: 'surface_audit_missing', error: 'agent wording', uiPaths: ['a.tsx'] } };
    await mount({ completionDecision: { ...DECISION, surfaceAudit: null } });
    await click(button('Complete mission'));
    expect(patches()).toHaveLength(1);
    expect(container.querySelector('[data-testid="mission-complete-decision"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Failed to update mission');
    expect(container.textContent).toContain('a.tsx');
  });

  it('waiving sends surfaceAuditWaiver with the completion and refreshes only on success', async () => {
    await mount({ completionDecision: { ...DECISION, surfaceAudit: AUDIT } });
    await click(button('Complete mission'));
    await click(button('Waive with reason'));
    const field = container.querySelector('[data-testid="surface-audit-reason"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => { setter.call(field, 'Backend-only copy change, no visible screen'); field.dispatchEvent(new Event('input', { bubbles: true })); });
    await click(button('Save reason and complete'));
    expect(patches()).toHaveLength(1);
    expect(patches()[0].body).toEqual({ surfaceAuditWaiver: 'Backend-only copy change, no visible screen', status: 'completed' });
    expect(refresh).toHaveBeenCalled();
  });

  it('opens the sheet for unmet goal criteria rather than silently overriding them', async () => {
    await mount({ completionDecision: { ...DECISION, criteriaUnmet: true, surfaceAudit: null } });
    await click(button('Complete mission'));
    expect(patches()).toHaveLength(0);
    expect(container.querySelector('[data-testid="criteria-decision"]')).not.toBeNull();
  });

  it('shows the server text for an unexpected refusal and never claims completion', async () => {
    patchReply = { ok: false, status: 500, json: { error: 'Boom from server' } };
    await mount({ completionDecision: { ...DECISION } });
    await click(button('Complete mission'));
    expect(container.textContent).toContain('Boom from server');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('says the mission is not completed on a network failure', async () => {
    patchReply = 'throw';
    await mount({ completionDecision: { ...DECISION } });
    await click(button('Complete mission'));
    expect(container.textContent).toContain('is not completed');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('completes a backend-only mission with one PATCH', async () => {
    await mount({ completionDecision: { ...DECISION } });
    await click(button('Complete mission'));
    expect(patches()).toHaveLength(1);
    expect(patches()[0].body).toEqual({ status: 'completed' });
    expect(refresh).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="mission-complete-decision"]')).toBeNull();
  });

  it('the overflow Complete (non-review state) opens the same sheet', async () => {
    await mount({ displayState: 'active', hasPrimaryAction: true, completionDecision: { ...DECISION, surfaceAudit: AUDIT } });
    const more = container.querySelector('summary') as HTMLElement | null;
    more?.click();
    await click(button('Complete'));
    expect(patches()).toHaveLength(0);
    expect(container.querySelector('[data-testid="mission-complete-decision"]')).not.toBeNull();
  });
});

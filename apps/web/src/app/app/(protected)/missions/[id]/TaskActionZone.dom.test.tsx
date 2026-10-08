/**
 * TaskActionZone mounted (happy-dom): the inline Force start that replaces a
 * refused "Run now" in the mission task sheet.
 *
 * - a bypassable 422 shows Force start, and pressing it posts forceOverride once;
 * - a refusal that cannot be forced (capability, workspace cap, canForce false)
 *   shows its error and no Force start;
 * - the runner fleet is fetched only after a bypassable refusal, and the
 *   zero-runner line carries the role caveat.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
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
const { default: TaskActionZone } = await import('./TaskActionZone');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;
let calls: { url: string; body: unknown }[] = [];
let codexConfigured = false;

function stubFetch(startReply: { status: number; body: Record<string, unknown> }, fleet: unknown[] = []) {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u === '/api/workers/active') {
      return { ok: true, status: 200, json: async () => ({ activeLocalUis: fleet }) } as Response;
    }
    if (u.endsWith('/backends')) {
      return { ok: true, status: 200, json: async () => ({ backends: [{ id: 'claude', available: true }, { id: 'codex', available: codexConfigured }] }) } as Response;
    }
    const first = calls.filter(c => c.url.endsWith('/start')).length === 1;
    const reply = first ? startReply : { status: 200, body: {} };
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(label)) as HTMLButtonElement | undefined;

async function mount(props: Partial<Parameters<typeof TaskActionZone>[0]> = {}) {
  await act(async () => {
    root.render(
      <TaskActionZone
        taskId="t1"
        workspaceId="ws1"
        phase="pending"
        isBlocked={false}
        blockedByCount={0}
        backend="claude"
        lastError={null}
        worker={null}
        {...props}
      />,
    );
  });
}

const startCalls = () => calls.filter(c => c.url === '/api/tasks/t1/start');

describe('TaskActionZone — inline Force start', () => {
  it('a bypassable 422 offers Force start, and pressing it posts forceOverride exactly once', async () => {
    stubFetch({ status: 422, body: { gateReason: 'mission_local', canForce: true, blockClass: 'policy' } });
    await mount();
    await act(async () => { button('Run now')!.click(); });
    await flush();
    expect(container.textContent).toContain('Running in a local session');
    const force = button('Force start');
    expect(force).toBeDefined();
    await act(async () => { force!.click(); });
    await flush();
    const forced = startCalls().filter(c => (c.body as { forceOverride?: boolean })?.forceOverride === true);
    expect(forced).toHaveLength(1);
  });

  it.each([
    ['capability gate', { gateReason: 'capability_mismatch', canForce: true, blockClass: 'capability', error: 'No credential' }],
    ['workspace cap', { gateReason: 'workspace_cap_reached', canForce: true, blockClass: 'policy', error: 'Workspace is full' }],
    ['not forceable', { gateReason: 'subject_dead', canForce: false, error: 'Subject closed' }],
  ])('%s shows the error and no Force start', async (_name, body) => {
    stubFetch({ status: 422, body });
    await mount();
    await act(async () => { button('Run now')!.click(); });
    await flush();
    expect(button('Force start')).toBeUndefined();
    expect(container.textContent).toContain(body.error as string);
    expect(calls.some(c => c.url === '/api/workers/active')).toBe(false);
  });

  it('does not fetch the fleet until a refusal exists', async () => {
    stubFetch({ status: 200, body: {} });
    await mount();
    await flush();
    expect(calls.some(c => c.url === '/api/workers/active')).toBe(false);
  });

  it('skips the fleet fetch without a workspace id', async () => {
    stubFetch({ status: 422, body: { gateReason: 'mission_held', canForce: true, blockClass: 'policy' } });
    await mount({ workspaceId: '' });
    await act(async () => { button('Run now')!.click(); });
    await flush();
    expect(button('Force start')).toBeDefined();
    expect(calls.some(c => c.url === '/api/workers/active')).toBe(false);
  });

  it('with no runner online the confirmation says so and carries the visual-auditor caveat', async () => {
    stubFetch({ status: 422, body: { gateReason: 'mission_held', canForce: true, blockClass: 'policy' } }, []);
    await mount({ roleSlug: 'visual-auditor' });
    await act(async () => { button('Run now')!.click(); });
    await flush();
    expect(container.textContent).toContain('No runners online');
    expect(container.textContent).toContain('browser-capable runner');
  });
});

describe('TaskActionZone — raise workspace cap stepper', () => {
  const gatedCapBody = { gateReason: 'workspace_cap_reached', canForce: true, canExempt: true, blockClass: 'policy', cap: 3, active: 3, error: 'Workspace is full' };

  it('keeps −/value/+ in their own group, separate from the label and Save & start, so they never split across lines', async () => {
    stubFetch({ status: 422, body: gatedCapBody });
    await mount();
    await act(async () => { button('Run now')!.click(); });
    await flush();
    const lower = button('−')!;
    const raise = button('+')!;
    expect(lower.parentElement).toBe(raise.parentElement);
    const group = lower.parentElement!;
    expect(group.contains(container.querySelector('.tabular-nums'))).toBe(true);
    expect(group.contains(button('Save & start')!)).toBe(false);
  });

  it('steps the target between cap+1 and 20, then raising saves the workspace cap and restarts the task', async () => {
    // A dedicated stub: the shared stubFetch's "first /start call" heuristic
    // can't also distinguish the PATCH /api/workspaces/[id] raiseCapAndStart
    // makes, since that call doesn't end in "/start" either.
    calls = [];
    let startCallCount = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u === '/api/tasks/t1/start') {
        startCallCount += 1;
        if (startCallCount === 1) return { ok: false, status: 422, json: async () => gatedCapBody } as Response;
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      if (u === '/api/workspaces/ws1') {
        return { ok: true, status: 200, json: async () => ({ maxConcurrentTasks: 5 }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    await mount();
    await act(async () => { button('Run now')!.click(); });
    await flush();
    const value = () => container.querySelector('.tabular-nums')!.textContent;
    expect(value()).toBe('4'); // cap (3) + 1

    await act(async () => { button('−')!.click(); }); // floor is cap+1: no-op
    await flush();
    expect(value()).toBe('4');

    await act(async () => { button('+')!.click(); });
    await flush();
    expect(value()).toBe('5');

    await act(async () => { button('Save & start')!.click(); });
    await flush();
    const patch = calls.find(c => c.url === '/api/workspaces/ws1');
    expect(patch?.body).toEqual({ maxConcurrentTasks: 5 });
    expect(startCallCount).toBe(2);
  });
});

describe('TaskActionZone — a provider sign-in failure', () => {
  it('says what to do in plain words, links the credential setting, and folds the raw text', async () => {
    stubFetch({ status: 200, body: {} });
    await mount({ phase: 'failed', lastError: { excerpt: 'Not logged in · Please run /login' } });
    await flush();
    const zone = container.textContent ?? '';
    expect(zone).toContain('no working model key');
    expect(zone).not.toContain('Please run /login');
    const link = container.querySelector('a[href="/app/settings/runners#agent-key"]');
    expect(link?.textContent).toBe('Add an agent key');
    const raw = button('Show raw output');
    expect(raw).toBeDefined();
    await act(async () => { raw!.click(); });
    expect(container.textContent).toContain('Not logged in · Please run /login');
    // Retry stays one click away.
    expect(button('Retry on Claude')).toBeDefined();
  });

  it('classifies from the full error when the excerpt is only its first line', async () => {
    stubFetch({ status: 200, body: {} });
    await mount({ phase: 'failed', lastError: { excerpt: '[mcp-sdk] warning…', raw: '[mcp-sdk] warning\nNot logged in · Please run /login' } });
    await flush();
    expect(container.textContent).toContain('no working model key');
  });

  it('any other failure still shows its excerpt as before', async () => {
    stubFetch({ status: 200, body: {} });
    await mount({ phase: 'failed', lastError: { excerpt: 'Tests failed: 3 of 12' } });
    await flush();
    expect(container.textContent).toContain('Tests failed: 3 of 12');
    expect(button('Show raw output')).toBeUndefined();
  });
});

describe('TaskActionZone — a failed task offers only a backend that can run it', () => {
  afterEach(() => { codexConfigured = false; });

  it('names the backend as a product: Retry on Claude', async () => {
    stubFetch({ status: 200, body: {} });
    await mount({ phase: 'failed', lastError: { excerpt: 'boom' } });
    await flush();
    expect(button('Retry on Claude')).toBeDefined();
    expect(button('Retry on claude')).toBeUndefined();
  });

  it('no Switch to Codex when Codex is not configured', async () => {
    codexConfigured = false;
    stubFetch({ status: 200, body: {} });
    await mount({ phase: 'failed', lastError: { excerpt: 'boom' } });
    await flush();
    expect(button('Switch to')).toBeUndefined();
    expect(container.querySelector('[data-action="switch_backend"]')).toBeNull();
  });

  it('offers Switch to Codex once Codex is configured', async () => {
    codexConfigured = true;
    stubFetch({ status: 200, body: {} });
    await mount({ phase: 'failed', lastError: { excerpt: 'boom' } });
    await flush();
    expect(button('Switch to Codex')).toBeDefined();
  });
});

describe('TaskActionZone — overrides carry through a chain of refusals', () => {
  // The start route checks the local-mission gate, then the workspace cap. Each
  // override clears one gate, so a start that needs both must send both.
  function stubTwoGates() {
    calls = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: u, body });
      if (u === '/api/workers/active') return { ok: true, status: 200, json: async () => ({ activeLocalUis: [] }) } as Response;
      if (!u.endsWith('/start')) return { ok: true, status: 200, json: async () => ({}) } as Response;
      const reply = !body?.capExempt
        ? { gateReason: 'workspace_cap_reached', canForce: true, blockClass: 'policy', canExempt: true, cap: 10, error: 'Workspace is full' }
        : !body?.forceOverride
          ? { gateReason: 'mission_local', canForce: true, blockClass: 'policy' }
          : null;
      return reply
        ? { ok: false, status: 422, json: async () => reply } as Response
        : { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
  }

  it('Start anyway, then Force start, sends both and the start lands', async () => {
    stubTwoGates();
    await mount({ missionExecutor: 'local' });
    await act(async () => { button('Run now')!.click(); });
    await flush();
    await act(async () => { button('Start anyway')!.click(); });
    await flush();
    expect(container.textContent).toContain('Running in a local session');
    await act(async () => { button('Force start')!.click(); });
    await flush();
    expect(startCalls().at(-1)!.body).toEqual({ forceOverride: true, capExempt: true });
    expect(container.querySelector('[data-testid="task-start-refusal"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-start-status"]')).not.toBeNull();
  });

  it('dismissing a refusal drops the overrides it collected', async () => {
    stubTwoGates();
    await mount({ missionExecutor: 'local' });
    await act(async () => { button('Run now')!.click(); });
    await flush();
    await act(async () => { button('Start anyway')!.click(); });
    await flush();
    await act(async () => { button('Cancel')!.click(); });
    await act(async () => { button('Run now')!.click(); });
    await flush();
    expect(startCalls().at(-1)!.body).toEqual({});
  });
});

describe('TaskActionZone — managed-runner plan limit', () => {
  const block = { kind: 'concurrency', key: 'managed_runner.concurrency', active: 3, limit: 3, scope: 'individual' } as const;

  it('a queued task held on a plan limit shows the entitlement state instead of Run now, and no error', async () => {
    stubFetch({ status: 200, body: {} });
    await mount({ entitlementBlock: block });
    const notice = container.querySelector('[data-testid="entitlement-blocked"]') as HTMLElement;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain('3 managed runs already active');
    expect(button('Run now')).toBeUndefined();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.innerHTML).not.toContain('status-error');
  });

  it('a start refused on a plan limit renders the same notice, not the gate warning, and Leave queued closes it', async () => {
    stubFetch({ status: 422, body: { gateReason: 'entitlement_blocked', blockClass: 'entitlement', canForce: false, entitlement: { ...block, limit: 10, active: 10, scope: 'team' }, error: 'Queued' } });
    await mount();
    await act(async () => { button('Run now')!.click(); });
    await flush();
    expect(container.querySelector('[data-testid="task-start-refusal"]')).toBeNull();
    const notice = container.querySelector('[data-testid="entitlement-blocked"]') as HTMLElement;
    expect(notice.textContent).toContain('10 managed runs already active');
    expect(button('Force start')).toBeUndefined();
    expect(container.innerHTML).not.toMatch(/status-error|status-warning/);
    await act(async () => { button('Leave queued')!.click(); });
    expect(container.querySelector('[data-testid="entitlement-blocked"]')).toBeNull();
    expect(button('Run now')).toBeDefined();
  });

  it('the workspace cap refusal is unchanged: an operational limit keeps its own controls', async () => {
    stubFetch({ status: 422, body: { gateReason: 'workspace_cap_reached', blockClass: 'policy', active: 3, cap: 3, canExempt: true } });
    await mount();
    await act(async () => { button('Run now')!.click(); });
    await flush();
    expect(container.querySelector('[data-testid="entitlement-blocked"]')).toBeNull();
    expect(container.querySelector('[data-gate="workspace_cap_reached"]')).not.toBeNull();
    expect(button('Save & start')).toBeDefined();
  });
});

describe('TaskActionZone — failure kind routes recovery', () => {
  const dupes = (text: string) => {
    const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
    return words.length - new Set(words).size;
  };

  it('a worker failure offers only execution recovery, under the worker-failure label', async () => {
    codexConfigured = true;
    stubFetch({ status: 200, body: {} });
    await mount({ phase: 'failed', failureKind: 'execution', lastError: { excerpt: 'Tests failed: 3 of 12' }, historyHref: '/h' });
    await flush();
    expect(container.textContent).toContain('Worker failed');
    expect(button('Retry on Claude')).toBeDefined();
    expect(button('Switch to Codex')).toBeDefined();
    expect(container.textContent).not.toContain('verification failed');
    expect(container.textContent).not.toMatch(/audit/i);
    expect(dupes(container.textContent ?? '')).toBeLessThan(6);
  });

  it('landed work with a failed audit offers no build recovery, and says verification failed', async () => {
    codexConfigured = true;
    stubFetch({ status: 200, body: {} });
    await mount({ phase: 'failed', failureKind: 'verification', lastError: { excerpt: 'audit exploded' }, historyHref: '/h' });
    await flush();
    const text = container.textContent ?? '';
    expect(text).toContain('Implementation complete, verification failed');
    expect(button('Retry')).toBeUndefined();
    expect(button('Switch to Codex')).toBeUndefined();
    expect(text).not.toContain('Retry on Claude');
    expect(text).not.toContain('Worker failed');
    expect(text.length).toBeLessThan(120);
    expect(dupes(text)).toBeLessThan(3);
  });

  it('a failed audit with landed work offers Retry the audit (reassign), never the build recovery', async () => {
    codexConfigured = true;
    stubFetch({ status: 200, body: {} });
    await mount({ phase: 'failed', failureKind: 'verification', auditTaskId: 't1', lastError: null, historyHref: '/h' });
    await flush();
    const text = container.textContent ?? '';
    expect(text).toContain('Implementation complete, verification failed');
    expect(button('Retry on Claude')).toBeUndefined();
    expect(button('Switch to Codex')).toBeUndefined();
    expect(text).not.toContain('Worker failed');
    expect(text).not.toContain('Skip this audit');
    await act(async () => { button('Retry the audit')!.click(); });
    await flush();
    expect(calls.some(c => c.url === '/api/tasks/t1/reassign?force=true')).toBe(true);
  });

  it('an execution failure never offers audit recovery', async () => {
    stubFetch({ status: 200, body: {} });
    await mount({ phase: 'failed', failureKind: 'execution', auditTaskId: null, lastError: { excerpt: 'boom' }, historyHref: '/h' });
    await flush();
    expect(button('Retry the audit')).toBeUndefined();
    expect(container.textContent).not.toContain('Skip this audit');
  });
});

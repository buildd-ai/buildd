/**
 * TaskActionZone mounted (happy-dom): the inline Force start that replaces a
 * refused "Run now" in the mission task sheet.
 *
 * - a bypassable 422 shows Force start, and pressing it posts forceOverride once;
 * - a refusal that cannot be forced (capability, canForce false)
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
const { getGateReasonSubtitle } = await import('@/lib/task-actions');
type GateRefusal = import('@/lib/task-actions').GateRefusal;

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

describe('TaskActionZone — Run now frame', () => {
  it('boxes Run now on its own, and drops the box inside a card that already frames the task', async () => {
    stubFetch({ status: 200, body: {} });
    await mount();
    expect(container.querySelector('[data-testid="task-run-now"]')!.className).toContain('border');
    await mount({ framed: false });
    const group = container.querySelector('[data-testid="task-run-now"]')!;
    expect(group.className).not.toContain('border');
    expect(button('Run now')).toBeDefined();
  });

  it('the Blocked notice drops its box the same way', async () => {
    stubFetch({ status: 200, body: {} });
    await mount({ isBlocked: true, blockedByCount: 1 });
    expect(container.querySelector('[data-testid="task-blocked"]')!.className).toContain('border');
    await mount({ isBlocked: true, blockedByCount: 1, framed: false });
    expect(container.querySelector('[data-testid="task-blocked"]')!.getAttribute('class')).toBeNull();
    expect(container.textContent).toContain('waiting on 1 dependency');
  });
});

describe('TaskActionZone — queued line names its subject', () => {
  it('a plain queued task keeps the plain line', async () => {
    stubFetch({ status: 200, body: {} });
    await mount();
    await flush();
    expect(container.textContent).toContain('Waiting for a runner to claim it.');
  });

  it('a queued row whose delivery is already moving says the NEXT RUN waits, not the delivery', async () => {
    stubFetch({ status: 200, body: {} });
    await mount({ deliveryReading: 'Approved · checking' });
    await flush();
    const text = container.textContent ?? '';
    expect(text).toContain('Approved · checking. The next run is waiting for a runner to claim it.');
    expect(text).not.toContain('Waiting for a runner to claim it.');
  });
});

describe('TaskActionZone — inline Force start', () => {
  it('a bypassable 422 offers Force start, and pressing it posts forceOverride exactly once', async () => {
    stubFetch({ status: 422, body: { gateReason: 'mission_local', canForce: true, blockClass: 'policy' } });
    await mount();
    await act(async () => { button('Run now')!.click(); });
    await flush();
    expect(container.textContent).toContain('Runs from your session');
    const force = button('Force start');
    expect(force).toBeDefined();
    await act(async () => { force!.click(); });
    await flush();
    const forced = startCalls().filter(c => (c.body as { forceOverride?: boolean })?.forceOverride === true);
    expect(forced).toHaveLength(1);
  });

  it.each([
    ['capability gate', { gateReason: 'capability_mismatch', canForce: true, blockClass: 'capability', error: 'No credential' }],
    ['not forceable', { gateReason: 'subject_dead', canForce: false, error: 'Subject closed' }],
  ])('%s shows one reason and no Force start', async (_name, body) => {
    stubFetch({ status: 422, body });
    await mount();
    await act(async () => { button('Run now')!.click(); });
    await flush();
    expect(button('Force start')).toBeUndefined();
    // The gate's own line, never the server's message beside it.
    expect(container.textContent).toContain(getGateReasonSubtitle(body as GateRefusal));
    if (body.gateReason !== 'subject_dead') expect(container.textContent).not.toContain(body.error as string);
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
    expect(button('Start task')).toBeDefined();
    expect(calls.some(c => c.url === '/api/workers/active')).toBe(false);
  });

  it('with no runner online the confirmation says so and carries the visual-auditor caveat', async () => {
    stubFetch({ status: 422, body: { gateReason: 'mission_held', canForce: true, blockClass: 'policy' } }, []);
    await mount({ roleSlug: 'visual-auditor' });
    await act(async () => { button('Run now')!.click(); });
    await flush();
    expect(container.textContent).toContain('No runner is online');
    expect(container.textContent).toContain('runner with a browser');
  });

  it('a task in a mission that has not started: one reason, Start task and Cancel, no internals', async () => {
    stubFetch({ status: 422, body: {
      gateReason: 'mission_held', missionStartState: 'not_started', canForce: true, blockClass: 'policy',
      error: 'Task is blocked: its mission is not started. Arm the mission or use forceOverride to bypass.',
    } }, [{ lastUpdated: new Date().toISOString(), workspaceIds: ['ws1'] }]);
    await mount();
    await act(async () => { button('Run now')!.click(); });
    await flush();
    const panel = container.querySelector('[data-testid="task-start-refusal"]')!;
    const text = panel.textContent!;
    expect(text).toContain('Mission not started');
    expect(text.split('Mission not started')).toHaveLength(2);
    expect(text).not.toMatch(/held|forceOverride|online|poll|last seen|approv/i);
    expect(button('Start task')).toBeDefined();
    expect(button('Cancel')).toBeDefined();
    expect(button('Force start')).toBeUndefined();
    await act(async () => { button('Start task')!.click(); });
    await flush();
    expect(startCalls().filter(c => (c.body as { forceOverride?: boolean })?.forceOverride === true)).toHaveLength(1);
  });
});

describe('TaskActionZone — no workspace concurrency cap controls', () => {
  // The workspace cap is gone: a refused start never offers to raise a limit,
  // start past one, or leave the task queued behind one.
  it('a refused start offers no cap stepper, no start-past-the-cap and no Leave queued', async () => {
    stubFetch({ status: 422, body: { gateReason: 'mission_local', canForce: true, blockClass: 'policy' } });
    await mount();
    await act(async () => { button('Run now')!.click(); });
    await flush();
    expect(container.querySelector('[data-action="raise_cap"]')).toBeNull();
    expect(container.querySelector('[data-action="cap_exempt"]')).toBeNull();
    expect(button('Save & start')).toBeUndefined();
    expect(button('Start anyway')).toBeUndefined();
    expect(button('Leave queued')).toBeUndefined();
    expect(container.textContent).not.toMatch(/workspace limit/i);
    expect(button('Cancel')).toBeDefined();
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
    const link = container.querySelector('a[href="/app/settings/models#agent-key"]');
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
  // A forced start can be refused again on a gate no force lifts; closing that
  // refusal must drop the override it collected.
  function stubTwoGates() {
    calls = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: u, body });
      if (u === '/api/workers/active') return { ok: true, status: 200, json: async () => ({ activeLocalUis: [] }) } as Response;
      if (!u.endsWith('/start')) return { ok: true, status: 200, json: async () => ({}) } as Response;
      const reply = !body?.forceOverride
        ? { gateReason: 'mission_local', canForce: true, blockClass: 'policy' }
        : { gateReason: 'subject_dead', canForce: false, error: 'Subject closed' };
      return { ok: false, status: 422, json: async () => reply } as Response;
    }) as unknown as typeof fetch;
  }

  it('dismissing a refusal drops the overrides it collected', async () => {
    stubTwoGates();
    await mount({ missionExecutor: 'local' });
    await act(async () => { button('Run now')!.click(); });
    await flush();
    await act(async () => { button('Force start')!.click(); });
    await flush();
    expect(startCalls().at(-1)!.body).toEqual({ forceOverride: true });
    await act(async () => { button('Close')!.click(); });
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
    expect(container.textContent).toContain('Agent failed');
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
    expect(text).not.toContain('Agent failed');
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
    expect(text).not.toContain('Agent failed');
    expect(text).not.toContain('Skip this audit');
    await act(async () => { button('Retry the audit')!.click(); });
    await flush();
    expect(calls.some(c => c.url === '/api/tasks/t1/reassign?force=true')).toBe(true);
  });

  it('an audit that never ran because its prerequisite failed offers no retry, only the failed task (072de598 AC-13)', async () => {
    // As the phone mission focus card mounts it: unframed, with the strip's Task link trailing.
    codexConfigured = true;
    stubFetch({ status: 200, body: {} });
    await mount({
      phase: 'failed', failureKind: 'dependency', framed: false, historyHref: '/h',
      taskTitle: '[surface audit] Kernel mission',
      waitingOn: { taskId: 'build-1', title: 'Make PR review decisions commit-scoped and truthful' },
      lastError: { excerpt: 'Blocked: dependency "Make PR review decisions commit-scoped and truthful" (build-1) failed' },
      trailing: <a href="/sheet">Task →</a>,
    });
    await flush();
    const zone = container.querySelector('[data-testid="task-action-zone"]')!;
    expect(zone.getAttribute('data-actions')).toBe('waiting_on_failed history');
    const text = container.textContent ?? '';
    expect(text).toContain('Waiting on failed work');
    expect(text).toContain('This starts once it completes.');
    for (const label of ['Retry on Claude', 'Switch to Codex', 'Retry the audit', 'Run now']) expect(button(label)).toBeUndefined();
    expect(text).not.toContain('Agent failed');
    expect(text).not.toContain('Skip this audit');
    const link = container.querySelector('[data-action="open_failed_dependency"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/app/tasks/build-1');
    // Nothing is fetched to offer a backend switch it will never show.
    expect(calls.some(c => c.url.endsWith('/backends'))).toBe(false);
    expect(calls.some(c => c.url.includes('/reassign'))).toBe(false);
  });

  it('a builder that never ran says it can run again once the failed task completes', async () => {
    stubFetch({ status: 200, body: {} });
    await mount({ phase: 'failed', failureKind: 'dependency', taskTitle: 'Second builder', waitingOn: { taskId: 'build-1', title: 'Build it' }, lastError: null });
    await flush();
    expect(container.textContent).toContain('It can run again once that task completes.');
    expect(button('Retry on Claude')).toBeUndefined();
  });

  it('an execution failure never offers audit recovery', async () => {
    stubFetch({ status: 200, body: {} });
    await mount({ phase: 'failed', failureKind: 'execution', auditTaskId: null, lastError: { excerpt: 'boom' }, historyHref: '/h' });
    await flush();
    expect(button('Retry the audit')).toBeUndefined();
    expect(container.textContent).not.toContain('Skip this audit');
  });
});

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

function stubFetch(startReply: { status: number; body: Record<string, unknown> }, fleet: unknown[] = []) {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u === '/api/workers/active') {
      return { ok: true, status: 200, json: async () => ({ activeLocalUis: fleet }) } as Response;
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

describe('TaskActionZone — a provider sign-in failure', () => {
  it('says what to do in plain words, links the credential setting, and folds the raw text', async () => {
    stubFetch({ status: 200, body: {} });
    await mount({ phase: 'failed', lastError: { excerpt: 'Not logged in · Please run /login' } });
    await flush();
    const zone = container.textContent ?? '';
    expect(zone).toContain('no working model key');
    expect(zone).not.toContain('Please run /login');
    const link = container.querySelector('a[href="/app/settings/runners#agent-backends"]');
    expect(link?.textContent).toBe('Add an agent key');
    const raw = button('Show raw output');
    expect(raw).toBeDefined();
    await act(async () => { raw!.click(); });
    expect(container.textContent).toContain('Not logged in · Please run /login');
    // Retry stays one click away.
    expect(button('Retry on claude')).toBeDefined();
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

/**
 * CloudRunnerDeploy: the Deploy button, workspace picker and step progress.
 * DOM tests — no network; fetch is mocked at the component level.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/runners', width: 1280, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: CloudRunnerDeploy } = await import('./CloudRunnerDeploy');

const TEAM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

type Caps = Record<string, { state: string }>;

function installFetch(opts: { workspaces?: Array<{ id: string; name: string }>; stepOk?: boolean; stepError?: string } = {}) {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.includes('/api/cloudflare/cloud-runner/deploy') && method === 'GET') {
      return new Response(JSON.stringify({ workspaces: opts.workspaces ?? [{ id: WS1, name: 'Alpha' }] }), { status: 200 });
    }
    if (url.includes('/api/cloudflare/cloud-runner/deploy') && method === 'POST') {
      if (opts.stepOk === false) {
        return new Response(JSON.stringify({ error: opts.stepError ?? 'test error', step: body?.step }), { status: 502 });
      }
      const steps = ['check', 'bucket', 'worker', 'containers', 'connect'];
      const idx = steps.indexOf(body?.step);
      const next = steps[idx + 1] ?? null;
      return new Response(JSON.stringify({
        ok: true, step: body?.step, next,
        detail: { release: 'v0.1.0', workerUrl: 'https://test.workers.dev', dispatchUrl: 'https://test.workers.dev/dispatch' },
      }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

async function mount(capabilities: Caps | null = null) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<CloudRunnerDeploy teamId={TEAM} capabilities={capabilities as any} />);
  });
  await flush();
}

describe('CloudRunnerDeploy', () => {
  it('loads workspaces and shows a picker + Deploy button', async () => {
    installFetch();
    await mount();
    expect(host.querySelector('[data-testid="cloud-deploy-btn"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Deploy workspace"]')).not.toBeNull();
  });

  it('renders nothing when the team has no workspaces', async () => {
    installFetch({ workspaces: [] });
    await mount();
    expect(host.querySelector('[data-testid="cloud-deploy"]')).toBeNull();
  });

  it('warns when the token lacks deploy permissions', async () => {
    installFetch();
    await mount({ containers: { state: 'not_allowed' }, workersScripts: { state: 'allowed' }, r2: { state: 'allowed' }, workersSubdomain: { state: 'allowed' } });
    const warn = host.querySelector('[data-testid="cloud-deploy-perms"]')!;
    expect(warn.textContent).toContain('Containers Edit');
    // The deploy button is disabled when permissions are missing.
    expect(host.querySelector<HTMLButtonElement>('[data-testid="cloud-deploy-btn"]')!.disabled).toBe(true);
  });

  it('runs all five steps and shows success', async () => {
    const calls = installFetch();
    await mount();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="cloud-deploy-btn"]')!.click(); });
    // Let all steps run.
    for (let i = 0; i < 10; i++) await flush();
    const steps = host.querySelector('[data-testid="cloud-deploy-steps"]')!;
    expect(steps.querySelectorAll('li').length).toBe(5);
    // All steps done: the URL appears.
    expect(host.querySelector('[data-testid="cloud-deploy-url"]')?.textContent).toContain('test.workers.dev');
    // Five POST calls were made.
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.length).toBe(5);
    expect(posts.map((c) => c.body?.step)).toEqual(['check', 'bucket', 'worker', 'containers', 'connect']);
  });

  it('shows the error and a Retry button on failure', async () => {
    installFetch({ stepOk: false, stepError: 'Bad gateway' });
    await mount();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="cloud-deploy-btn"]')!.click(); });
    for (let i = 0; i < 5; i++) await flush();
    expect(host.querySelector('[data-testid="cloud-deploy-error"]')?.textContent).toContain('Bad gateway');
    expect(host.querySelector('[data-testid="cloud-deploy-retry"]')).not.toBeNull();
  });

  it('Retry resumes at the failed step and does not re-request finished steps', async () => {
    const calls: Array<{ step: string; workspaceId: string }> = [];
    let failWorker = true;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return new Response(JSON.stringify({ workspaces: [{ id: WS1, name: 'Alpha' }] }), { status: 200 });
      }
      const body = JSON.parse(String(init!.body));
      calls.push(body);
      if (body.step === 'worker' && failWorker) {
        failWorker = false;
        return new Response(JSON.stringify({ error: 'Upload failed', step: 'worker' }), { status: 502 });
      }
      const steps = ['check', 'bucket', 'worker', 'containers', 'connect'];
      const next = steps[steps.indexOf(body.step) + 1] ?? null;
      return new Response(JSON.stringify({
        ok: true, step: body.step, next,
        detail: { workerUrl: 'https://test.workers.dev', ...(body.step === 'bucket' ? { notes: ['bucket note'] } : {}) },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="cloud-deploy-btn"]')!.click(); });
    for (let i = 0; i < 10; i++) await flush();
    expect(calls.map((c) => c.step)).toEqual(['check', 'bucket', 'worker']);
    expect(host.querySelector('[data-testid="cloud-deploy-error"]')?.textContent).toContain('Upload failed');

    calls.length = 0;
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="cloud-deploy-retry"]')!.click(); });
    // While the retry is in flight, the finished steps already read as done.
    const items = [...host.querySelectorAll('[data-testid="cloud-deploy-steps"] li')].map((li) => li.textContent);
    expect(items[0]).toStartWith('✓');
    expect(items[1]).toStartWith('✓');
    for (let i = 0; i < 10; i++) await flush();

    expect(calls.map((c) => c.step)).toEqual(['worker', 'containers', 'connect']);
    expect(calls.every((c) => c.workspaceId === WS1)).toBe(true);
    expect(host.querySelector('[data-testid="cloud-deploy-url"]')?.textContent).toContain('test.workers.dev');
    // Notes from the steps that finished before the failure survive the resume.
    expect(host.textContent).toContain('bucket note');
  });

  it('Retry resumes at the failed step when its request throws', async () => {
    const calls: Array<{ step: string; workspaceId: string }> = [];
    let failContainers = true;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return new Response(JSON.stringify({ workspaces: [{ id: WS1, name: 'Alpha' }] }), { status: 200 });
      }
      const body = JSON.parse(String(init!.body));
      calls.push(body);
      if (body.step === 'containers' && failContainers) {
        failContainers = false;
        throw new TypeError('Network request failed');
      }
      const steps = ['check', 'bucket', 'worker', 'containers', 'connect'];
      const next = steps[steps.indexOf(body.step) + 1] ?? null;
      return new Response(JSON.stringify({
        ok: true, step: body.step, next, detail: { workerUrl: 'https://test.workers.dev' },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="cloud-deploy-btn"]')!.click(); });
    for (let i = 0; i < 10; i++) await flush();
    expect(calls.map((c) => c.step)).toEqual(['check', 'bucket', 'worker', 'containers']);
    expect(host.querySelector('[data-testid="cloud-deploy-error"]')?.textContent).toContain('Network request failed');

    calls.length = 0;
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="cloud-deploy-retry"]')!.click(); });
    for (let i = 0; i < 10; i++) await flush();

    expect(calls.map((c) => c.step)).toEqual(['containers', 'connect']);
    expect(host.querySelector('[data-testid="cloud-deploy-url"]')?.textContent).toContain('test.workers.dev');
  });

  it('no credential value in any step request or response', async () => {
    const calls = installFetch();
    await mount();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="cloud-deploy-btn"]')!.click(); });
    for (let i = 0; i < 10; i++) await flush();
    const allText = JSON.stringify(calls);
    expect(allText).not.toContain('apiToken');
    expect(allText).not.toContain('DISPATCH_TOKEN');
    expect(allText).not.toContain('bld_');
  });
});

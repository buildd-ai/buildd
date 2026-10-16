/**
 * Settings spec R-4 / AC-3 / AC-4: each part of the git form saves on its own
 * (the config route's `group`), Save works only with changes, and closing the
 * tab with unsaved changes asks first.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/workspace/ws-1', width: 1280, height: 900 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { GitConfigForm } = await import('./GitConfigForm');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof mock>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = mock(async () => new Response('{}', { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

const config = {
  defaultBranch: 'dev', branchingStrategy: 'feature', branchPrefix: 'feat/', commitStyle: 'freeform',
  requiresPR: true, autoCreatePR: true, useClaudeMd: true, fallbackModel: 'standard', debugFile: '/tmp/a.log',
};

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const save = () => [...host.querySelectorAll('button[type="submit"]')][0] as HTMLButtonElement;
const leaveAsks = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

describe('GitConfigForm save', () => {
  it('Repository: Save turns on with a change, sends only its group, and is clean after', async () => {
    act(() => root.render(<GitConfigForm part="repository" workspaceId="ws-1" workspaceName="ws" initialConfig={config as never} canEdit />));
    expect(save().disabled).toBe(true);
    expect(leaveAsks()).toBe(false);

    const prefix = host.querySelector('input[placeholder="feature/"]') as HTMLInputElement;
    act(() => type(prefix, 'work/'));
    expect(save().disabled).toBe(false);
    expect(leaveAsks()).toBe(true);

    await act(async () => { save().click(); });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.group).toBe('repository');
    expect(body.branchPrefix).toBe('work/');
    for (const key of ['fallbackModel', 'debugFile', 'agentInstructions', 'sandbox', 'effort']) {
      expect(key in body).toBe(false);
    }
    expect(save().disabled).toBe(true);
    expect(leaveAsks()).toBe(false);
  });

  it('Agents: sends only its group', async () => {
    act(() => root.render(<GitConfigForm part="agents" workspaceId="ws-1" workspaceName="ws" initialConfig={config as never} canEdit />));
    const fallback = host.querySelector('input[placeholder="A tier or a model name"]') as HTMLInputElement;
    act(() => type(fallback, 'budget'));
    await act(async () => { save().click(); });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.group).toBe('agents');
    expect(body.fallbackModel).toBe('budget');
    expect(body.debugFile).toBe('/tmp/a.log');
    for (const key of ['defaultBranch', 'branchPrefix', 'commitStyle', 'requiresPR']) {
      expect(key in body).toBe(false);
    }
  });

  it('a failed save stays dirty', async () => {
    fetchMock = mock(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    act(() => root.render(<GitConfigForm part="repository" workspaceId="ws-1" workspaceName="ws" initialConfig={config as never} canEdit />));
    act(() => type(host.querySelector('input[placeholder="feature/"]') as HTMLInputElement, 'work/'));
    await act(async () => { save().click(); });
    expect(host.textContent).toContain('nope');
    expect(save().disabled).toBe(false);
    expect(leaveAsks()).toBe(true);
  });
});

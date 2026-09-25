/**
 * Both role editors wire the phone-only MobileSaveBar to their own save
 * handler: tapping it PATCHes the role, a failed save shows its error inside
 * the bar (the page-level error is off-screen at the top), and a successful
 * save acknowledges itself there.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals and
 * module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/team/builder/settings' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/team/builder/settings',
  useSearchParams: () => new URLSearchParams(''),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TeamRoleEditor } = await import('./TeamRoleEditor');
const { RoleEditor } = await import('../../../workspaces/[id]/skills/[skillId]/RoleEditor');

// Illustrative fixtures only.
const role = {
  id: 'role-1', teamId: 'team-1', workspaceId: null, slug: 'builder', name: 'Builder',
  description: null, content: 'You build.', model: 'inherit', defaultBackend: null,
  allowedTools: [], canDelegateTo: [], background: false, maxTurns: null, color: '#D4724A',
  mcpServers: [], requiredEnvVars: {}, isRole: true, repoUrl: null,
};
const skill = {
  id: 'skill-1', slug: 'builder', teamId: 'team-1', workspaceId: 'ws-1', name: 'Builder',
  description: null, content: 'You build.', model: 'inherit', defaultBackend: null,
  allowedTools: [], canDelegateTo: [], background: false, maxTurns: null, color: '#D4724A',
  connectorRefs: [], isRole: true, repoUrl: null, createdAt: '2026-01-01T00:00:00.000Z',
};

type Call = [string, RequestInit | undefined];
let calls: Call[];
let saveResponse: () => Response;
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  saveResponse = () => new Response(JSON.stringify({ skill: role }), { status: 200 });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push([String(url), init]);
    if (init?.method === 'PATCH') return saveResponse();
    return new Response(JSON.stringify({ connectors: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

const bar = () => container.querySelector<HTMLElement>('[data-testid="mobile-save-bar"]')!;
const tap = () => act(async () => { bar().querySelector('button')!.click(); });
const patches = () => calls.filter(([, init]) => init?.method === 'PATCH');

const editors = [
  {
    name: 'TeamRoleEditor',
    render: () => <TeamRoleEditor role={role as any} overrides={[]} workspaces={[]} delegateOptions={[]} />,
    url: '/api/roles/role-1',
  },
  {
    name: 'RoleEditor',
    render: () => <RoleEditor workspaceId="ws-1" workspaceName="Example WS" skill={skill as any} delegateOptions={[]} workspaces={[]} />,
    url: '/api/workspaces/ws-1/skills/skill-1',
  },
];

for (const e of editors) {
  describe(`${e.name} mobile save bar`, () => {
    it('is labelled as saving the role', async () => {
      await act(async () => root.render(e.render()));
      expect(bar()).toBeTruthy();
      expect(bar().querySelector('button')!.textContent).toBe('Save role');
    });

    it('tapping it PATCHes this role and acknowledges success', async () => {
      await act(async () => root.render(e.render()));
      await tap();
      expect(patches().map(([url]) => url)).toEqual([e.url]);
      expect(bar().textContent).toContain('Saved');
    });

    it('a failed save shows its error inside the bar', async () => {
      saveResponse = () => new Response(JSON.stringify({ error: 'Example failure' }), { status: 400 });
      await act(async () => root.render(e.render()));
      await tap();
      expect(bar().querySelector('[role="alert"]')?.textContent).toBe('Example failure');
    });
  });
}

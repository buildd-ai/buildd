/**
 * Both role editors wire the phone-only MobileSaveBar to their own save
 * handler: tapping it PATCHes the role, a failed save shows its error inside
 * the bar (the page-level error is off-screen at the top), and a successful
 * save acknowledges itself there.
 *
 * Dirty tracking: the bar only appears once the form differs from the last
 * save, the desktop header button is disabled while clean, a save resets the
 * baseline, reverting an edit by hand is clean again, and tab close/reload is
 * guarded by beforeunload only while dirty.
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
  allowedTools: ['Read', 'Bash'], canDelegateTo: [], background: false, maxTurns: null, color: '#D4724A',
  mcpServers: [], requiredEnvVars: {}, isRole: true, repoUrl: null,
};
const skill = {
  id: 'skill-1', slug: 'builder', teamId: 'team-1', workspaceId: 'ws-1', name: 'Builder',
  description: null, content: 'You build.', model: 'inherit', defaultBackend: null,
  allowedTools: ['Read', 'Bash'], canDelegateTo: [], background: false, maxTurns: null, color: '#D4724A',
  connectorRefs: [], isRole: true, repoUrl: null, createdAt: '2026-01-01T00:00:00.000Z',
};

type Call = [string, RequestInit | undefined];
let calls: Call[];
let saveResponse: (body: Record<string, unknown>) => Response | Promise<Response>;
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  // Default: the server stores what it was sent and echoes the row back.
  saveResponse = (body) => new Response(JSON.stringify({ skill: { ...role, ...skill, ...body } }), { status: 200 });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push([String(url), init]);
    if (init?.method === 'PATCH') return saveResponse(JSON.parse(String(init.body)));
    if (init?.method === 'POST' && String(url).endsWith('/overrides')) {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ skill: { ...role, id: 'override-1', ...body } }), { status: 200 });
    }
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

const q = <T extends HTMLElement = HTMLElement>(sel: string) => container.querySelector<T>(sel);
const bar = () => q('[data-testid="mobile-save-bar"]');
const barButton = () => bar()!.querySelector('button')!;
const headerSave = () => q<HTMLButtonElement>('[data-testid="header-save"]')!;
const tap = () => act(async () => { barButton().click(); });
const patches = () => calls.filter(([, init]) => init?.method === 'PATCH');
const nameInput = () => q<HTMLInputElement>('input[type="text"]')!;
const toolButton = (tool: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('details button')].find(b => b.textContent === tool)!;
const click = (el: HTMLElement) => act(() => { el.click(); });

function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** True when a beforeunload listener asked the browser to confirm leaving. */
function unloadIsGuarded() {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

const editors = [
  {
    name: 'TeamRoleEditor',
    render: () => <TeamRoleEditor role={role as any} overrides={[]} workspaces={[]} delegateOptions={[]} />,
    renderWith: (o: object) => <TeamRoleEditor role={{ ...role, ...o } as any} overrides={[]} workspaces={[]} delegateOptions={[]} />,
    url: '/api/roles/role-1',
  },
  {
    name: 'RoleEditor',
    render: () => <RoleEditor workspaceId="ws-1" workspaceName="Example WS" skill={skill as any} delegateOptions={[]} workspaces={[]} />,
    renderWith: (o: object) => <RoleEditor workspaceId="ws-1" workspaceName="Example WS" skill={{ ...skill, ...o } as any} delegateOptions={[]} workspaces={[]} />,
    url: '/api/workspaces/ws-1/skills/skill-1',
  },
];

for (const e of editors) {
  describe(`${e.name} unsaved-changes state`, () => {
    it('is clean on load: no mobile bar, desktop save disabled, no unload guard', async () => {
      await act(async () => root.render(e.render()));
      expect(bar()).toBeNull();
      expect(headerSave().disabled).toBe(true);
      expect(q('[data-testid="header-save-dirty"]')).toBeNull();
      expect(unloadIsGuarded()).toBe(false);
    });

    it('a legacy model alias normalised by ModelPicker on mount is still clean', async () => {
      await act(async () => root.render(e.renderWith({ model: 'sonnet' })));
      expect(bar()).toBeNull();
      expect(headerSave().disabled).toBe(true);
    });

    it('an edit makes it dirty: bar says Unsaved changes, both saves enabled, unload guarded', async () => {
      await act(async () => root.render(e.render()));
      type(nameInput(), 'Builder 2');
      expect(bar()!.textContent).toContain('Unsaved changes');
      expect(barButton().disabled).toBe(false);
      expect(barButton().textContent).toBe('Save role');
      expect(headerSave().disabled).toBe(false);
      expect(q('[data-testid="header-save-dirty"]')).toBeTruthy();
      expect(unloadIsGuarded()).toBe(true);
    });

    it('reverting the edit by hand is clean again', async () => {
      await act(async () => root.render(e.render()));
      type(nameInput(), 'Builder 2');
      type(nameInput(), 'Builder');
      expect(bar()).toBeNull();
      expect(headerSave().disabled).toBe(true);
      expect(unloadIsGuarded()).toBe(false);
    });

    it('a whitespace-only edit counts as a change (saved verbatim)', async () => {
      await act(async () => root.render(e.render()));
      type(nameInput(), 'Builder ');
      expect(bar()).toBeTruthy();
    });

    it('re-toggling a tool in a different order is clean', async () => {
      await act(async () => root.render(e.render()));
      click(toolButton('Read')); // ['Bash']
      expect(bar()).toBeTruthy();
      click(toolButton('Read')); // ['Bash', 'Read'] — same set as saved
      expect(bar()).toBeNull();
    });

    it('picking another avatar colour is dirty; picking the original back is clean', async () => {
      await act(async () => root.render(e.render()));
      const swatches = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="color-swatch"]')];
      click(swatches[1]);
      expect(bar()).toBeTruthy();
      click(swatches[0]);
      expect(bar()).toBeNull();
    });

    it('tapping it PATCHes this role, acknowledges success, and is clean afterwards', async () => {
      await act(async () => root.render(e.render()));
      type(nameInput(), 'Builder 2');
      await tap();
      expect(patches().map(([url]) => url)).toEqual([e.url]);
      expect(JSON.parse(String(patches()[0][1]!.body)).name).toBe('Builder 2');
      expect(bar()!.textContent).toContain('Saved');
      expect(bar()!.textContent).not.toContain('Unsaved changes');
      expect(barButton().disabled).toBe(true);
      expect(headerSave().disabled).toBe(true);
      expect(unloadIsGuarded()).toBe(false);
      // The saved value is the new baseline: going back to the old name is a change.
      type(nameInput(), 'Builder');
      expect(bar()!.textContent).toContain('Unsaved changes');
    });

    it('an edit typed while the save is in flight stays dirty', async () => {
      let release!: () => void;
      saveResponse = (body) => new Promise<Response>(resolve => {
        release = () => resolve(new Response(JSON.stringify({ skill: { ...role, ...skill, ...body } }), { status: 200 }));
      });
      await act(async () => root.render(e.render()));
      type(nameInput(), 'Builder 2');
      await tap(); // request now pending
      type(nameInput(), 'Builder 3');
      await act(async () => { release(); await new Promise(r => setTimeout(r, 0)); });
      expect(JSON.parse(String(patches()[0][1]!.body)).name).toBe('Builder 2');
      expect(bar()!.textContent).toContain('Unsaved changes');
      expect(headerSave().disabled).toBe(false);
      expect(unloadIsGuarded()).toBe(true);
    });

    it('a field the server did not store stays dirty after "success"', async () => {
      // Server ignores the rename and echoes the old row.
      saveResponse = () => new Response(JSON.stringify({ skill: { ...role, ...skill } }), { status: 200 });
      await act(async () => root.render(e.render()));
      type(nameInput(), 'Builder 2');
      await tap();
      expect(bar()!.textContent).toContain('Unsaved changes');
      expect(headerSave().disabled).toBe(false);
    });

    it('falls back to the submitted payload when the response has no row', async () => {
      saveResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
      await act(async () => root.render(e.render()));
      type(nameInput(), 'Builder 2');
      await tap();
      expect(bar()!.textContent).not.toContain('Unsaved changes');
      expect(headerSave().disabled).toBe(true);
    });

    it('a failed save shows its error inside the bar and stays dirty', async () => {
      saveResponse = () => new Response(JSON.stringify({ error: 'Example failure' }), { status: 400 });
      await act(async () => root.render(e.render()));
      type(nameInput(), 'Builder 2');
      await tap();
      expect(bar()!.querySelector('[role="alert"]')?.textContent).toBe('Example failure');
      expect(bar()!.textContent).toContain('Unsaved changes');
      expect(barButton().disabled).toBe(false);
      expect(unloadIsGuarded()).toBe(true);
    });

    it('colour swatches get a 44px mobile hit area without growing the dot', async () => {
      await act(async () => root.render(e.render()));
      const swatch = q('[data-testid="color-swatch"]')!;
      expect(swatch.className).toContain('w-7 h-7');
      // First swatch is the selected one: (28 + 2×6) × scale-110 = 44.
      expect(swatch.getAttribute('aria-pressed')).toBe('true');
      expect(swatch.className).toContain('before:-inset-1.5');
      expect(swatch.className).toContain('md:before:hidden');
      expect(swatch.parentElement!.className).toContain('gap-4'); // 28 + 16 = 44 pitch
    });
  });
}

describe('TeamRoleEditor workspace overrides', () => {
  const override = { ...role, id: 'override-1', workspaceId: 'ws-1' };
  const render = () => (
    <TeamRoleEditor role={role as any} overrides={[override as any]} workspaces={[{ id: 'ws-1', name: 'Example WS' }]} delegateOptions={[]} />
  );

  it('editing an override does not make the role dirty', async () => {
    await act(async () => root.render(render()));
    const header = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Example WS') && b.textContent.includes('inherited'))!;
    click(header);
    const overrideBtns = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent === 'Override');
    click(overrideBtns[overrideBtns.length - 1]); // Instructions → Override
    const textareas = container.querySelectorAll<HTMLTextAreaElement>('textarea');
    type(textareas[textareas.length - 1], 'Workspace-specific instructions');
    expect(bar()).toBeNull();
    expect(headerSave().disabled).toBe(true);
  });

  it('saving an override posts to the overrides route, not the role, and leaves the role clean', async () => {
    await act(async () => root.render(render()));
    const header = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Example WS') && b.textContent.includes('inherited'))!;
    click(header);
    const overrideBtns = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent === 'Override');
    click(overrideBtns[overrideBtns.length - 1]);
    const textareas = container.querySelectorAll<HTMLTextAreaElement>('textarea');
    type(textareas[textareas.length - 1], 'Workspace-specific instructions');
    const saveOverride = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Save override')!;
    await act(async () => { saveOverride.click(); });
    const posts = calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([url]) => url)).toEqual(['/api/roles/role-1/overrides']);
    expect(JSON.parse(String(posts[0][1]!.body))).toMatchObject({ workspaceId: 'ws-1', content: 'Workspace-specific instructions' });
    expect(patches()).toEqual([]);
    expect(bar()).toBeNull();
  });
});

describe('scope changes count as unsaved changes', () => {
  const byText = (t: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === t)!;

  it('TeamRoleEditor: choosing "One workspace" enables Save; choosing back is clean', async () => {
    await act(async () => root.render(
      <TeamRoleEditor role={role as any} overrides={[]} workspaces={[{ id: 'ws-1', name: 'Example WS' }]} delegateOptions={[]} />,
    ));
    expect(headerSave().disabled).toBe(true);
    click(byText('One workspace'));
    expect(headerSave().disabled).toBe(false);
    expect(bar()!.textContent).toContain('Unsaved changes');
    click(byText('All workspaces in team'));
    expect(headerSave().disabled).toBe(true);
    expect(bar()).toBeNull();
  });

  it('RoleEditor: promoting to "This team" enables Save; choosing back is clean', async () => {
    await act(async () => root.render(
      <RoleEditor workspaceId="ws-1" workspaceName="Example WS" skill={skill as any} delegateOptions={[]} workspaces={[]} />,
    ));
    expect(headerSave().disabled).toBe(true);
    click(byText('This team'));
    expect(headerSave().disabled).toBe(false);
    expect(bar()!.textContent).toContain('Unsaved changes');
    click(byText('One workspace'));
    expect(headerSave().disabled).toBe(true);
    expect(bar()).toBeNull();
  });
});

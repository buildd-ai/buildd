/**
 * Personal roles in the dashboard: the New Role form's "Just for me" option
 * posts { personal: true } to /api/roles, and the role editor in personal mode
 * drops workspace scope, overrides and operator access (the API refuses them)
 * for a share toggle whose 409 message shows inline, plus "Make team role"
 * for an admin on a shared role.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals and
 * module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/roles/new' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pushes: string[] = [];
mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: (href: string) => { pushes.push(href); }, replace: () => {} }),
  usePathname: () => '/app/settings/roles/new',
  useSearchParams: () => new URLSearchParams(''),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TeamRoleForm } = await import('./new/TeamRoleForm');
const { TeamRoleEditor } = await import('./[slug]/edit/TeamRoleEditor');

// Illustrative fixtures only.
const role = {
  id: 'role-p1', teamId: 'team-1', workspaceId: null, slug: 'my-reviewer', name: 'My Reviewer',
  description: null, content: 'You review.', model: 'inherit', defaultBackend: null,
  allowedTools: [], canDelegateTo: [], background: false, maxTurns: null, color: '#0C72CB',
  mcpServers: {}, requiredEnvVars: {}, isRole: true, repoUrl: null, metadata: null,
};
const workspaces = [{ id: 'ws-1', name: 'billing-web' }];

type Call = [string, RequestInit | undefined];
let calls: Call[];
let respond: (url: string, init?: RequestInit) => Response;
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  pushes.length = 0;
  respond = (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return new Response(JSON.stringify({ skill: { ...role, ...body } }), { status: 200 });
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push([String(url), init]);
    return respond(String(url), init);
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
const byText = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text);
const posts = (suffix: string) => calls.filter(([url, init]) => init?.method === 'POST' && url.endsWith(suffix));

function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function fillAndSubmit() {
  type(q<HTMLInputElement>('input[type="text"]')!, 'My Reviewer');
  type(q<HTMLTextAreaElement>('textarea')!, 'You review.');
  await act(async () => {
    q<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('TeamRoleForm "Just for me"', () => {
  it('an admin picks Just for me: posts personal: true with the team id, and the workspace scope goes away', async () => {
    await act(async () => root.render(
      <TeamRoleForm teamId="team-1" workspaces={workspaces} kinds={['personal', 'team']} initialKind="team" />,
    ));
    expect(q('[data-testid="role-kind-picker"]')).not.toBeNull();
    expect(byText('All workspaces in team')).toBeDefined();

    await act(async () => { byText('Just for me')!.click(); });
    expect(byText('All workspaces in team')).toBeUndefined();
    expect(byText('One workspace')).toBeUndefined();

    await fillAndSubmit();
    const sent = posts('/api/roles');
    expect(sent).toHaveLength(1);
    const body = JSON.parse(String(sent[0][1]!.body));
    expect(body.personal).toBe(true);
    expect(body.teamId).toBe('team-1');
    expect(body.name).toBe('My Reviewer');
    expect(pushes).toContain('/app/settings/roles');
  });

  it('a team role from the same form does not carry personal', async () => {
    await act(async () => root.render(
      <TeamRoleForm teamId="team-1" workspaces={workspaces} kinds={['personal', 'team']} initialKind="team" />,
    ));
    await fillAndSubmit();
    const body = JSON.parse(String(posts('/api/roles')[0][1]!.body));
    expect(body.personal).toBeUndefined();
  });

  it('a member who may only create personal roles gets no picker and no workspace scope', async () => {
    await act(async () => root.render(
      <TeamRoleForm teamId="team-1" workspaces={[]} kinds={['personal']} initialKind="personal" />,
    ));
    expect(q('[data-testid="role-kind-picker"]')).toBeNull();
    expect(q('[data-testid="role-kind-personal-note"]')).not.toBeNull();
    expect(byText('All workspaces in team')).toBeUndefined();
    await fillAndSubmit();
    expect(JSON.parse(String(posts('/api/roles')[0][1]!.body)).personal).toBe(true);
  });

  it('shows the server\'s refusal inline', async () => {
    respond = () => new Response(JSON.stringify({ error: 'You already have a personal role with slug "my-reviewer"' }), { status: 409 });
    await act(async () => root.render(
      <TeamRoleForm teamId="team-1" workspaces={[]} kinds={['personal']} initialKind="personal" />,
    ));
    await fillAndSubmit();
    expect(container.textContent).toContain('You already have a personal role with slug "my-reviewer"');
    expect(pushes).toEqual([]);
  });
});

/** A radio in the share choice by its label. */
const shareRadio = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[data-testid="personal-role-sharing"] [role="radio"]')]
    .find(b => b.textContent === label);

const personal = (o: Partial<{ visibility: 'private' | 'team'; isOwner: boolean; ownerName: string | null; canShare: boolean; canPromote: boolean }> = {}) => ({
  visibility: 'private' as const, isOwner: true, ownerName: null, canShare: true, canPromote: false, ...o,
});

describe('TeamRoleEditor for a personal role', () => {
  it('hides workspace scope, overrides and operator access; shows the share toggle', async () => {
    await act(async () => root.render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <TeamRoleEditor role={{ ...role, slug: 'operator' } as any} overrides={[]} workspaces={workspaces} delegateOptions={[]} personal={personal()} />,
    ));
    expect(q('[data-testid="personal-role-sharing"]')).not.toBeNull();
    expect(byText('All workspaces in team')).toBeUndefined();
    expect(container.textContent).not.toContain('Workspace overrides');
    expect(container.textContent).not.toContain('Platform Operator');
    expect(container.textContent).not.toContain('Secret management');
  });

  it('the owner shares it: posts visibility team', async () => {
    await act(async () => root.render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <TeamRoleEditor role={role as any} overrides={[]} workspaces={[]} delegateOptions={[]} personal={personal()} />,
    ));
    await act(async () => { shareRadio('Whole team')!.click(); });
    const sent = posts('/api/roles/role-p1/share');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0][1]!.body))).toEqual({ visibility: 'team' });
    expect(shareRadio('Whole team')!.getAttribute('aria-checked')).toBe('true');
  });

  it('a 409 slug clash shows the server message inline and leaves it private', async () => {
    const message = 'The team already has a team role with slug "my-reviewer". Rename this role before sharing it.';
    respond = () => new Response(JSON.stringify({ error: message, conflictingRoleId: 'x' }), { status: 409 });
    await act(async () => root.render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <TeamRoleEditor role={role as any} overrides={[]} workspaces={[]} delegateOptions={[]} personal={personal()} />,
    ));
    await act(async () => { shareRadio('Whole team')!.click(); });
    expect(q('[data-testid="personal-share-error"]')!.textContent).toBe(message);
    expect(shareRadio('Only me')!.getAttribute('aria-checked')).toBe('true');
  });

  it('Make team role shows only for an admin on a shared role', async () => {
    await act(async () => root.render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <TeamRoleEditor role={role as any} overrides={[]} workspaces={[]} delegateOptions={[]} personal={personal({ canPromote: false })} />,
    ));
    expect(q('[data-testid="personal-role-promote"]')).toBeNull();

    await act(async () => root.render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <TeamRoleEditor key="shared" role={role as any} overrides={[]} workspaces={[]} delegateOptions={[]}
        personal={personal({ visibility: "team", isOwner: false, ownerName: "Ada", canPromote: true })} />,
    ));
    expect(q('[data-testid="personal-role-promote"]')).not.toBeNull();
    expect(container.textContent).toContain('by Ada');
  });

  it('a teammate without rights reads it: the share choice as text, form disabled', async () => {
    await act(async () => root.render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <TeamRoleEditor role={role as any} overrides={[]} workspaces={[]} delegateOptions={[]} canEdit={false}
        personal={personal({ visibility: 'team', isOwner: false, ownerName: 'Ada', canShare: false })} />,
    ));
    // No toggle they cannot use: the current choice reads as a line.
    expect(q('[data-testid="personal-role-sharing"] [role="radio"]')).toBeNull();
    expect(q('[data-testid="personal-share-fixed"]')!.textContent).toBe('Whole team');
    expect(q('[data-testid="role-read-only"]')!.textContent).toContain('owner or a team admin');
    expect(container.textContent).not.toContain('Delete this role');
  });
});

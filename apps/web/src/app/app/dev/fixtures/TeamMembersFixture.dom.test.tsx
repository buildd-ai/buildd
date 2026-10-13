/**
 * The team-members fixture renders the gated member controls the visual
 * audit needs: owner sees role selects, Transfer ownership, Remove and the
 * last-owner note; admin manages members but not the owner; member sees badges.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/dev/fixtures' });

import { afterAll, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TeamDetailClient } = await import('../../(protected)/settings/team/TeamDetailClient');
const { teamMembersFixtureProps } = await import('./team-members-fixtures');

describe('team-members fixture controls', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  afterAll(() => act(() => root.unmount()));

  async function renderAs(viewer: 'owner' | 'admin' | 'member') {
    await act(async () => { root.render(<TeamDetailClient key={viewer} {...teamMembersFixtureProps(viewer)} />); });
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
    return {
      selects: [...container.querySelectorAll('[role="combobox"]')].map((s) => s.getAttribute('aria-label')),
      count: (label: string) => buttons.filter((b) => b === label).length,
      leave: [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Leave team') as HTMLButtonElement,
      text: container.textContent ?? '',
    };
  }

  it('owner: every control, and the last-owner gate on Leave', async () => {
    const v = await renderAs('owner');
    expect(v.selects).toEqual(['Role for Adrian Admin', 'Role for member@example.com']);
    expect(v.count('Transfer ownership')).toBe(2);
    expect(v.count('Remove')).toBe(2);
    expect(v.count('Delete team')).toBe(1);
    expect(v.count('+ Invite someone')).toBe(1);
    expect(v.leave.disabled).toBe(true);
    expect(v.text).toContain('You are the only owner.');
  });

  it('owner: member controls stack under the identity on phones with 44px targets', async () => {
    await renderAs('owner');
    const groups = [...container.querySelectorAll('[data-testid="member-controls"]')];
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      const cls = g.className.split(/\s+/);
      // Right-pinning only from md up; on a phone the group sits on its own line.
      expect(cls).not.toContain('ml-auto');
      expect(cls).not.toContain('justify-end');
      expect(g.parentElement!.className.split(/\s+/)).toContain('flex-col');
    }
    const actions = [...container.querySelectorAll('button')].filter((b) =>
      ['Transfer ownership', 'Remove'].includes(b.textContent?.trim() ?? ''),
    );
    expect(actions.length).toBe(4);
    for (const b of actions) {
      const cls = b.className.split(/\s+/);
      expect(cls).toContain('min-h-11');
      expect(cls).toContain('px-3');
    }
  });

  it('admin: manages the member, not the owner', async () => {
    const v = await renderAs('admin');
    expect(v.selects).toEqual(['Role for member@example.com']);
    expect(v.count('Transfer ownership')).toBe(0);
    expect(v.count('Remove')).toBe(1);
    expect(v.count('Delete team')).toBe(0);
    expect(v.count('Rename')).toBe(1);
    expect(v.count('+ Invite someone')).toBe(1);
    expect(v.leave.disabled).toBe(false);
  });

  it('member: badges only', async () => {
    const v = await renderAs('member');
    expect(v.selects).toEqual([]);
    expect(v.count('Transfer ownership')).toBe(0);
    expect(v.count('Remove')).toBe(0);
    expect(v.count('Rename')).toBe(0);
    expect(v.count('+ Invite someone')).toBe(0);
    expect(v.leave.disabled).toBe(false);
  });
});

// Settings spec R-10 / AC-11: a personal team's slug is an internal id, so it is
// shown (and editable) only for a shared team.
describe('team slug', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  afterAll(() => act(() => root.unmount()));

  async function renderTeam(isPersonal: boolean) {
    const props = teamMembersFixtureProps('owner');
    const team = { ...props.team, slug: isPersonal ? 'personal-0000' : props.team.slug };
    await act(async () => { root.render(<TeamDetailClient key={String(isPersonal)} {...props} team={team} isPersonal={isPersonal} />); });
    return container.textContent ?? '';
  }

  it('is hidden for a personal team, including when renaming', async () => {
    expect(await renderTeam(true)).not.toContain('personal-0000');
    const rename = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Rename') as HTMLButtonElement;
    await act(async () => { rename.click(); });
    expect(container.querySelector('#team-slug')).toBeNull();
    expect(container.querySelector('#team-name')).not.toBeNull();
  });

  it('is shown for a shared team', async () => {
    expect(await renderTeam(false)).toContain('acme-robotics');
  });
});

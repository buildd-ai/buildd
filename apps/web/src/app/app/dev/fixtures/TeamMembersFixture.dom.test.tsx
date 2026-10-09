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
const { default: TeamDetailClient } = await import('../../(protected)/teams/[id]/TeamDetailClient');
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
    expect(v.count('Delete Team')).toBe(1);
    expect(v.count('+ Invite someone')).toBe(1);
    expect(v.leave.disabled).toBe(true);
    expect(v.text).toContain('You are the only owner.');
  });

  it('admin: manages the member, not the owner', async () => {
    const v = await renderAs('admin');
    expect(v.selects).toEqual(['Role for member@example.com']);
    expect(v.count('Transfer ownership')).toBe(0);
    expect(v.count('Remove')).toBe(1);
    expect(v.count('Delete Team')).toBe(0);
    expect(v.count('Edit')).toBe(1);
    expect(v.count('+ Invite someone')).toBe(1);
    expect(v.leave.disabled).toBe(false);
  });

  it('member: badges only', async () => {
    const v = await renderAs('member');
    expect(v.selects).toEqual([]);
    expect(v.count('Transfer ownership')).toBe(0);
    expect(v.count('Remove')).toBe(0);
    expect(v.count('Edit')).toBe(0);
    expect(v.count('+ Invite someone')).toBe(0);
    expect(v.leave.disabled).toBe(false);
  });
});

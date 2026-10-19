import { describe, expect, it } from 'bun:test';
import { acceptanceRoleRefusal, mayAuthorAcceptance } from './verdict-guards';

describe('mayAuthorAcceptance', () => {
  it('lets organizer and researcher change acceptance criteria', () => {
    expect(mayAuthorAcceptance('organizer')).toBe(true);
    expect(mayAuthorAcceptance('Researcher')).toBe(true);
  });
  it('refuses builder', () => {
    expect(mayAuthorAcceptance('builder')).toBe(false);
    expect(mayAuthorAcceptance(' Builder ')).toBe(false);
  });
  it('leaves other and absent roles to the existing workspace checks', () => {
    expect(mayAuthorAcceptance(null)).toBe(true);
    expect(mayAuthorAcceptance('ops')).toBe(true);
  });
});

describe('acceptanceRoleRefusal', () => {
  it('never refuses a person', async () => {
    expect(await acceptanceRoleRefusal({ kind: 'user', userId: 'u' })).toBeNull();
  });
  it('never refuses an account with no task scope', async () => {
    expect(await acceptanceRoleRefusal({ kind: 'account', account: { id: 'a' } as never }, async () => 'builder')).toBeNull();
  });
  it('refuses a task-scoped builder with 403', async () => {
    const caller = { kind: 'account', account: { id: 'a', taskScope: { taskId: 't', workspaceId: 'w' } } } as never;
    const r = await acceptanceRoleRefusal(caller, async () => 'builder');
    expect(r?.status).toBe(403);
    expect(await acceptanceRoleRefusal(caller, async () => 'organizer')).toBeNull();
  });
});

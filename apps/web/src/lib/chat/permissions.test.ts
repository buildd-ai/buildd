/**
 * Per-person tool permissions (docs/design/agent-chat.md → "Allow" for a tool
 * group). An "Allow" lets a write in that group skip its card for that person,
 * and only while no tool output is in the model's context. Admin-class writes
 * and never-in-chat actions stay locked.
 */
import { describe, expect, it } from 'bun:test';
import {
  ALLOWABLE_GROUPS, canSkipCard, contentInContext, parseAllowedGroups, toolPermissionRows,
} from './permissions';

const allowed = (...g: string[]) => parseAllowedGroups(g);

describe('ALLOWABLE_GROUPS', () => {
  it('only groups with a card-gated write; never admin', () => {
    expect(ALLOWABLE_GROUPS).toContain('missions');
    expect(ALLOWABLE_GROUPS).toContain('tasks');
    expect(ALLOWABLE_GROUPS).toContain('schedules');
    expect(ALLOWABLE_GROUPS).not.toContain('admin');
    // prs has no write chat offers (merge/close are deferred; release is admin).
    expect(ALLOWABLE_GROUPS).not.toContain('prs');
  });
});

describe('parseAllowedGroups', () => {
  it('drops unknown and locked groups', () => {
    expect([...parseAllowedGroups(['tasks', 'admin', 'prs', 'nope', 'tasks'])]).toEqual(['tasks']);
  });
});

describe('toolPermissionRows', () => {
  it('writes default to ask; admin and never-in-chat are locked; read-only groups say so', () => {
    const rows = toolPermissionRows(allowed());
    const by = Object.fromEntries(rows.map(r => [r.key, r]));
    expect(by.tasks.mode).toBe('ask');
    expect(by.tasks.locked).toBe(false);
    expect(by.admin).toMatchObject({ mode: 'ask', locked: true });
    expect(by.prs).toMatchObject({ mode: 'read', locked: true });
    expect(by.secrets).toMatchObject({ mode: 'never', locked: true });
  });

  it('reflects an allow', () => {
    expect(toolPermissionRows(allowed('tasks')).find(r => r.key === 'tasks')?.mode).toBe('allow');
  });
});

describe('contentInContext', () => {
  it('a tool result anywhere in the model messages taints the call', () => {
    expect(contentInContext([{ role: 'user', content: 'hold checkout' }])).toBe(false);
    expect(contentInContext([
      { role: 'user', content: 'what is running' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'list_tasks', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'list_tasks', output: { type: 'text', value: 'x' } }] },
      { role: 'user', content: 'hold checkout' },
    ])).toBe(true);
  });
});

describe('canSkipCard', () => {
  const clean = { tainted: false, docked: false };

  it('asks unless the person allowed the group', () => {
    expect(canSkipCard({ tool: 'hold_task', input: { taskId: 'x' }, allowedGroups: allowed(), ...clean })).toBe(false);
    expect(canSkipCard({ tool: 'hold_task', input: { taskId: 'x' }, allowedGroups: allowed('tasks'), ...clean })).toBe(true);
    expect(canSkipCard({ tool: 'manage_missions', input: { action: 'create', title: 't' }, allowedGroups: allowed('missions'), ...clean })).toBe(true);
  });

  it('a group allow does not reach a write in another group', () => {
    expect(canSkipCard({ tool: 'send_agent_message', input: { taskId: 'x', message: 'm' }, allowedGroups: allowed('tasks'), ...clean })).toBe(false);
  });

  it('content in context always gets a card (prompt injection)', () => {
    expect(canSkipCard({ tool: 'hold_task', input: { taskId: 'x' }, allowedGroups: allowed('tasks'), tainted: true, docked: false })).toBe(false);
  });

  it('a docked object puts its task titles in context: card', () => {
    expect(canSkipCard({ tool: 'hold_task', input: { taskId: 'x' }, allowedGroups: allowed('tasks'), tainted: false, docked: true })).toBe(false);
  });

  it('admin-class writes always ask, even in an allowed group', () => {
    expect(canSkipCard({ tool: 'manage_missions', input: { action: 'delete', missionId: 'm' }, allowedGroups: allowed('missions'), ...clean })).toBe(false);
    // A budget change makes an update admin-class.
    expect(canSkipCard({ tool: 'manage_missions', input: { action: 'update', missionId: 'm', costBudgetUsd: 5 }, allowedGroups: allowed('missions'), ...clean })).toBe(false);
    expect(canSkipCard({ tool: 'delete_schedule', input: { scheduleId: 's' }, allowedGroups: allowed('schedules'), ...clean })).toBe(false);
  });

  it('a mission write that shapes spend or run state always asks, even in an allowed group', () => {
    const upd = (extra: Record<string, unknown>) => ({ action: 'update', missionId: 'm', ...extra });
    for (const extra of [
      { maxConcurrentTasks: 20 }, { model: 'opus' }, { cronExpression: '* * * * *' }, { isHeartbeat: true },
      { pacingMode: 'off' }, { pacingMaxPerHour: 100 }, { startMode: 'now' }, { status: 'cancelled' },
      { orchestrationMode: 'parallel' }, { autoVerify: false }, { branchStrategy: 'direct' },
    ]) {
      expect(canSkipCard({ tool: 'manage_missions', input: upd(extra), allowedGroups: allowed('missions'), ...clean })).toBe(false);
      expect(canSkipCard({ tool: 'manage_missions', input: { action: 'create', title: 't', ...extra }, allowedGroups: allowed('missions'), ...clean })).toBe(false);
    }
    // The plain edits the allow is for still skip.
    expect(canSkipCard({ tool: 'manage_missions', input: upd({ title: 't', description: 'd', priority: 3 }), allowedGroups: allowed('missions'), ...clean })).toBe(true);
    expect(canSkipCard({ tool: 'manage_missions', input: upd({ addGoalCriteria: [{ type: 'all_prs_merged' }] }), allowedGroups: allowed('missions'), ...clean })).toBe(true);
  });

  it('anything that starts recurring or unattended work always asks, even in an allowed group', () => {
    const ask = (tool: string, input: Record<string, unknown>, group: string) =>
      canSkipCard({ tool, input, allowedGroups: allowed(group), ...clean });
    expect(ask('create_schedule', { name: 'n', cronExpression: '0 * * * *', title: 't' }, 'schedules')).toBe(false);
    expect(ask('update_schedule', { scheduleId: 's', name: 'renamed' }, 'schedules')).toBe(false);
    expect(ask('update_schedule', { scheduleId: 's', enabled: false }, 'schedules')).toBe(false);
    expect(ask('pause_schedules', { workspaceId: 'w', enabled: true }, 'schedules')).toBe(false);
    expect(ask('manage_missions', { action: 'arm', missionId: 'm' }, 'missions')).toBe(false);
    expect(ask('hold_task', { taskId: 'x', hold: false }, 'tasks')).toBe(false);
    // Stopping work is not starting it: a pause and a hold may still skip.
    expect(ask('pause_schedules', { workspaceId: 'w' }, 'schedules')).toBe(true);
    expect(ask('pause_schedules', { workspaceId: 'w', enabled: false }, 'schedules')).toBe(true);
    expect(ask('hold_task', { taskId: 'x', hold: true }, 'tasks')).toBe(true);
  });

  it('a create_task with a field outside its declared schema always asks', () => {
    const base = { title: 't', description: 'd' };
    expect(canSkipCard({ tool: 'create_task', input: base, allowedGroups: allowed('tasks'), ...clean })).toBe(true);
    expect(canSkipCard({ tool: 'create_task', input: { ...base, model: 'opus' }, allowedGroups: allowed('tasks'), ...clean })).toBe(false);
  });

  it('reads and unknown tools never go through here', () => {
    expect(canSkipCard({ tool: 'list_tasks', input: {}, allowedGroups: allowed('tasks'), ...clean })).toBe(false);
    expect(canSkipCard({ tool: 'manage_secrets', input: {}, allowedGroups: allowed('tasks'), ...clean })).toBe(false);
  });
});

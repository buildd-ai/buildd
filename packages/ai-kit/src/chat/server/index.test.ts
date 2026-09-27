/**
 * Tool permissions: the kit's port of buildd's Allow rules. The cases mirror
 * apps/web/src/lib/chat/permissions.test.ts against a generic declaration, so
 * the port is tested against the original's behaviour, not re-derived.
 */
import { describe, expect, it } from 'bun:test';
import {
  canSkipCard, contentInContext, defineToolGroups, skipCardVerdict, toolOutputInHistory, ToolGroupsError,
  type KitToolDecl, type SkipCardFacts,
} from './index';
import { allowedBadgeCount } from '../contract/index';

const obj = (i: unknown) => (i && typeof i === 'object' ? i : {}) as Record<string, unknown>;

const holdTask: KitToolDecl = { name: 'hold_task', class: 'write', startsUnattendedWork: i => obj(i).hold === false };
const sendMessage: KitToolDecl = { name: 'send_agent_message', class: 'write' };
const manageMissions: KitToolDecl = {
  name: 'manage_missions',
  class: 'write',
  effectiveClass: i => {
    const a = obj(i);
    if (a.action === 'delete') return 'admin';
    if ((a.action === 'update' || a.action === 'create') && a.costBudgetUsd !== undefined) return 'admin';
    return 'write';
  },
  startsUnattendedWork: i => obj(i).action === 'arm',
  skippableFields: ['action', 'missionId', 'title', 'description', 'addGoalCriteria', 'priority'],
};
const createSchedule: KitToolDecl = { name: 'create_schedule', class: 'write', startsUnattendedWork: true };
const pauseSchedules: KitToolDecl = { name: 'pause_schedules', class: 'write', startsUnattendedWork: i => obj(i).enabled === true };
const deleteSchedule: KitToolDecl = { name: 'delete_schedule', class: 'admin' };
const handOff: KitToolDecl = { name: 'hand_off', class: 'write', spends: true };

const groups = defineToolGroups({
  missions: { label: 'Missions', tools: [manageMissions], modes: ['ask', 'allow'] },
  tasks: { label: 'Tasks', tools: [holdTask], modes: ['ask', 'allow'] },
  workers: { label: 'Agents', tools: [sendMessage], modes: ['ask', 'allow'] },
  schedules: { label: 'Schedules', tools: [createSchedule, pauseSchedules, deleteSchedule], modes: ['ask', 'allow'] },
  handoff: { label: 'Hand-off', tools: [handOff], modes: ['ask', 'allow'] },
  prs: { label: 'PRs', tools: [{ name: 'get_pr', class: 'read' }], fixed: 'read' },
  admin: { label: 'Admin', tools: [{ name: 'trigger_release', class: 'admin' }], fixed: 'ask' },
  secrets: { label: 'Secrets', fixed: 'never' },
});

const allowed = (...g: string[]) => groups.parseAllowed(g);
const clean = { tainted: false, docked: false, skippedThisTurn: 0 };
const skip = (tool: string, input: unknown, ...allow: string[]) =>
  groups.canSkipCard({ tool, input, allowedGroups: allowed(...allow), ...clean });

describe('defineToolGroups', () => {
  it('only toggleable groups with a write are allowable', () => {
    expect(groups.allowable).toEqual(['missions', 'tasks', 'workers', 'schedules', 'handoff']);
  });

  it('parseAllowed drops unknown and locked groups', () => {
    expect([...groups.parseAllowed(['tasks', 'admin', 'prs', 'nope', 'tasks', 'secrets', 3])]).toEqual(['tasks']);
    expect(groups.parseAllowed('tasks').size).toBe(0);
  });

  it('rows: writes default to ask; fixed groups are locked in their mode', () => {
    const by = Object.fromEntries(groups.rows(allowed()).map(r => [r.key, r]));
    expect(by.tasks).toMatchObject({ mode: 'ask', locked: false, label: 'Tasks' });
    expect(by.admin).toMatchObject({ mode: 'ask', locked: true });
    expect(by.prs).toMatchObject({ mode: 'read', locked: true });
    expect(by.secrets).toMatchObject({ mode: 'never', locked: true });
  });

  it('rows reflect an allow, and the badge counts allowed groups', () => {
    const rows = groups.rows(allowed('tasks', 'missions'));
    expect(rows.find(r => r.key === 'tasks')?.mode).toBe('allow');
    expect(allowedBadgeCount(rows)).toBe(2);
    expect(allowedBadgeCount(groups.rows(allowed()))).toBe(0);
  });

  it('an allow for a locked group never shows as allow', () => {
    expect(groups.rows(new Set(['admin'])).find(r => r.key === 'admin')?.mode).toBe('ask');
  });

  it('a never group registers no tools', () => {
    expect(groups.registeredToolNames()).not.toContain('manage_secrets');
    expect(groups.groupOf('get_pr')).toBe('prs');
    expect(groups.groupOf('nope')).toBeUndefined();
  });

  it('throws at startup on an unsafe declaration', () => {
    const bad = (d: Record<string, unknown>) => () => defineToolGroups(d as never);
    expect(bad({ a: { label: 'A', tools: [{ name: 'w', class: 'write' }], fixed: 'read' } })).toThrow(ToolGroupsError);
    expect(bad({ a: { label: 'A', tools: [{ name: 'w', class: 'admin' }], fixed: 'read' } })).toThrow(/read only/);
    expect(bad({ a: { label: 'A', tools: [{ name: 'r', class: 'read' }], fixed: 'never' } })).toThrow(/never/);
    expect(bad({ a: { label: 'A', tools: [{ name: 'w', class: 'write' }] } })).toThrow(/exactly one/);
    expect(bad({ a: { label: 'A', tools: [{ name: 'w', class: 'write' }], modes: ['ask'], fixed: 'ask' } })).toThrow(/exactly one/);
    expect(bad({ a: { label: 'A', tools: [{ name: 'r', class: 'read' }], modes: ['ask', 'allow'] } })).toThrow(/no write/);
    expect(bad({ a: { label: 'A', tools: [{ name: 'w', class: 'write' }], modes: ['allow'] } })).toThrow(/modes/);
    expect(bad({
      a: { label: 'A', tools: [{ name: 'w', class: 'write' }], modes: ['ask', 'allow'] },
      b: { label: 'B', tools: [{ name: 'w', class: 'write' }], modes: ['ask', 'allow'] },
    })).toThrow(/both/);
  });

  it("a group with modes ['ask'] only is toggle-less: never allowable", () => {
    const g = defineToolGroups({ a: { label: 'A', tools: [{ name: 'w', class: 'write' }], modes: ['ask'] } });
    expect(g.allowable).toEqual([]);
    expect(g.canSkipCard({ tool: 'w', input: {}, allowedGroups: new Set(['a']), ...clean })).toBe(false);
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
    expect(contentInContext([{ role: 'user', content: [{ type: 'tool-result' }] }])).toBe(true);
  });
});

describe('toolOutputInHistory', () => {
  it('sticky: any stored tool part, or a truncated load, taints', () => {
    expect(toolOutputInHistory([{ parts: [{ type: 'text' }] }], false)).toBe(false);
    expect(toolOutputInHistory([{ parts: [{ type: 'tool-list_tasks' }] }], false)).toBe(true);
    expect(toolOutputInHistory([{ parts: [{ type: 'dynamic-tool' }] }], false)).toBe(true);
    expect(toolOutputInHistory([], true)).toBe(true);
  });
});

describe('canSkipCard (ported from buildd)', () => {
  it('asks unless the person allowed the group', () => {
    expect(skip('hold_task', { taskId: 'x' })).toBe(false);
    expect(skip('hold_task', { taskId: 'x' }, 'tasks')).toBe(true);
    expect(skip('manage_missions', { action: 'create', title: 't' }, 'missions')).toBe(true);
  });

  it('a group allow does not reach a write in another group', () => {
    expect(skip('send_agent_message', { taskId: 'x', message: 'm' }, 'tasks')).toBe(false);
  });

  it('content in context always gets a card (prompt injection)', () => {
    expect(groups.canSkipCard({ tool: 'hold_task', input: {}, allowedGroups: allowed('tasks'), ...clean, tainted: true })).toBe(false);
  });

  it('a docked object puts its data in context: card', () => {
    expect(groups.canSkipCard({ tool: 'hold_task', input: {}, allowedGroups: allowed('tasks'), ...clean, docked: true })).toBe(false);
  });

  it('only the first skipped write of a turn skips', () => {
    expect(groups.skipCardVerdict({ tool: 'hold_task', input: {}, allowedGroups: allowed('tasks'), ...clean, skippedThisTurn: 1 }))
      .toEqual({ skip: false, reason: 'already_skipped_this_turn' });
  });

  it('admin-class writes always ask, even in an allowed group', () => {
    expect(skip('manage_missions', { action: 'delete', missionId: 'm' }, 'missions')).toBe(false);
    expect(skip('manage_missions', { action: 'update', missionId: 'm', costBudgetUsd: 5 }, 'missions')).toBe(false);
    expect(skip('delete_schedule', { scheduleId: 's' }, 'schedules')).toBe(false);
  });

  it('a write carrying a field outside its skippable allowlist asks', () => {
    for (const extra of [{ maxConcurrentTasks: 20 }, { model: 'x' }, { status: 'cancelled' }]) {
      expect(skip('manage_missions', { action: 'update', missionId: 'm', ...extra }, 'missions')).toBe(false);
    }
    expect(skip('manage_missions', { action: 'update', missionId: 'm', title: 't', description: 'd', priority: 3 }, 'missions')).toBe(true);
    // An explicitly undefined field is not carried.
    expect(skip('manage_missions', { action: 'update', missionId: 'm', model: undefined }, 'missions')).toBe(true);
  });

  it('anything that starts recurring or unattended work always asks', () => {
    expect(skip('create_schedule', { name: 'n' }, 'schedules')).toBe(false);
    expect(skip('pause_schedules', { enabled: true }, 'schedules')).toBe(false);
    expect(skip('manage_missions', { action: 'arm', missionId: 'm' }, 'missions')).toBe(false);
    expect(skip('hold_task', { taskId: 'x', hold: false }, 'tasks')).toBe(false);
    // Stopping work is not starting it.
    expect(skip('pause_schedules', {}, 'schedules')).toBe(true);
    expect(skip('pause_schedules', { enabled: false }, 'schedules')).toBe(true);
    expect(skip('hold_task', { taskId: 'x', hold: true }, 'tasks')).toBe(true);
  });

  it('a write that spends always asks', () => {
    expect(groups.skipCardVerdict({ tool: 'hand_off', input: {}, allowedGroups: allowed('handoff'), ...clean }))
      .toEqual({ skip: false, reason: 'spends' });
  });

  it('reads and unknown tools never skip', () => {
    expect(skip('get_pr', {}, 'prs', 'tasks')).toBe(false);
    expect(skip('manage_secrets', {}, 'tasks')).toBe(false);
  });
});

describe('skipCardVerdict (pure facts)', () => {
  const base: SkipCardFacts = {
    callClass: 'write', group: 'g', groupAllowable: true, allowedGroups: new Set(['g']),
    tainted: false, docked: false, startsUnattendedWork: false, skippedThisTurn: 0,
  };
  it('all rules hold ⇒ skip', () => {
    expect(skipCardVerdict(base)).toEqual({ skip: true });
    expect(canSkipCard(base)).toBe(true);
  });
  it('each rule alone refuses, with its reason', () => {
    const cases: Array<[Partial<SkipCardFacts>, string]> = [
      [{ tainted: true }, 'tainted'],
      [{ docked: true }, 'docked'],
      [{ allowedGroups: new Set() }, 'nothing_allowed'],
      [{ skippedThisTurn: 1 }, 'already_skipped_this_turn'],
      [{ callClass: undefined }, 'unknown_tool'],
      [{ group: undefined }, 'unknown_tool'],
      [{ callClass: 'read' }, 'not_write'],
      [{ callClass: 'admin' }, 'not_write'],
      [{ startsUnattendedWork: true }, 'unattended'],
      [{ spends: true }, 'spends'],
      [{ inputSkippable: false }, 'input_not_skippable'],
      [{ groupAllowable: false }, 'group_not_allowed'],
      [{ allowedGroups: new Set(['other']) }, 'group_not_allowed'],
    ];
    for (const [patch, reason] of cases) {
      expect(skipCardVerdict({ ...base, ...patch })).toEqual({ skip: false, reason: reason as never });
    }
  });
});

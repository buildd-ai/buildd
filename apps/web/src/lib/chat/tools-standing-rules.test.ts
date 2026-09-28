/**
 * Work chat files carries the chatting person's standing rules
 * (chat-directives.ts): a task or mission created from chat gets the rules
 * that apply to its workspace in its description, visible to the agent and to
 * anyone reading the task. Another workspace's rules never ride along.
 */
import { describe, it, expect, mock } from 'bun:test';
import { TASK_RULES_HEADING } from '@buildd/core/chat-directives';
import { buildChatTools, withRulesForFiledWork } from './tools';

const WS = 'aaaa0000-0000-4000-8000-000000000001';
const OTHER = 'bbbb0000-0000-4000-8000-000000000002';
const at = (d: number) => new Date(Date.UTC(2026, 8, d));
const RULES = [
  { text: 'Always open PRs as drafts', workspaceId: null, createdAt: at(1) },
  { text: 'Run the billing smoke test first', workspaceId: WS, createdAt: at(2) },
  { text: 'Use pnpm in the other repo', workspaceId: OTHER, createdAt: at(3) },
];

function setup(rules = RULES) {
  const seen: Array<{ action: string; params: any }> = [];
  const handle = mock(async (_api: any, action: string, params: any) => {
    seen.push({ action, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const tools = buildChatTools({
    ctx: { workspaceId: WS, getWorkspaceId: async () => WS, getLevel: async () => 'admin' } as any,
    allowWrites: true,
    authorizedToolCallIds: new Set(['call-1']),
    handle: handle as any,
    standingRules: rules,
    makeApi: (onCall) => async (endpoint: string, init?: RequestInit) => {
      onCall({ method: init?.method ?? 'GET', path: endpoint.split('?')[0], status: 200, body: {} });
      return {};
    },
  });
  const run = (name: string, input: unknown) => (tools[name] as any).execute(input, { toolCallId: 'call-1', messages: [] });
  return { run, seen };
}

describe('standing rules on work chat files', () => {
  it('a created task carries the rules for its workspace', async () => {
    const { run, seen } = setup();
    await run('create_task', { title: 'Fix rounding', description: 'Round half-even.', workspaceId: WS, kind: 'engineering' });
    const d = seen.find(s => s.action === 'create_task')!.params.description as string;
    expect(d.startsWith('Round half-even.\n\n')).toBe(true);
    expect(d).toContain(TASK_RULES_HEADING);
    expect(d).toContain('- Run the billing smoke test first (this workspace only)');
    expect(d).toContain('- Always open PRs as drafts');
  });

  it('another workspace\'s rules are excluded', async () => {
    const { run, seen } = setup();
    await run('create_task', { title: 'Fix rounding', description: 'x', workspaceId: WS, kind: 'engineering' });
    expect(seen[0].params.description).not.toContain('Use pnpm in the other repo');
    await run('create_task', { title: 'Other', description: 'y', workspaceId: OTHER, kind: 'engineering' });
    const other = seen[1].params.description as string;
    expect(other).toContain('Use pnpm in the other repo');
    expect(other).not.toContain('billing smoke test');
  });

  it('a mission created from chat carries them too', async () => {
    const { run, seen } = setup();
    await run('manage_missions', { action: 'create', title: 'Multi-currency', description: 'Bill in local currency.', goalCriteria: [{ type: 'all_prs_merged' }] });
    const d = seen.find(s => s.action === 'manage_missions')!.params.description as string;
    expect(d).toContain(TASK_RULES_HEADING);
    // No workspace named: the turn's default workspace applies.
    expect(d).toContain('billing smoke test');
  });

  it('reads and other writes are untouched; no rules, no block', async () => {
    const { run, seen } = setup();
    await run('list_tasks', { status: 'active' });
    expect(JSON.stringify(seen[0].params)).not.toContain(TASK_RULES_HEADING);
    const none = setup([]);
    await none.run('create_task', { title: 't', description: 'plain', workspaceId: WS, kind: 'engineering' });
    expect(none.seen[0].params.description).toBe('plain');
  });

  it('withRulesForFiledWork ignores a non-uuid workspace and falls back to the default', () => {
    const out = withRulesForFiledWork({ description: 'd', workspaceId: 'billing-web' }, RULES, WS);
    expect(out.description).toContain('billing smoke test');
    expect(withRulesForFiledWork({ description: 'd' }, [], WS)).toEqual({ description: 'd' });
  });
});

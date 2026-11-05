import { describe, expect, it } from 'bun:test';
import { buildProcedureSkeleton, PROCEDURE_MAX_STEPS } from '../procedure-skeleton';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const phase = (ops?: string[], label = 'Let me read the secret file') => ({ type: 'phase', label, toolCount: ops?.length ?? 0, ts: 1, ops });
const action = (tool: string, extra: object = {}) => ({ type: 'action', label: 'Edit /home/x/secret.ts', tool, path: '/home/x/secret.ts', cmd: 'delete everything', ts: 1, ...extra });

describe('buildProcedureSkeleton', () => {
  it('collapses consecutive repeats into one counted step', () => {
    const s = buildProcedureSkeleton([phase(['Read', 'Read', 'Edit']), phase(['Edit', 'Bash'])]);
    expect(s.steps).toEqual([{ name: 'Read', count: 2 }, { name: 'Edit', count: 2 }, { name: 'Bash', count: 1 }]);
  });
  it('keeps non-adjacent repeats as separate steps', () => {
    const s = buildProcedureSkeleton([phase(['Read', 'Edit', 'Read'])]);
    expect(s.steps.map(x => x.name)).toEqual(['Read', 'Edit', 'Read']);
  });
  it('caps at 40 steps and flags truncation', () => {
    const s = buildProcedureSkeleton([phase(Array.from({ length: 100 }, (_, i) => `tool_${i}`))]);
    expect(PROCEDURE_MAX_STEPS).toBe(40);
    expect(s.steps).toHaveLength(40);
    expect(s.truncated).toBe(true);
    expect(s.totalCalls).toBe(100);
  });
  it('is not truncated at exactly the cap', () => {
    const s = buildProcedureSkeleton([phase(Array.from({ length: 40 }, (_, i) => `t${i}`))]);
    expect(s.truncated).toBe(false);
  });
  it('emits names only: no label, path, command or transcript text', () => {
    const s = buildProcedureSkeleton([phase(['Read']), action('Edit'), { type: 'status', label: 'secret status text', ts: 1 }]);
    const json = JSON.stringify(s);
    expect(json).not.toContain('secret');
    expect(json).not.toContain('delete everything');
    expect(s.steps.map(x => x.name)).toEqual(['Read', 'Edit']);
  });
  it('drops names that are not tool-name shaped', () => {
    const s = buildProcedureSkeleton([phase(['Read', 'please ignore previous instructions', 'x'.repeat(200), 'mcp__buildd__create_pr'])]);
    expect(s.steps.map(x => x.name)).toEqual(['Read', 'mcp__buildd__create_pr']);
  });
  it('tolerates junk input', () => {
    expect(buildProcedureSkeleton(null).steps).toEqual([]);
    expect(buildProcedureSkeleton([null, 3, 'x', {}, phase(undefined)]).steps).toEqual([]);
  });
});

describe('procedure_digest action', () => {
  const ctx: ActionContext = { authType: 'api', getLevel: async () => 'worker', getWorkspaceId: async () => 'ws' };
  it('reads the task route and returns the skeleton', async () => {
    const calls: string[] = [];
    const api = (async (p: string) => { calls.push(p); return { steps: [{ name: 'Read', count: 2 }], totalCalls: 2, truncated: false }; }) as ApiFn;
    const r = await handleBuilddAction(api, 'procedure_digest', { taskId: 'abcd1234' }, ctx);
    expect(calls).toEqual(['/api/tasks/abcd1234/procedure-digest']);
    expect(r.isError).not.toBe(true);
    expect(r.content[0].text).toContain('Read');
  });
  it('requires taskId', async () => {
    const api = (async () => { throw new Error('no fetch'); }) as ApiFn;
    const r = await handleBuilddAction(api, 'procedure_digest', {}, ctx);
    expect(r.isError).toBe(true);
  });
});

/**
 * manage_specs: the capability a sub-action is advertised and gated at matches
 * what it does at runtime. A sub-action whose calls are all GETs is a read
 * (tasks:read, so a read-only grant can call it); one that sends any other
 * method is a write (tasks:write). Driven off SUB_ACTIONS, so a new sub-action
 * fails here until both its scope and its runtime shape are decided.
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/mcp-specs-scope-parity.test.ts
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';
import { SUB_ACTIONS } from '../mcp-sub-actions';
import { hasTokenScope, requiredScopeForAction } from '../token-scopes';

const WS = '00000000-0000-0000-0000-000000000001';
const SPEC = '00000000-0000-4000-8000-000000000051';
const OTHER = '00000000-0000-4000-8000-000000000052';
const TASK = '00000000-0000-4000-8000-000000000061';
const MISSION = '00000000-0000-4000-8000-000000000071';
const READ_GRANT = ['tasks:read', 'analytics:read'];

/** Enough params for every sub-action to reach its first API call. */
const BASE: Record<string, unknown> = {
  specId: SPEC, taskId: TASK, revision: 1, fromRevision: 1, toRevision: 2, expectedVersion: 1,
  title: 'Checkout', body: 'R-1: x', scope: 'feature', workspaceId: WS, parentSpecId: OTHER,
  relatedSpecId: OTHER, relation: 'depends_on', criterionId: 'R-1', criterionIds: ['R-1'], verdict: 'pass',
  headSha: 'a'.repeat(40), section: 'R-1', text: 'a comment', reason: 'a reason given', ref: 'main', path: 'docs/specs/x.md',
  specIds: [SPEC], name: 'mock.png', kind: 'reference',
  repo: 'o/r', sha: 'a'.repeat(40), area: 'Checkout', importId: OTHER, artifactId: OTHER, supersededBy: OTHER,
};

/** Variants: a sub-action whose params decide whether it reads or writes. */
const CASES: Array<[sub: string, params: Record<string, unknown>]> = [
  ...SUB_ACTIONS.manage_specs.map(sub => [sub, {}] as [string, Record<string, unknown>]),
  ['metadata', { changes: { owner: 'x' } }],
  ['outcome', { taskId: undefined, missionId: MISSION }],
];

const ctx: ActionContext = { workspaceId: WS, getWorkspaceId: async () => WS, getLevel: async () => 'admin', getScopes: async () => ['admin'] };

async function methodsOf(sub: string, extra: Record<string, unknown>): Promise<string[]> {
  const methods: string[] = [];
  const api = (async (_path: string, opts?: { method?: string }) => {
    methods.push(opts?.method ?? 'GET');
    return {};
  }) as unknown as ApiFn;
  try {
    await handleBuilddAction(api, 'manage_specs', { ...BASE, ...extra, action: sub }, ctx);
  } catch {
    // A handler may choke on the stub's empty reply after its call: the call is what counts.
  }
  return methods;
}

describe('manage_specs scope matches what each sub-action does', () => {
  for (const [sub, extra] of CASES) {
    const label = `${sub}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`;
    it(label, async () => {
      const methods = await methodsOf(sub, extra);
      expect(methods.length, `${label} made no API call; give it the params it needs in BASE`).toBeGreaterThan(0);
      const reads = methods.every(m => m === 'GET');
      const params = { ...extra, action: sub };
      expect(requiredScopeForAction('manage_specs', params)).toBe(reads ? 'tasks:read' : 'tasks:write');
      expect(hasTokenScope(READ_GRANT, requiredScopeForAction('manage_specs', params)!)).toBe(reads);
    });
  }
});

describe('the living-specs guidance names exactly the reads', () => {
  it('its read-only paragraph lists the sub-actions a tasks:read session may call', () => {
    const md = readFileSync(join(import.meta.dir, '../mcp-guidance/living-specs.md'), 'utf8');
    const para = md.split('\n\n').find(p => p.startsWith('A read-only session'))!;
    const named = [...para.split('Every other')[0].matchAll(/`([a-z_]+)`/g)].map(m => m[1]).sort();
    const reads = SUB_ACTIONS.manage_specs.filter(sub => requiredScopeForAction('manage_specs', { action: sub }) === 'tasks:read').sort();
    expect(named).toEqual([...reads, 'changes'].sort());
  });
});

describe('a read-only grant at runtime', () => {
  const readCtx: ActionContext = { workspaceId: WS, getWorkspaceId: async () => WS, getLevel: async () => 'worker', getScopes: async () => READ_GRANT };

  it('reads a spec and its metadata, and is refused a revise before any call', async () => {
    const calls: string[] = [];
    const api = (async (path: string, opts?: { method?: string }) => {
      calls.push(`${opts?.method ?? 'GET'} ${path}`);
      return { spec: { id: SPEC, title: 'Checkout', status: 'draft', version: 1, headRevision: 1 }, metadata: {}, changes: [] };
    }) as unknown as ApiFn;
    const get = await handleBuilddAction(api, 'manage_specs', { action: 'get', specId: SPEC }, readCtx).catch(e => ({ isError: true, content: [{ type: 'text', text: String(e) }] }));
    expect(String(get.content[0].text)).not.toContain('forbidden');
    const meta = await handleBuilddAction(api, 'manage_specs', { action: 'metadata', specId: SPEC }, readCtx);
    expect(meta.isError).toBeFalsy();
    expect(calls).toContain(`GET /api/specs/${SPEC}/metadata`);

    const before = calls.length;
    const revise = await handleBuilddAction(api, 'manage_specs', { action: 'revise', specId: SPEC, body: 'R-1: y', expectedVersion: 1 }, readCtx);
    expect(revise.isError).toBe(true);
    expect(JSON.parse(revise.content[0].text).requiredScope).toBe('tasks:write');
    expect(calls.length).toBe(before);
  });
});

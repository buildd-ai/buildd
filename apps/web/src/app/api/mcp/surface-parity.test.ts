/**
 * Surface parity: what a session may call is what it is shown, on every
 * surface, and every surface names the same sub-actions.
 *
 * Enumerates every action x token level x scope set (including the read-only
 * account grant) x surface (legacy `buildd`, group tools, `help`) and holds:
 * - dispatchable => advertised: an action the session's gate lets through for
 *   at least one of its sub-actions is in that surface's enum, and `help` on it
 *   returns its docs instead of "not available".
 * - every sub-action in SUB_ACTIONS (@buildd/core/mcp-sub-actions) appears in
 *   each surface: the long docs (legacy params + help), and the group tool
 *   (signature or typed params), whether the action is listed or on `More:`.
 * - the handler accepts exactly the registered sub-actions.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/app/api/mcp/surface-parity.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  adminActions,
  allActions,
  handleBuilddAction,
  handleMemoryAction,
  PERSONAL_ROLE_ACTIONS,
  triggerActions,
  workerActions,
  type ActionContext,
} from '@buildd/core/mcp-tools';
import { SUB_ACTIONS, subActionAlternation, subActionSelector, subActionsOf, type SubActionOwner } from '@buildd/core/mcp-sub-actions';
import { actionHelp, derivedSignature, mcpGroupOf, mcpGroupToolName } from '@buildd/core/mcp-tool-groups';
import { hasTokenScope, requiredScopeForAction, TOKEN_PRESETS, TOKEN_SCOPES } from '@buildd/core/token-scopes';
import { READ_GRANT_TOKEN_SCOPES } from '@/lib/mcp-grants';
import { GUIDANCE_GROUP, listMcpTools, mcpServerInstructions, requiredScopeForMcpTool, routeGroupToolCall, type McpAccountLevel, type McpToolSurface } from './tools';

type Tool = { name: string; description?: string; inputSchema?: { properties?: Record<string, any> } };

const OWNERS = Object.keys(SUB_ACTIONS) as SubActionOwner[];

/** The session shapes that matter: legacy levels, then explicit scope sets. */
const SESSIONS: Array<{ label: string; accountLevel: McpAccountLevel; scopes: string[] | null }> = [
  { label: 'trigger', accountLevel: 'trigger', scopes: null },
  { label: 'worker', accountLevel: 'worker', scopes: null },
  { label: 'admin', accountLevel: 'admin', scopes: null },
  { label: 'read grant', accountLevel: 'worker', scopes: [...READ_GRANT_TOKEN_SCOPES] },
  ...Object.entries(TOKEN_PRESETS).map(([k, p]) => ({ label: `preset ${k}`, accountLevel: 'worker' as const, scopes: [...p.scopes] })),
  ...TOKEN_SCOPES.map(s => ({ label: `scope ${s}`, accountLevel: 'worker' as const, scopes: [s] })),
];

const SURFACES: McpToolSurface[] = ['groups', 'legacy'];

const ADMIN = new Set<string>(adminActions);
const WORKER = new Set<string>(workerActions);
const TRIGGER = new Set<string>(triggerActions);
const PERSONAL = new Set<string>(PERSONAL_ROLE_ACTIONS);

/**
 * Whether handleBuilddAction's gate lets the session call `action` with at
 * least one of its sub-actions. Mirrors the gate, not the listing: scoped
 * sessions are checked per sub-action (requiredScopeForAction), legacy levels
 * by requireWorkerLevel / requireAdminLevel (a worker reaches the personal-role
 * path of the skill actions).
 */
function dispatchable(action: string, accountLevel: McpAccountLevel, scopes: string[] | null): boolean {
  if (scopes != null) {
    const subs = subActionsOf(action);
    const sel = subActionSelector(action);
    const tries = subs ? subs.map(s => ({ [sel]: s })) : [{}];
    return tries.some(p => {
      const req = requiredScopeForAction(action, p);
      return req != null && hasTokenScope(scopes, req);
    });
  }
  if (accountLevel === 'admin') return true;
  if (accountLevel === 'worker') return !ADMIN.has(action) || PERSONAL.has(action);
  return TRIGGER.has(action) || (!WORKER.has(action) && !ADMIN.has(action));
}

function actionsOn(tools: object[]): Set<string> {
  const out = new Set<string>();
  for (const t of tools as Tool[]) for (const a of t.inputSchema?.properties?.action?.enum ?? []) out.add(a);
  return out;
}

describe('dispatchable => advertised, on every surface and session', () => {
  for (const s of SESSIONS) {
    for (const surface of SURFACES) {
      it(`${s.label} / ${surface}`, () => {
        const listed = actionsOn(listMcpTools({ accountLevel: s.accountLevel, scopes: s.scopes, isSensitive: false, surface }));
        const missing = allActions.filter(a => dispatchable(a, s.accountLevel, s.scopes) && !listed.has(a));
        expect(missing).toEqual([]);
      });
    }

    it(`${s.label} / help answers for every dispatchable action`, () => {
      const refused = allActions.filter(a => {
        if (!dispatchable(a, s.accountLevel, s.scopes)) return false;
        const r = routeGroupToolCall(mcpGroupOf(a)!, { action: 'help', params: { action: a } }, s.accountLevel, s.scopes);
        return r.kind !== 'reply' || r.isError;
      });
      expect(refused).toEqual([]);
    });
  }

  it('a read-only grant is shown manage_specs, and help on it is its docs', () => {
    const scopes = [...READ_GRANT_TOKEN_SCOPES];
    for (const surface of SURFACES) {
      expect(actionsOn(listMcpTools({ accountLevel: 'worker', scopes, isSensitive: false, surface })).has('manage_specs')).toBe(true);
    }
    const r = routeGroupToolCall('artifacts', { action: 'help', params: { action: 'manage_specs' } }, 'worker', scopes);
    expect(r).toMatchObject({ kind: 'reply', isError: false });
    expect((r as { text: string }).text).not.toContain('not available');
  });
});

describe('every registered sub-action appears on every surface', () => {
  for (const owner of OWNERS) {
    const sel = subActionSelector(owner);
    const alt = subActionAlternation(owner);

    it(`${owner}: long docs (legacy params, help) name all ${SUB_ACTIONS[owner].length}`, () => {
      expect(derivedSignature(owner)).toContain(`${sel}: ${alt}`);
      const legacy = (listMcpTools({ accountLevel: 'admin', isSensitive: false, surface: 'legacy' }) as Tool[]).find(t => t.name === 'buildd')!;
      const docs = legacy.inputSchema!.properties!.params.description as string;
      const line = docs.split('\n').find(l => l.startsWith(`- ${owner}: `))!;
      for (const sub of SUB_ACTIONS[owner]) expect(line).toMatch(new RegExp(`["|(: ]${sub}["|),]`));
      const r = routeGroupToolCall(mcpGroupOf(owner)!, { action: 'help', params: { action: owner } }, 'admin');
      expect((r as { text: string }).text).toBe(actionHelp(owner)!);
    });

    it(`${owner}: its group tool names all of them, for every session shown it`, () => {
      for (const s of SESSIONS) {
        const tool = (listMcpTools({ accountLevel: s.accountLevel, scopes: s.scopes, isSensitive: false, surface: 'groups' }) as Tool[])
          .find(t => t.name === mcpGroupToolName(mcpGroupOf(owner)!));
        if (!tool?.inputSchema?.properties?.action?.enum?.includes(owner)) continue;
        const field = tool.inputSchema!.properties!.params.properties?.[sel];
        const named = (tool.description ?? '').includes(`${owner} {${sel}: ${alt}`) ||
          String(field?.description ?? '').includes(`${owner}: ${alt}`) ||
          JSON.stringify(field?.enum ?? []) === JSON.stringify(SUB_ACTIONS[owner]);
        expect(named, `${owner} on ${tool.name} (${s.label})`).toBe(true);
      }
    });
  }
});

describe('the handler takes exactly the registered sub-actions', () => {
  const ctx: ActionContext = { getWorkspaceId: async () => 'ws-1', getLevel: async () => 'admin' };
  const api = async () => ({});
  const ID = '00000000-0000-4000-8000-000000000000';
  const REFUSED = /unknown .*action|(action|op) must be one of|action is required|op is required|action must be "/i;

  // consolidate_knowledge runs in the memory handler, straight off the vector
  // store: only its refusal (which runs before any store call) is exercised.
  const MEMORY = new Set<string>(['consolidate_knowledge']);

  async function reply(action: string, params: Record<string, unknown>): Promise<string> {
    try {
      const r = MEMORY.has(action)
        ? await handleMemoryAction(null, action, params, { teamId: 't1', workspaceId: 'ws-1' } as Parameters<typeof handleMemoryAction>[3])
        : await handleBuilddAction(api, action, { incidentId: ID, ...params }, ctx);
      return r.content.map(c => c.text).join('\n');
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  for (const owner of OWNERS) {
    const sel = subActionSelector(owner);
    it(`${owner}: an unknown one is refused naming every registered one`, async () => {
      const text = await reply(owner, { [sel]: 'not_a_sub_action' });
      expect(text).toMatch(REFUSED);
      for (const sub of SUB_ACTIONS[owner]) expect(text).toContain(sub);
    });

    if (MEMORY.has(owner)) continue;
    it(`${owner}: no registered one is refused as unknown`, async () => {
      for (const sub of SUB_ACTIONS[owner]) {
        expect(await reply(owner, { [sel]: sub }), `${owner} ${sub}`).not.toMatch(REFUSED);
      }
    });
  }
});

describe('help {topic}: workflow guidance for tools-only clients', () => {
  let dir = '';
  let prev: string | undefined;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'guidance-'));
    writeFileSync(join(dir, 'living-specs.md'), '---\nname: living-specs\ndescription: Draft, revise and verify Living Specs.\n---\nSpec body.\n');
    prev = process.env.BUILDD_MCP_GUIDANCE_DIR;
    process.env.BUILDD_MCP_GUIDANCE_DIR = dir;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.BUILDD_MCP_GUIDANCE_DIR;
    else process.env.BUILDD_MCP_GUIDANCE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it('every session gets the topic from any group tool it is shown', () => {
    for (const s of SESSIONS) {
      for (const t of listMcpTools({ accountLevel: s.accountLevel, scopes: s.scopes, isSensitive: false, surface: 'groups' }) as Tool[]) {
        const group = t.name.startsWith('buildd_') ? t.name.slice('buildd_'.length) : null;
        if (!group || !t.inputSchema?.properties?.action?.enum?.includes('help')) continue;
        const r = routeGroupToolCall(group as never, { action: 'help', params: { topic: 'living-specs' } }, s.accountLevel, s.scopes);
        expect(r, `${s.label} ${t.name}`).toMatchObject({ kind: 'reply', isError: false });
        expect((r as { text: string }).text).toMatch(/^Guidance: living-specs \(sha256 [0-9a-f]{12}\)\n\nSpec body\.$/);
      }
    }
  });

  it('help {} lists the topics with their descriptions; an unknown one names the rest', () => {
    const r = routeGroupToolCall('tasks', { action: 'help', params: {} }, 'worker', [...READ_GRANT_TOKEN_SCOPES]);
    expect((r as { text: string }).text).toContain('- living-specs: Draft, revise and verify Living Specs.');
    expect(routeGroupToolCall('tasks', { action: 'help', params: { topic: 'nope' } }, 'trigger')).toEqual({ kind: 'reply', isError: true, text: 'No guidance topic "nope". Available: living-specs.' });
  });

  it('the one-tool buildd serves it too, at tasks:read, on both endpoints', async () => {
    const legacy = (listMcpTools({ accountLevel: 'worker', scopes: [...READ_GRANT_TOKEN_SCOPES], isSensitive: false, surface: 'legacy' }) as Tool[]).find(t => t.name === 'buildd')!;
    expect(legacy.inputSchema!.properties!.action.enum).toContain('help');
    expect(requiredScopeForMcpTool('buildd', { action: 'help', params: { topic: 'living-specs' } })).toBe('tasks:read');
    const ctx: ActionContext = { getWorkspaceId: async () => null, getLevel: async () => 'trigger', getScopes: async () => [...READ_GRANT_TOKEN_SCOPES] };
    const r = await handleBuilddAction(async () => { throw new Error('no route call'); }, 'help', { topic: 'living-specs' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('Spec body.');
    const oauth = readFileSync(join(import.meta.dir, '../mcp-oauth/[workspace]/route.ts'), 'utf8');
    expect(oauth).toContain("enum: [...actions, 'help'],");
    expect(oauth).toContain('instructions: `Before acting on buildd tasks or Living Specs, call');
  });

  it('the instructions open with the guidance pointer, inside the first 512 characters', () => {
    for (const s of SESSIONS) {
      for (const surface of SURFACES) {
        const head = mcpServerInstructions(s.accountLevel, surface, s.scopes).slice(0, 512);
        expect(head, `${s.label}/${surface}`).toMatch(/^Before acting on buildd tasks or Living Specs, call `buildd(_[a-z]+)?` action "help", params \{"topic":"living-specs"\}/);
      }
    }
    expect(mcpServerInstructions('trigger', 'groups')).toContain(`\`buildd_${GUIDANCE_GROUP}\``);
  });

  it('the guidance group types topic, so a schema-constrained model can send it', () => {
    const tool = (listMcpTools({ accountLevel: 'trigger', isSensitive: false, surface: 'groups' }) as Tool[]).find(t => t.name === `buildd_${GUIDANCE_GROUP}`)!;
    expect(tool.inputSchema!.properties!.params.properties.topic.type).toBe('string');
  });
});

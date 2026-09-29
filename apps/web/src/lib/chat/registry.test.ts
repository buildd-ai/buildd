import { describe, it, expect } from 'bun:test';
import { allActions } from '@buildd/core/mcp-tools';
import { ACTION_AREA } from '@buildd/core/mcp-tool-groups';
import { CHAT_APPROVAL_TOOLS, CHAT_READ_OPS, CHAT_READ_TOOLS } from '@buildd/shared';
import { CHAT_ROUTES, matchChatRoute } from './in-process-api';
import {
  ALL_CHAT_TOOL_SPECS, CHAT_NATIVE_TOOL_SPECS, CHAT_TOOL_SPECS, NOT_IN_CHAT, SELF_SCOPED_ALLOWLIST, TOOL_GROUPS, isExposed, opsOf,
} from './registry';
import { ENABLED_WRITE_OPS } from './tools';

/**
 * The classification is complete and consistent: every MCP action is placed
 * exactly once, every op names routes that exist (and so carry a reach
 * declaration, see reach-rules.test.ts), every write names its target, and
 * the client's copy of the classes matches the server's.
 */
describe('classification covers the whole MCP buildd surface', () => {
  it('every MCP action is a chat tool or listed in NOT_IN_CHAT — exactly one', () => {
    const missing = allActions.filter(a => !(a in CHAT_TOOL_SPECS) && !(a in NOT_IN_CHAT));
    const both = allActions.filter(a => a in CHAT_TOOL_SPECS && a in NOT_IN_CHAT);
    expect(missing).toEqual([]);
    expect(both).toEqual([]);
  });

  it('nothing is classified that MCP doesn\'t have (a rename fails here)', () => {
    const extra = [...Object.keys(CHAT_TOOL_SPECS), ...Object.keys(NOT_IN_CHAT)].filter(a => !(allActions as readonly string[]).includes(a));
    expect(extra).toEqual([]);
  });

  it('an MCP-backed chat tool takes its group from the shared action registry', () => {
    for (const [action, spec] of Object.entries(CHAT_TOOL_SPECS)) {
      expect(spec.group).toBe(ACTION_AREA[action as keyof typeof ACTION_AREA] as typeof spec.group);
    }
    // Worker-lifecycle actions (area `work`) are never chat tools.
    for (const [action, area] of Object.entries(ACTION_AREA)) if (area === 'work') expect(action in CHAT_TOOL_SPECS).toBe(false);
  });

  it('chat-native tools don\'t shadow an MCP action', () => {
    for (const a of Object.keys(CHAT_NATIVE_TOOL_SPECS)) expect(allActions as readonly string[]).not.toContain(a);
  });

  it('secret-bearing actions are never in chat and point at the settings screen', () => {
    expect(NOT_IN_CHAT.manage_secrets.reason).toBe('secret');
    for (const [, v] of Object.entries(NOT_IN_CHAT)) if (v.reason === 'secret') expect(v.deepLink).toMatch(/^\/app\/settings/);
  });
});

describe('every op is declared well enough to be enforced', () => {
  const declared = new Set(CHAT_ROUTES.flatMap(r => r.methods.map(m => `${m} ${r.pattern}`)));

  for (const [tool, spec] of Object.entries(ALL_CHAT_TOOL_SPECS)) {
    for (const [op, o] of opsOf(spec)) {
      const name = op ? `${tool}.${op}` : tool;
      it(`${name} (${o.class})`, () => {
        expect(TOOL_GROUPS as readonly string[]).toContain(spec.group);
        for (const r of o.routes) expect(declared.has(r) ? r : `${r} is not in CHAT_ROUTES`).toBe(r);
        if (o.class === 'write' || o.class === 'admin' || o.class === 'self') expect(o.target).toBeDefined();
        if (o.class === 'deferred') expect((o.deferredReason ?? '').length).toBeGreaterThan(10);
        if (o.class === 'read') {
          const writes = o.routes.filter(r => !r.startsWith('GET '));
          expect(writes).toEqual([]);
        }
      });
    }
  }

  it('every write route in CHAT_ROUTES is reachable only by some write, admin or self op', () => {
    const byWriteOps = new Set(Object.values(ALL_CHAT_TOOL_SPECS).flatMap(s => opsOf(s))
      .filter(([, o]) => o.class === 'write' || o.class === 'admin' || o.class === 'self').flatMap(([, o]) => o.routes));
    const writeRoutes = [...declared].filter(r => !r.startsWith('GET '));
    expect(writeRoutes.filter(r => !byWriteOps.has(r as never))).toEqual([]);
  });

  it('no self-scoped op runs without a card unless it is in the allowlist, and the allowlist is only self ops', () => {
    for (const key of SELF_SCOPED_ALLOWLIST) {
      const [tool, op = ''] = key.split('.');
      expect(ALL_CHAT_TOOL_SPECS[tool]?.ops[op]?.class).toBe('self');
    }
  });
});

describe('the client\'s copy of the classes matches the registry', () => {
  const exposed = Object.entries(ALL_CHAT_TOOL_SPECS).filter(([, s]) => isExposed(s));

  it('CHAT_READ_TOOLS = the single-op read tools', () => {
    const reads = exposed.filter(([, s]) => '' in s.ops && s.ops[''].class === 'read').map(([t]) => t).sort();
    expect([...CHAT_READ_TOOLS].sort()).toEqual(reads);
  });

  it('CHAT_READ_OPS = the read sub-actions of multi-op tools', () => {
    const reads: Record<string, string[]> = {};
    for (const [t, s] of exposed) {
      if ('' in s.ops) continue;
      const ops = opsOf(s).filter(([, o]) => o.class === 'read').map(([op]) => op);
      if (ops.length) reads[t] = ops;
    }
    expect(CHAT_READ_OPS).toEqual(reads);
  });

  it('CHAT_APPROVAL_TOOLS = the write ops chat offers', () => {
    const fromShared = Object.entries(CHAT_APPROVAL_TOOLS).flatMap(([t, ops]) => ops.map(op => (op ? `${t}.${op}` : t))).sort();
    expect(fromShared).toEqual([...ENABLED_WRITE_OPS].sort());
  });
});

describe('visual review from chat (docs/design/visual-qa-human-review.md, Chat)', () => {
  it('get_visual_review (the MCP action, run by chat\'s own link-free version) is a read that reaches only GET routes, the visual-review read among them', () => {
    const spec = CHAT_TOOL_SPECS.get_visual_review;
    expect(spec).toBeDefined();
    const op = spec.ops[''];
    expect(op.class).toBe('read');
    expect(op.routes).toContain('GET /api/missions/:id/visual-review');
    expect(op.routes.every(r => r.startsWith('GET '))).toBe(true);
    expect(CHAT_READ_TOOLS as readonly string[]).toContain('get_visual_review');
    expect(Object.keys(CHAT_APPROVAL_TOOLS)).not.toContain('get_visual_review');
  });

  it('the decisions routes are not reachable by any assistant tool, of any class', () => {
    const decisions = /\/visual-review\/decisions/;
    for (const [tool, spec] of Object.entries(ALL_CHAT_TOOL_SPECS)) {
      for (const [op, o] of opsOf(spec)) {
        const hit = o.routes.filter(r => decisions.test(r));
        expect(hit.length === 0 ? 'none' : `${tool}.${op} reaches ${hit.join(', ')}`).toBe('none');
      }
    }
    expect(CHAT_ROUTES.filter(r => decisions.test(r.pattern))).toEqual([]);
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(matchChatRoute(method, '/api/missions/m1/visual-review/decisions')).toBeNull();
      expect(matchChatRoute(method, '/api/missions/m1/visual-review/decisions/r1')).toBeNull();
    }
    // The read route is GET only from chat.
    expect(matchChatRoute('POST', '/api/missions/m1/visual-review')).toBeNull();
    expect(matchChatRoute('GET', '/api/missions/m1/visual-review')?.entry.pattern).toBe('/api/missions/:id/visual-review');
  });
});

describe('runner status from chat', () => {
  it('list_runners is a read in the workers group that reaches only GET /api/workers/active (and the workspace list)', () => {
    const op = CHAT_TOOL_SPECS.list_runners.ops[''];
    expect(CHAT_TOOL_SPECS.list_runners.group).toBe('workers');
    expect(op.class).toBe('read');
    expect([...op.routes].sort()).toEqual(['GET /api/workers/active', 'GET /api/workspaces']);
    expect(CHAT_READ_TOOLS as readonly string[]).toContain('list_runners');
  });
});

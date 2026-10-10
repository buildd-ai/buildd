/**
 * The action → group registry: every MCP action lands in exactly one group
 * tool, every action has a short line, and the compact signature shown in the
 * group tool names only params the long docs define.
 */
import { describe, it, expect } from 'bun:test';
import { allActions } from '../mcp-tools';
import {
  ACTION_AREA, ACTION_SUMMARY, MCP_TOOL_GROUPS, actionHelp, actionSignature, actionsOfGroup, derivedSignature,
  mcpGroupOf, mcpGroupOfToolName, mcpGroupToolName, mcpGroupPurpose, MCP_GROUP_PURPOSE_PARTS, SIGNATURE_OVERRIDE_ACTIONS,
  MCP_GROUP_PARAMS, mcpGroupParamsSchema, ACTION_LISTING, splitListed, requiredParamsOf,
} from '../mcp-tool-groups';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const names = (sig: string) =>
  sig.replace(/^\{|\}$/g, '').split(',').map(s => s.trim().split(/[:|+]/)[0].replace(/\?$/, '')).filter(n => n && n !== '…');

describe('no action is lost', () => {
  it('every action is in exactly one MCP group', () => {
    for (const a of allActions) {
      const holders = MCP_TOOL_GROUPS.filter(g => actionsOfGroup(g).includes(a));
      expect(holders.length, `${a} is in ${holders.join(', ') || 'no group'}`).toBe(1);
      expect(holders[0]).toBe(mcpGroupOf(a)!);
    }
  });

  it('the groups hold exactly allActions', () => {
    const held = MCP_TOOL_GROUPS.flatMap(g => actionsOfGroup(g)).sort();
    expect(held).toEqual([...allActions].sort());
  });

  it('the area table names only real actions', () => {
    expect(Object.keys(ACTION_AREA).sort()).toEqual([...allActions].sort());
  });

  it('worker-lifecycle actions are in the work group', () => {
    for (const a of ['claim_task', 'update_progress', 'complete_task', 'create_pr', 'upload_artifact', 'create_artifact', 'emit_event', 'post_note', 'query_events']) {
      expect(mcpGroupOf(a)).toBe('work');
    }
  });

  it('observability reads are in the analytics group', () => {
    for (const a of ['explain', 'list_runners', 'get_error_traces', 'get_failure_analytics', 'get_usage_stats', 'get_budget_forecast', 'get_manifest_coverage', 'get_path_claim_stats', 'get_decision_stats']) {
      expect(mcpGroupOf(a)).toBe('analytics');
    }
  });

  it('unknown actions have no group', () => {
    expect(mcpGroupOf('nope')).toBeNull();
    expect(mcpGroupOf('help')).toBeNull();
  });
});

describe('tool names', () => {
  it('round-trip buildd_<group>', () => {
    for (const g of MCP_TOOL_GROUPS) expect(mcpGroupOfToolName(mcpGroupToolName(g))).toBe(g);
    expect(mcpGroupOfToolName('buildd')).toBeNull();
    expect(mcpGroupOfToolName('buildd_memory')).toBeNull();
  });
});

describe('short text', () => {
  it('every action has a short summary', () => {
    for (const a of allActions) {
      expect(ACTION_SUMMARY[a]?.length ?? 0, a).toBeGreaterThan(5);
      expect(ACTION_SUMMARY[a].length, a).toBeLessThanOrEqual(90);
    }
  });

  it('every signature is compact', () => {
    for (const a of allActions) {
      const sig = actionSignature(a);
      expect(sig.startsWith('{') && sig.endsWith('}'), `${a}: ${sig}`).toBe(true);
      expect(sig.length, `${a}: ${sig}`).toBeLessThanOrEqual(300);
    }
  });

  it('a hand-written signature names only params the long docs define', () => {
    for (const a of SIGNATURE_OVERRIDE_ACTIONS) {
      const derived = new Set(names(derivedSignature(a)!));
      for (const n of names(actionSignature(a))) expect(derived.has(n) ? n : `${a}.${n} is not in the docs`).toBe(n);
    }
  });

  it('derived signatures keep required markers and sub-action values', () => {
    expect(actionSignature('get_task')).toBe('{taskId, include?, fullDescription?, all?}');
    expect(actionSignature('manage_secrets')).toContain('action: list|set|delete');
    expect(actionSignature('explain')).toContain('taskId?|missionId?');
  });
});

describe('group purpose', () => {
  it('each purpose fragment covers only actions of its group, and every action is covered exactly once', () => {
    for (const g of MCP_TOOL_GROUPS) {
      const covered = MCP_GROUP_PURPOSE_PARTS[g].parts.flatMap(p => p.actions);
      expect([...covered].sort(), g).toEqual([...actionsOfGroup(g)].sort());
    }
  });

  it('keeps only the fragments whose actions are listed', () => {
    expect(mcpGroupPurpose('missions', ['list_discrepancies'])).toBe('The spec discrepancy ledger.');
    const full = mcpGroupPurpose('missions', actionsOfGroup('missions'));
    expect(full).toContain('initiatives');
    expect(full).toContain('visual review');
    expect(full.endsWith('.')).toBe(true);
    expect(mcpGroupPurpose('work', ['emit_event'])).toBe('Your own task as a worker: record events.');
  });
});

describe('help', () => {
  it('returns the long docs of an action', () => {
    const h = actionHelp('create_pr')!;
    expect(h.startsWith('create_pr params: {')).toBe(true);
    expect(h).toContain('lede');
    expect(h.length).toBeGreaterThan(actionSignature('create_pr').length * 3);
  });

  it('is null for an unknown action', () => {
    expect(actionHelp('nope')).toBeNull();
  });
});

describe('typed params', () => {
  type Prop = { type?: string; description?: string; enum?: string[]; items?: { type?: string; properties?: Record<string, unknown> } };
  const props = (g: Parameters<typeof mcpGroupParamsSchema>[0], actions: readonly string[]) =>
    (mcpGroupParamsSchema(g, actions).properties ?? {}) as Record<string, Prop>;

  it('every field is tagged only with actions of its group, and each one names it in its long docs', () => {
    for (const g of MCP_TOOL_GROUPS) {
      for (const f of MCP_GROUP_PARAMS[g]) {
        expect(f.actions.length, `${g}.${f.name}`).toBeGreaterThan(0);
        for (const a of f.actions) {
          expect(mcpGroupOf(a), `${g}.${f.name} tags ${a}`).toBe(g);
          if (f.name === 'action') continue;
          expect(new RegExp(`\\b${f.name}\\b`).test(actionHelp(a)!), `${a} docs do not name ${f.name}`).toBe(true);
        }
      }
    }
  });

  it('every field has a type and one short description', () => {
    for (const g of MCP_TOOL_GROUPS) {
      for (const [name, p] of Object.entries(props(g, actionsOfGroup(g)))) {
        expect(typeof p.type, `${g}.${name}`).toBe('string');
        expect(p.description?.length ?? 0, `${g}.${name}`).toBeGreaterThan(3);
        expect(p.description!.length, `${g}.${name}: ${p.description}`).toBeLessThanOrEqual(170);
      }
    }
  });

  it('missions: the fields a mission question needs, typed', () => {
    const p = props('missions', actionsOfGroup('missions'));
    for (const n of ['action', 'missionId', 'missionTitle', 'title', 'query', 'workspaceId', 'status', 'priority', 'awaitingOnly', 'goalCriteria']) {
      expect(p[n], n).toBeDefined();
    }
    expect(p.autoSurfaceAudit?.type).toBe('boolean');
    expect(p.autoSurfaceAudit!.description!.toLowerCase()).toContain('visual');
    expect(p.autoVerify?.type).toBe('boolean');
    expect(p.awaitingOnly?.type).toBe('boolean');
    expect(p.priority?.type).toBe('number');
    expect(p.startMode?.enum).toEqual(['armed', 'held']);
    expect(p.goalCriteria?.type).toBe('array');
    expect(p.goalCriteria?.items?.type).toBe('object');
    expect(JSON.stringify(p.goalCriteria?.items)).toContain('all_prs_merged');
    for (const sub of ['list', 'get', 'update', 'create', 'arm', 'evaluate']) expect(p.action.description).toContain(sub);
    // Q2: get_visual_review with only a workspace lists what waits on you.
    expect(p.workspaceId.description).toMatch(/get_visual_review/);
    expect(p.workspaceId.description).toMatch(/awaiting your review/);
    // A title stands in for missionId, and the field says so.
    expect(p.missionId.description!.toLowerCase()).toContain('title');
  });

  it('runners, tasks: the common fields', () => {
    const r = props('analytics', actionsOfGroup('analytics'));
    expect(r.workspaceId.description!.toLowerCase()).toContain('browser');
    const t = props('tasks', actionsOfGroup('tasks'));
    for (const n of ['taskId', 'workspaceId', 'status', 'limit', 'include', 'title', 'priority']) expect(t[n], n).toBeDefined();
    expect(t.include?.type).toBe('array');
    expect(t.fullDescription?.type).toBe('boolean');
    expect(t.fullDescription.description).toContain('Full text');
    expect(t.status.description).toContain('cancelled');
  });

  it('a level that lists part of a group gets only the fields its actions take', () => {
    const p = props('missions', ['list_discrepancies', 'get_discrepancy']);
    expect(p.missionTitle).toBeUndefined();
    expect(p.autoSurfaceAudit).toBeUndefined();
    expect(p.workspaceId?.description ?? '').not.toContain('get_visual_review');
    expect(p.action?.description ?? '').not.toContain('manage_missions');
  });

  it('the schema is an open object: fields not typed still pass through', () => {
    const s = mcpGroupParamsSchema('missions', actionsOfGroup('missions')) as { type: string; additionalProperties?: unknown };
    expect(s.type).toBe('object');
    expect(s.additionalProperties).not.toBe(false);
  });
});

describe('a strict model can fill every group tool (task 6d3c3355)', () => {
  // A schema-constrained model emits only declared properties: a params
  // schema with no properties made it send {} for every buildd_work call.
  const declared = (g: Parameters<typeof mcpGroupParamsSchema>[0]) =>
    mcpGroupParamsSchema(g, actionsOfGroup(g)).properties as Record<string, unknown>;

  it('requiredParamsOf reads the non-optional names of a signature', () => {
    expect(requiredParamsOf('create_pr')).toEqual(['title', 'head', 'lede']);
    expect(requiredParamsOf('update_progress')).toEqual([]);
    expect(requiredParamsOf('manage_secrets')).toEqual(['action']);
    expect(requiredParamsOf('memory_delete')).toEqual(['id']);
  });

  it('every required param of every group action is a declared property', () => {
    // Listed actions: in the schema the tool sends. Rare (More:) actions: in
    // the group's params registry, so they appear once a level lists them.
    const missing: string[] = [];
    for (const g of MCP_TOOL_GROUPS) {
      const listed = mcpGroupParamsSchema(g, splitListed(actionsOfGroup(g)).listed).properties as Record<string, unknown>;
      const props = declared(g);
      for (const a of actionsOfGroup(g)) {
        const pool = splitListed(actionsOfGroup(g)).listed.includes(a) ? listed : props;
        for (const r of requiredParamsOf(a)) if (!pool[r]) missing.push(`${g}.${a}.${r}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('work declares the lifecycle fields a worker sends', () => {
    const p = declared('work');
    for (const n of ['taskId', 'progress', 'message', 'summary', 'error', 'structuredOutput', 'discardEdits',
      'title', 'head', 'lede', 'body', 'type', 'content', 'defaultChoice']) {
      expect(p[n], n).toBeDefined();
    }
  });

  it('every group params schema is explicitly open, so untyped fields still pass', () => {
    for (const g of MCP_TOOL_GROUPS) {
      expect((mcpGroupParamsSchema(g, actionsOfGroup(g)) as { additionalProperties?: unknown }).additionalProperties, g).toBe(true);
    }
  });
});

describe('listed and More: actions (ACTION_LISTING)', () => {
  const ROOT = join(import.meta.dir, '..', '..', '..');

  it('places every action, and only real ones', () => {
    expect(Object.keys(ACTION_LISTING).sort()).toEqual([...allActions].sort());
  });

  it('splits a group without losing or reordering an action', () => {
    for (const g of MCP_TOOL_GROUPS) {
      const actions = actionsOfGroup(g);
      const { listed, more } = splitListed(actions);
      expect([...listed, ...more].sort()).toEqual([...actions].sort());
      expect(listed).toEqual(actions.filter(a => ACTION_LISTING[a] === 'listed'));
    }
  });

  it('lists every action a skill, role prompt or runner prompt tells agents to call', () => {
    // Workflow text agents act on. An action named here must have its own line,
    // or the agent reading the workflow cannot find its params without a detour.
    const files = [
      ...[...new Bun.Glob('.claude/skills/*/{SKILL,CLAUDE}.md').scanSync({ cwd: ROOT, dot: true })],
      ...[...new Bun.Glob('packages/core/onboarding-templates/*').scanSync({ cwd: ROOT })],
      'apps/runner/src/prompt-builder.ts',
      'apps/web/src/lib/default-roles.ts',
      'apps/web/src/lib/mission-context.ts',
      'apps/web/src/lib/heartbeat-helpers.ts',
    ];
    expect(files.length).toBeGreaterThan(6);
    const named = new Map<string, string>();
    for (const f of files) {
      const body = readFileSync(join(ROOT, f), 'utf8');
      for (const a of allActions) if (new RegExp(`\\b${a}\\b`).test(body) && !named.has(a)) named.set(a, f);
    }
    expect(named.size).toBeGreaterThan(10);
    for (const [a, f] of named) expect(ACTION_LISTING[a as keyof typeof ACTION_LISTING], `${a} (named in ${f})`).toBe('listed');
  });
});

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
} from '../mcp-tool-groups';

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

  it('fleet-health reads are in the runners group', () => {
    for (const a of ['explain', 'list_runners', 'get_error_traces', 'get_failure_analytics', 'get_usage_stats']) {
      expect(mcpGroupOf(a)).toBe('runners');
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
    expect(actionSignature('get_task')).toBe('{taskId, include?}');
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

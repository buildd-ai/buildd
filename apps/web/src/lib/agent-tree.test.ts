import { describe, it, expect } from 'bun:test';
import {
  buildAgentTree,
  flattenAgentTree,
  MAX_AGENT_TREE_DEPTH,
  type AgentProgressEntry,
} from './agent-tree';

function entry(overrides: Partial<AgentProgressEntry> & { taskId: string }): AgentProgressEntry {
  return {
    agentName: null,
    toolCount: 0,
    durationMs: 0,
    cumulativeUsage: null,
    ...overrides,
  };
}

describe('buildAgentTree', () => {
  it('returns entries without a parent as roots', () => {
    const roots = buildAgentTree([
      entry({ taskId: 't1', agentId: 'a1' }),
      entry({ taskId: 't2', agentId: 'a2' }),
    ]);
    expect(roots.map((r) => r.taskId)).toEqual(['t1', 't2']);
    expect(roots.every((r) => r.depth === 0 && r.children.length === 0)).toBe(true);
  });

  it('nests a child under its parent by parentAgentId', () => {
    const roots = buildAgentTree([
      entry({ taskId: 'parent', agentId: 'a1' }),
      entry({ taskId: 'child', agentId: 'a2', parentAgentId: 'a1' }),
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0].taskId).toBe('parent');
    expect(roots[0].children.map((c) => c.taskId)).toEqual(['child']);
    expect(roots[0].children[0].depth).toBe(1);
  });

  it('builds a depth-2 tree (grandchild)', () => {
    const roots = buildAgentTree([
      entry({ taskId: 'g0', agentId: 'a1' }),
      entry({ taskId: 'g1', agentId: 'a2', parentAgentId: 'a1' }),
      entry({ taskId: 'g2', agentId: 'a3', parentAgentId: 'a2' }),
    ]);
    const flat = flattenAgentTree(roots);
    expect(flat.map((n) => [n.taskId, n.depth])).toEqual([
      ['g0', 0],
      ['g1', 1],
      ['g2', 2],
    ]);
  });

  it('surfaces a child whose parent is not present as a root', () => {
    const roots = buildAgentTree([
      entry({ taskId: 'orphan', agentId: 'a2', parentAgentId: 'missing' }),
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0].taskId).toBe('orphan');
    expect(roots[0].depth).toBe(0);
  });

  it('treats a self-referencing entry as a root (no infinite loop)', () => {
    const roots = buildAgentTree([entry({ taskId: 's', agentId: 'a1', parentAgentId: 'a1' })]);
    expect(roots).toHaveLength(1);
    expect(roots[0].taskId).toBe('s');
  });

  it('does not drop nodes in a 2-cycle', () => {
    const roots = buildAgentTree([
      entry({ taskId: 'x', agentId: 'a1', parentAgentId: 'a2' }),
      entry({ taskId: 'y', agentId: 'a2', parentAgentId: 'a1' }),
    ]);
    const flat = flattenAgentTree(roots);
    expect(new Set(flat.map((n) => n.taskId))).toEqual(new Set(['x', 'y']));
  });

  it('preserves sibling input order', () => {
    const roots = buildAgentTree([
      entry({ taskId: 'p', agentId: 'a1' }),
      entry({ taskId: 'c2', agentId: 'a3', parentAgentId: 'a1' }),
      entry({ taskId: 'c1', agentId: 'a2', parentAgentId: 'a1' }),
    ]);
    expect(roots[0].children.map((c) => c.taskId)).toEqual(['c2', 'c1']);
  });

  it('caps depth for a pathological chain', () => {
    const entries: AgentProgressEntry[] = [];
    for (let i = 0; i < MAX_AGENT_TREE_DEPTH + 4; i++) {
      entries.push(
        entry({
          taskId: `n${i}`,
          agentId: `a${i}`,
          parentAgentId: i === 0 ? undefined : `a${i - 1}`,
        }),
      );
    }
    const flat = flattenAgentTree(buildAgentTree(entries));
    expect(flat).toHaveLength(entries.length);
    expect(Math.max(...flat.map((n) => n.depth))).toBe(MAX_AGENT_TREE_DEPTH);
  });

  it('handles the pre-0.3.202 case (no agent ids) as a flat list', () => {
    const roots = buildAgentTree([
      entry({ taskId: 't1' }),
      entry({ taskId: 't2' }),
      entry({ taskId: 't3' }),
    ]);
    expect(roots.map((r) => r.taskId)).toEqual(['t1', 't2', 't3']);
    expect(roots.every((r) => r.depth === 0)).toBe(true);
  });
});

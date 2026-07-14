/**
 * Build a nested agent tree from the flat subagent-progress entries the runner
 * forwards over Pusher (the transient `taskProgress` channel).
 *
 * The Claude Agent SDK v0.3.202+ stamps subagent session messages with a
 * `parent_agent_id`, enabling agent trees deeper than one level (a subagent
 * that itself spawns subagents). Before that, subagents could only be rendered
 * as a flat list. This helper reconstructs the hierarchy so the task view can
 * indent nested agents under their parent.
 *
 * Pure and dependency-free so it can be unit-tested in isolation.
 */

export interface AgentProgressEntry {
  taskId: string;
  agentName: string | null;
  toolCount: number;
  durationMs: number;
  cumulativeUsage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
  /** This agent's SDK id, when known (v0.3.202+). */
  agentId?: string;
  /** The spawning agent's id, when known (v0.3.202+). */
  parentAgentId?: string;
}

export interface AgentNode extends AgentProgressEntry {
  children: AgentNode[];
  /** 0 for roots; capped so a pathological chain can't blow out the layout. */
  depth: number;
}

/** Hard cap on visual nesting depth; deeper nodes render flattened at this depth. */
export const MAX_AGENT_TREE_DEPTH = 6;

/**
 * Reconstruct the agent hierarchy. Entries whose `parentAgentId` matches another
 * entry's `agentId` become that node's children; everything else (no parent, an
 * unknown parent, a self-reference, or a cycle) is rendered at the root. Input
 * order is preserved among siblings for stable rendering.
 */
export function buildAgentTree(entries: AgentProgressEntry[]): AgentNode[] {
  const nodeByAgentId = new Map<string, AgentNode>();
  const order: AgentNode[] = [];

  // Materialize a node per entry, indexed by agentId when present.
  for (const e of entries) {
    const node: AgentNode = { ...e, children: [], depth: 0 };
    order.push(node);
    if (e.agentId) nodeByAgentId.set(e.agentId, node);
  }

  // Effective parent per node: a present, non-self agent. Anything else (no
  // parent id, unknown parent, self-reference) makes the node a root.
  const parentOf = new Map<AgentNode, AgentNode | undefined>();
  for (const node of order) {
    const p = node.parentAgentId ? nodeByAgentId.get(node.parentAgentId) : undefined;
    parentOf.set(node, p && p !== node ? p : undefined);
  }

  // Raw parent→children adjacency (may contain cycles), preserving input order.
  const rawChildren = new Map<AgentNode, AgentNode[]>();
  for (const node of order) {
    const p = parentOf.get(node);
    if (!p) continue;
    const list = rawChildren.get(p) ?? [];
    list.push(node);
    rawChildren.set(p, list);
  }

  // Emit an ACYCLIC tree: attach a child only if not already visited, so a
  // back-edge in a cycle is dropped rather than reproduced in `children`.
  const visited = new Set<AgentNode>();
  const roots: AgentNode[] = [];
  const attach = (node: AgentNode, depth: number) => {
    visited.add(node);
    node.depth = Math.min(depth, MAX_AGENT_TREE_DEPTH);
    for (const kid of rawChildren.get(node) ?? []) {
      if (visited.has(kid)) continue;
      node.children.push(kid);
      attach(kid, depth + 1);
    }
  };

  // True roots first (in input order), then any remaining unvisited node —
  // which can only be a cycle member — promoted to a root so nothing is lost.
  for (const node of order) {
    if (!parentOf.get(node) && !visited.has(node)) {
      roots.push(node);
      attach(node, 0);
    }
  }
  for (const node of order) {
    if (!visited.has(node)) {
      roots.push(node);
      attach(node, 0);
    }
  }

  return roots;
}

/** Flatten a tree depth-first into render rows, preserving nesting via `depth`. */
export function flattenAgentTree(roots: AgentNode[]): AgentNode[] {
  const rows: AgentNode[] = [];
  const walk = (node: AgentNode) => {
    rows.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return rows;
}

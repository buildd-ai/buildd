import { titleLines, type GraphNode, type NeighbourGraph } from '@/lib/specs/index-view';

/**
 * A spec's neighbour graph (living-specs.md §19 R-28), the secondary view of
 * Related: the spec in the middle, its parent above, siblings on the left
 * (joined to the parent) and up to 8 neighbours on the right, each node
 * saying its relation in words. Inline SVG in theme tokens, nodes are links.
 * Wide screens only; below that the list carries the same entries (R-29).
 */
const W = 720;
const NODE_W = 168;
const NODE_H = 62;
const ROW = 72;
const COL = { left: 16, mid: (W - NODE_W) / 2, right: W - NODE_W - 16 };

function Node({ node, x, y, self = false }: { node: GraphNode; x: number; y: number; self?: boolean }) {
  const body = (
    <g data-testid="spec-graph-node" data-spec-id={node.id} data-relation={node.relation}>
      <title>{`${node.title} (${node.relation})`}</title>
      <rect
        x={x} y={y} width={NODE_W} height={NODE_H} rx={4}
        fill="var(--card)" stroke={self ? 'var(--text-primary)' : 'var(--border-strong)'} strokeWidth={self ? 1.5 : 1}
      />
      <text x={x + 10} y={y + 20} fontSize={13} fontWeight={600} fill="var(--text-primary)">
        {titleLines(node.title).map((l, i) => <tspan key={i} x={x + 10} dy={i ? 16 : 0}>{l}</tspan>)}
      </text>
      <text x={x + 10} y={y + 52} fontSize={12} fill="var(--text-secondary)">{node.relation}</text>
    </g>
  );
  return node.href ? <a href={node.href} aria-label={`${node.title}, ${node.relation}`}>{body}</a> : body;
}

const edge = (x1: number, y1: number, x2: number, y2: number, key: string) => (
  <path key={key} d={`M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`} fill="none" stroke="var(--border-strong)" strokeWidth={1} />
);

export default function SpecNeighbourGraph({ graph }: { graph: NeighbourGraph }) {
  const sides = Math.max(graph.siblings.length, graph.neighbours.length, 1);
  const top = graph.parent ? NODE_H + 28 : 0;
  const height = Math.max(top + NODE_H + 16, top + sides * ROW);
  const selfY = top + Math.max(0, (sides * ROW - ROW) / 2);
  const sideY = (i: number) => top + i * ROW;
  const parentY = 0;

  const edges = [
    ...(graph.parent ? [edge(COL.mid + NODE_W / 2, parentY + NODE_H, COL.mid + NODE_W / 2, selfY, 'p')] : []),
    ...graph.siblings.map((s, i) => edge(COL.left + NODE_W, sideY(i) + NODE_H / 2, COL.mid, parentY + NODE_H / 2, `s${s.id}`)),
    ...graph.neighbours.map((n, i) => edge(COL.mid + NODE_W, selfY + NODE_H / 2, COL.right, sideY(i) + NODE_H / 2, `n${n.id}`)),
  ];
  const omitted = [
    graph.omittedSiblings ? `${graph.omittedSiblings} more siblings` : null,
    graph.omittedNeighbours ? `${graph.omittedNeighbours} more neighbours` : null,
  ].filter(Boolean);

  return (
    <figure className="flex flex-col gap-1" data-testid="spec-graph">
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={`${graph.self.title} and the specs related to it`} className="max-w-full">
        {edges}
        {graph.parent ? <Node node={graph.parent} x={COL.mid} y={parentY} /> : null}
        <Node node={graph.self} x={COL.mid} y={selfY} self />
        {graph.siblings.map((s, i) => <Node key={s.id} node={s} x={COL.left} y={sideY(i)} />)}
        {graph.neighbours.map((n, i) => <Node key={n.id} node={n} x={COL.right} y={sideY(i)} />)}
      </svg>
      {omitted.length ? <figcaption className="text-meta text-text-muted">The list shows {omitted.join(' and ')}.</figcaption> : null}
    </figure>
  );
}

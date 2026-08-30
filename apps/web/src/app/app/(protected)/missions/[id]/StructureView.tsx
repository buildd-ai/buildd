'use client';

import { useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { StageChip } from '@/components/StageChip';
import { SegmentStrip } from '@/components/SegmentStrip';
import {
  computeStructureLayout,
  computeEdgeSetFingerprint,
  COL_WIDTH,
  ROW_HEIGHT,
  type ContentionEdge,
  type StructureNode,
  type StructureEdge,
  type StructureTask,
} from '@/lib/structure-layout';
import type { CondensedTask, ChainUnit } from '@/lib/condensed-timeline';
import type { Stage } from '@/lib/stage';

// ─── Types ────────────────────────────────────────────────────────────────────

export type StructureViewProps<T extends StructureTask = StructureTask> = {
  chains: ChainUnit<T>[];
  taskMap: Map<string, CondensedTask>;
  missionId: string;
  contentionEdges?: ContentionEdge[];
  retryLinks?: Map<string, string>;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_WIDTH = 180;
const NODE_WIDTH_CHAIN = 340;
const NODE_HEIGHT = 84;
const EDGE_CTRL_OFFSET = 60;

// Stage → fill/border CSS classes (spec §5.1)
const STAGE_NODE_CLS: Record<Stage, string> = {
  SUBJECT_DEAD:  'bg-status-error/8 border-status-error/40 border-dashed',
  MISSION_BUDGET:'bg-status-error/8 border-status-error/40 border-dashed',
  BLOCKED:       'bg-status-warning/15 border-status-warning border-2',
  QUEUED:        'bg-transparent border-border-default',
  RUNNING:       'bg-status-running/15 border-status-running border-2 animate-pulse-border',
  WAITING_INPUT: 'bg-status-warning/15 border-status-warning border-2 border-dashed',
  REVIEWING:     'bg-status-info/10 border-status-info',
  OPEN:          'bg-accent/10 border-accent',
  CI:            'bg-accent/10 border-accent',
  MERGE:         'bg-accent/10 border-accent',
  VERIFY:        'bg-accent/10 border-accent',
  DONE:          'bg-status-success/10 border-status-success',
  FAILED:        'bg-status-error/15 border-status-error border-2',
  CANCELLED:     'bg-transparent border-border-default opacity-50',
};

// STRANDED notch pattern overlay (spec §5.2)
const STRANDED_OVERLAY = 'bg-[linear-gradient(45deg,transparent_42%,currentColor_43%_57%,transparent_58%)] text-status-error/8 absolute inset-0';

// Edge stroke styles
const EDGE_STROKE: Record<string, { stroke: string; strokeWidth: number; strokeDasharray?: string; opacity: number }> = {
  dependsOn: { stroke: 'var(--color-status-warning)', strokeWidth: 1.5, opacity: 1 },
  retry:     { stroke: 'var(--color-text-muted)',     strokeWidth: 1,   strokeDasharray: '4 2', opacity: 0.8 },
  contention:{ stroke: 'var(--color-status-error)',   strokeWidth: 1.5, strokeDasharray: '2 2 6 2', opacity: 0.6 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Cubic bezier SVG path string for a left-to-right edge. */
function edgePath(
  sx: number, sy: number,
  tx: number, ty: number,
): string {
  const cp1x = sx + EDGE_CTRL_OFFSET;
  const cp2x = tx - EDGE_CTRL_OFFSET;
  return `M ${sx},${sy} C ${cp1x},${sy} ${cp2x},${ty} ${tx},${ty}`;
}

/** Compute upstream and downstream task ids for a given node id, following dependsOn edges. */
function computeAdjacency(
  selectedNodeId: string,
  edges: StructureEdge[],
): { upstream: Set<string>; downstream: Set<string> } {
  const upstream = new Set<string>();
  const downstream = new Set<string>();

  // BFS upstream (following edges backwards: target → source)
  const upQueue = [selectedNodeId];
  while (upQueue.length > 0) {
    const cur = upQueue.shift()!;
    for (const e of edges) {
      if (e.class !== 'dependsOn') continue;
      if (e.targetNodeId === cur && !upstream.has(e.sourceNodeId)) {
        upstream.add(e.sourceNodeId);
        upQueue.push(e.sourceNodeId);
      }
    }
  }

  // BFS downstream (following edges forwards: source → target)
  const downQueue = [selectedNodeId];
  while (downQueue.length > 0) {
    const cur = downQueue.shift()!;
    for (const e of edges) {
      if (e.class !== 'dependsOn') continue;
      if (e.sourceNodeId === cur && !downstream.has(e.targetNodeId)) {
        downstream.add(e.targetNodeId);
        downQueue.push(e.targetNodeId);
      }
    }
  }

  return { upstream, downstream };
}

// ─── Node component ───────────────────────────────────────────────────────────

function StructureNodeView({
  node,
  isSelected,
  selectionClass,
  onSelect,
  onExpand,
}: {
  node: StructureNode<StructureTask>;
  isSelected: boolean;
  selectionClass: 'selected' | 'upstream' | 'downstream' | 'unrelated' | null;
  onSelect: (id: string) => void;
  onExpand?: (id: string) => void;
}) {
  const nodeWidth = node.isCollapsed ? NODE_WIDTH_CHAIN : NODE_WIDTH;

  let containerCls = 'absolute border font-mono select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-opacity';

  // Fill / border based on stage (STRANDED overrides border style)
  const stageCls = node.isStranded
    ? 'bg-status-error/8 border-status-error/40 border border-dashed'
    : STAGE_NODE_CLS[node.stage] ?? 'bg-transparent border-border-default';

  containerCls += ' ' + stageCls;

  // Selection overlay
  if (selectionClass === 'selected') {
    containerCls += ' ring-2 ring-accent bg-accent/5';
  } else if (selectionClass === 'upstream') {
    containerCls += ' ring-1 ring-status-warning/50 bg-status-warning/8';
  } else if (selectionClass === 'downstream') {
    containerCls += ' ring-1 ring-status-info/50 bg-status-info/8';
  } else if (selectionClass === 'unrelated') {
    containerCls += ' opacity-50';
  }

  const headTask = node.tasks[0];

  return (
    <div
      role="button"
      tabIndex={0}
      aria-selected={isSelected}
      aria-label={`${node.label} — ${node.stage}`}
      className={containerCls}
      style={{
        left: node.x,
        top: node.y,
        width: nodeWidth,
        height: NODE_HEIGHT,
        padding: '8px 10px',
      }}
      onClick={() => {
        if (node.isCollapsed && onExpand) {
          // First click expands; selection is separate (Space key)
        }
        onSelect(node.id);
      }}
      onKeyDown={e => {
        if (e.key === ' ') { e.preventDefault(); onSelect(node.id); }
        if (e.key === 'Enter' && headTask) {
          window.location.href = `/app/tasks/${headTask.id}`;
        }
        if (e.key === 'Escape') onSelect('');
      }}
    >
      {/* STRANDED notch overlay */}
      {node.isStranded && <div className={STRANDED_OVERLAY} aria-hidden />}

      {/* Role dot */}
      <div className="flex items-center gap-1.5 mb-1 relative z-10">
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: node.roleColor }}
        />
        <span className="text-[10px] text-text-muted truncate font-mono flex-1 min-w-0">
          {truncate(node.label, node.isCollapsed ? 36 : 28)}
        </span>
        {/* Task detail link */}
        {headTask && (
          <Link
            href={`/app/tasks/${headTask.id}`}
            className="text-[9px] text-text-muted hover:text-accent ml-auto shrink-0"
            onClick={e => e.stopPropagation()}
            tabIndex={-1}
            aria-label="Open task detail"
          >
            ↗
          </Link>
        )}
      </div>

      {/* Stage chip */}
      <div className="relative z-10 mb-1">
        <StageChip
          stage={node.stage}
          loopState={node.loopState as any}
          loopMaxLoops={node.loopMaxLoops}
          loopIteration={node.loopIteration}
          startAt={node.startAt}
          loopExitConditionType={node.loopExitConditionType}
        />
      </div>

      {/* SegmentStrip — only for collapsed chains */}
      {node.isCollapsed && node.segments.length > 1 && (
        <div className="relative z-10">
          <SegmentStrip
            segments={node.segments.map(s => ({
              taskId: s.taskId,
              state: s.state === 'solid' ? 'filled' :
                     s.state === 'ghost' ? 'current' :
                     s.state === 'half'  ? 'half' :
                     s.state === 'notch' ? 'notch' : 'empty',
            }))}
            continuous={node.segments.length > 8}
            label={`Chain progress: ${node.segments.length} tasks`}
          />
        </div>
      )}

      {/* Expand affordance for collapsed chains */}
      {node.isCollapsed && onExpand && (
        <button
          className="absolute bottom-1 right-2 text-[9px] text-text-muted hover:text-accent font-mono"
          onClick={e => { e.stopPropagation(); onExpand(node.id); }}
          tabIndex={-1}
          aria-label={`Expand chain of ${node.chainLength} tasks`}
        >
          expand ▸
        </button>
      )}
    </div>
  );
}

// ─── StructureView ────────────────────────────────────────────────────────────

export default function StructureView<T extends StructureTask>({
  chains,
  taskMap,
  missionId: _missionId,
  contentionEdges,
  retryLinks,
}: StructureViewProps<T>) {
  const [expandedChainHeadIds, setExpandedChainHeadIds] = useState<Set<string>>(new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showRetries, setShowRetries] = useState(true);
  const [showContention, setShowContention] = useState(false);

  // Fingerprint of the dependsOn edge-set — stable across status changes.
  // Computed every render (cheap) and used as the memoization key for layout.
  const fingerprint = computeEdgeSetFingerprint(chains as ChainUnit<StructureTask>[], taskMap);

  // Layout — recomputed only when edge-set, expansion state, or toggle state changes
  const layout = useMemo(
    () => computeStructureLayout(
      chains as ChainUnit<StructureTask>[],
      taskMap,
      expandedChainHeadIds,
      { retryLinks, contentionEdges, showRetries, showContention },
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fingerprint, expandedChainHeadIds, showRetries, showContention],
  );

  // Selection adjacency
  const { upstream, downstream } = useMemo(() => {
    if (!selectedNodeId) return { upstream: new Set<string>(), downstream: new Set<string>() };
    return computeAdjacency(selectedNodeId, layout.edges);
  }, [selectedNodeId, layout.edges]);

  const handleSelect = useCallback((nodeId: string) => {
    setSelectedNodeId(prev => prev === nodeId || nodeId === '' ? null : nodeId);
  }, []);

  const handleExpand = useCallback((headId: string) => {
    setExpandedChainHeadIds(prev => {
      const next = new Set(prev);
      if (next.has(headId)) next.delete(headId);
      else next.add(headId);
      return next;
    });
  }, []);

  // Canvas dimensions
  const maxRank = layout.nodes.reduce((m, n) => Math.max(m, n.rank), 0);
  const maxPos = layout.nodes.reduce((m, n) => Math.max(m, n.pos), 0);
  const canvasWidth = Math.max(800, (maxRank + 1) * COL_WIDTH + NODE_WIDTH_CHAIN + 40);
  const canvasHeight = Math.max(400, (maxPos + 1) * ROW_HEIGHT + NODE_HEIGHT + 40);

  const hasRetryEdges = layout.edges.some(e => e.class === 'retry');
  const hasContention = !!contentionEdges && contentionEdges.length > 0;

  // Check if layout is empty
  if (layout.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-text-muted text-[13px] font-mono">
        No tasks in this mission
      </div>
    );
  }

  return (
    <div className="hidden md:block">
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-3 px-1">
        <span className="text-[11px] text-text-muted font-mono uppercase tracking-wider">Structure</span>
        <div className="flex items-center gap-2 ml-auto">
          {hasRetryEdges && (
            <button
              className={`text-[11px] font-mono px-2 py-0.5 border transition-colors ${
                showRetries
                  ? 'border-text-muted text-text-secondary bg-surface-2'
                  : 'border-border-default text-text-muted'
              }`}
              onClick={() => setShowRetries(v => !v)}
            >
              {showRetries ? 'Hide' : 'Show'} retries
            </button>
          )}
          {hasContention && (
            <button
              className={`text-[11px] font-mono px-2 py-0.5 border transition-colors ${
                showContention
                  ? 'border-status-error/60 text-status-error bg-status-error/5'
                  : 'border-border-default text-text-muted'
              }`}
              onClick={() => setShowContention(v => !v)}
            >
              {showContention ? 'Hide' : 'Show'} file conflicts
            </button>
          )}
          {selectedNodeId && (
            <button
              className="text-[11px] font-mono px-2 py-0.5 border border-border-default text-text-muted hover:text-text-secondary"
              onClick={() => setSelectedNodeId(null)}
            >
              Clear selection
            </button>
          )}
        </div>
      </div>

      {/* Scrollable canvas */}
      <div
        className="overflow-auto border border-border-default bg-surface-1"
        style={{ maxHeight: 'min(70vh, 640px)' }}
      >
        <div
          className="relative"
          style={{ width: canvasWidth, height: canvasHeight }}
          onClick={e => {
            // Click on empty canvas clears selection
            if (e.target === e.currentTarget) setSelectedNodeId(null);
          }}
        >
          {/* SVG edges */}
          <svg
            className="absolute inset-0 pointer-events-none overflow-visible"
            style={{ width: canvasWidth, height: canvasHeight }}
            aria-hidden
          >
            <defs>
              {/* Arrow marker for dependsOn edges */}
              <marker
                id="arrow-depends"
                markerWidth="8"
                markerHeight="6"
                refX="8"
                refY="3"
                orient="auto"
              >
                <polygon
                  points="0 0, 8 3, 0 6"
                  fill="var(--color-status-warning)"
                  opacity="0.9"
                />
              </marker>
            </defs>

            {layout.edges.map(edge => {
              const srcNode = layout.nodes.find(n => n.id === edge.sourceNodeId);
              const tgtNode = layout.nodes.find(n => n.id === edge.targetNodeId);
              if (!srcNode || !tgtNode) return null;

              const srcWidth = srcNode.isCollapsed ? NODE_WIDTH_CHAIN : NODE_WIDTH;
              const sx = srcNode.x + srcWidth;
              const sy = srcNode.y + NODE_HEIGHT / 2;
              const tx = tgtNode.x;
              const ty = tgtNode.y + NODE_HEIGHT / 2;

              const style = EDGE_STROKE[edge.class] ?? EDGE_STROKE.dependsOn;

              // Dim edges not in selection path
              let opacity = style.opacity;
              if (selectedNodeId) {
                const isRelated =
                  edge.sourceNodeId === selectedNodeId ||
                  edge.targetNodeId === selectedNodeId ||
                  upstream.has(edge.sourceNodeId) ||
                  downstream.has(edge.targetNodeId);
                if (!isRelated) opacity = 0.3 * style.opacity;
              }

              return (
                <path
                  key={edge.id}
                  d={edgePath(sx, sy, tx, ty)}
                  fill="none"
                  stroke={style.stroke}
                  strokeWidth={style.strokeWidth}
                  strokeDasharray={style.strokeDasharray}
                  opacity={opacity}
                  markerEnd={edge.class === 'dependsOn' ? 'url(#arrow-depends)' : undefined}
                >
                  {edge.class === 'contention' && edge.contentionPaths && (
                    <title>File conflict detected — both tasks touched {edge.contentionPaths.join(', ')}</title>
                  )}
                </path>
              );
            })}
          </svg>

          {/* Nodes */}
          {layout.nodes.map(node => {
            let selectionClass: 'selected' | 'upstream' | 'downstream' | 'unrelated' | null = null;
            if (selectedNodeId) {
              if (node.id === selectedNodeId) selectionClass = 'selected';
              else if (upstream.has(node.id)) selectionClass = 'upstream';
              else if (downstream.has(node.id)) selectionClass = 'downstream';
              else selectionClass = 'unrelated';
            }

            return (
              <StructureNodeView
                key={node.id}
                node={node}
                isSelected={node.id === selectedNodeId}
                selectionClass={selectionClass}
                onSelect={handleSelect}
                onExpand={node.isCollapsed ? handleExpand : undefined}
              />
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-2 px-1">
        <div className="flex items-center gap-1.5">
          <svg width="24" height="8" className="shrink-0">
            <line x1="0" y1="4" x2="24" y2="4" stroke="var(--color-status-warning)" strokeWidth="1.5" />
          </svg>
          <span className="text-[10px] text-text-muted font-mono">depends on</span>
        </div>
        {hasRetryEdges && showRetries && (
          <div className="flex items-center gap-1.5">
            <svg width="24" height="8" className="shrink-0">
              <line x1="0" y1="4" x2="24" y2="4" stroke="var(--color-text-muted)" strokeWidth="1" strokeDasharray="4 2" />
            </svg>
            <span className="text-[10px] text-text-muted font-mono">retry</span>
          </div>
        )}
        {hasContention && showContention && (
          <div className="flex items-center gap-1.5">
            <svg width="24" height="8" className="shrink-0">
              <line x1="0" y1="4" x2="24" y2="4" stroke="var(--color-status-error)" strokeWidth="1.5" strokeDasharray="2 2 6 2" opacity="0.6" />
            </svg>
            <span className="text-[10px] text-text-muted font-mono">file conflict</span>
          </div>
        )}
      </div>
    </div>
  );
}

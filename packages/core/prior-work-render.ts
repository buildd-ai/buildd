/**
 * Shared "prior work" rendering — the PR #1771 renderer (title | status | PR ref |
 * age | score, plus the stale-baseline flag). Lives here, not in apps/web, so both
 * the app's mission/heartbeat context builder (`apps/web/src/lib/knowledge-context.ts`)
 * and the MCP tool handlers (`create_task`, `manage_missions create` in mcp-tools.ts,
 * same package) render hits identically instead of maintaining two renderers.
 */

import { buildNamespace } from './knowledge-store/pg-vector-store';
import type { KnowledgeStore, QueryResult } from './knowledge-store/types';

export const STALE_BASELINE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function ageLabel(date: Date | null | undefined): string {
  if (!date) return '';
  const days = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function renderHit(r: QueryResult): string {
  const firstLine = r.content.split('\n').find(l => l.trim()) ?? '';
  const title = firstLine.replace(/^#+\s*/, '').slice(0, 100);
  const parts: string[] = [`[${r.score.toFixed(2)}]`, title];

  if (r.sourceType === 'task') {
    const success = r.metadata?.success;
    parts.push(success === true ? 'completed' : success === false ? 'failed' : 'task');
  } else if (r.sourceType === 'pr') {
    const prNum = r.metadata?.prNumber;
    parts.push(prNum ? `PR #${prNum}` : 'PR');
  }

  // For task hits: surface PR reference from metadata
  const prUrl = r.metadata?.prUrl as string | undefined;
  if (prUrl && r.sourceType === 'task') {
    const match = /[/#](\d+)$/.exec(prUrl);
    parts.push(match ? `PR #${match[1]}` : 'has PR');
  }

  const age = ageLabel(r.createdAt);
  if (age) parts.push(age);

  const link = r.sourceUrl ? ` (${r.sourceUrl})` : '';
  return `- ${parts.join(' | ')}${link}`;
}

export function isStaleBaseline(r: QueryResult): boolean {
  if (r.sourceType !== 'task') return false;
  if (r.metadata?.success !== true) return false;
  if (!r.metadata?.prUrl) return false;
  if (!r.createdAt) return false;
  return Date.now() - new Date(r.createdAt).getTime() < STALE_BASELINE_WINDOW_MS;
}

/**
 * Render a hit and, where it applies, the stale-baseline warning underneath it.
 *
 * Returned as a group and kept as a group: a budget that truncates between a hit
 * and its "MAY ALREADY BE SHIPPED" warning would show the hit while silently
 * dropping the reason not to trust it.
 */
export function renderHitLines(r: QueryResult): string[] {
  const lines = [renderHit(r)];
  if (isStaleBaseline(r)) {
    lines.push(
      '  ⚠ MAY ALREADY BE SHIPPED — read the merged diff before specing.' +
      ' Merged code may not be released, so the UI is not evidence.',
    );
  }
  return lines;
}

/** Minimal store shape buildAuthoringPriorWork needs — KnowledgeStore satisfies it. */
export type PriorWorkQuerier = Pick<KnowledgeStore, 'query'>;

const AUTHORING_MAX_HITS = 5;
// Precision floor per spec artifact f14a3d02 — below this, a hit reads as noise
// rather than a genuine incident to check before filing.
const AUTHORING_MIN_SCORE = 0.45;
const AUTHORING_TOPK_PER_CORPUS = 5;
const AUTHORING_MAX_PATHS = 20;

/**
 * Retrieve prior work at task/mission AUTHORING time (create_task, manage_missions
 * action=create) and render it as a compact "## Prior work" block using the same
 * renderer as buildKnowledgeContext. Queries memory (team-scoped) + task + pr
 * (workspace-scoped), plus a path-scoped pr supplement when `opts.paths` is given
 * (from the new row's pathManifest).
 *
 * Unlike buildKnowledgeContext (which renders every corpus's top-3 unconditionally
 * for a planning prompt), this caps the merged, deduped, score-sorted result set at
 * 5 hits and drops anything below the 0.45 precision floor — the point here is a
 * short, actionable nudge to the human/agent authoring the row, not a full context dump.
 *
 * Best-effort: returns '' on any failure (no embeddings configured, store down,
 * empty query) so a retrieval problem never blocks task/mission creation.
 */
export async function buildAuthoringPriorWork(
  queryText: string,
  workspaceId: string | null | undefined,
  teamId: string | null | undefined,
  store: PriorWorkQuerier | undefined,
  opts?: { paths?: string[] },
): Promise<string> {
  if (!queryText.trim() || !store) return '';
  try {
    const queries: Promise<QueryResult[]>[] = [];
    if (teamId) {
      queries.push(
        store.query(buildNamespace(teamId, 'memory'), { text: queryText, topK: AUTHORING_TOPK_PER_CORPUS }).catch(() => []),
      );
    }
    if (workspaceId) {
      queries.push(
        store.query(buildNamespace(workspaceId, 'task'), { text: queryText, topK: AUTHORING_TOPK_PER_CORPUS }).catch(() => []),
      );
      queries.push(
        store.query(buildNamespace(workspaceId, 'pr'), { text: queryText, topK: AUTHORING_TOPK_PER_CORPUS }).catch(() => []),
      );

      const paths = (opts?.paths ?? []).filter(p => typeof p === 'string' && p.trim().length > 0);
      if (paths.length > 0) {
        const pathQuery = paths.slice(0, AUTHORING_MAX_PATHS).join('\n');
        queries.push(
          store.query(buildNamespace(workspaceId, 'pr'), { text: pathQuery, topK: AUTHORING_TOPK_PER_CORPUS }).catch(() => []),
        );
      }
    }

    if (queries.length === 0) return '';

    const settled = await Promise.all(queries);
    const seen = new Set<string>();
    const merged: QueryResult[] = [];
    for (const r of settled.flat()) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
    }

    const top = merged
      .filter(r => r.score >= AUTHORING_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, AUTHORING_MAX_HITS);

    if (top.length === 0) return '';

    const lines = ['## Prior work', ...top.flatMap(renderHitLines)];
    return lines.join('\n');
  } catch {
    return ''; // non-fatal: retrieval failure must never block task/mission creation
  }
}

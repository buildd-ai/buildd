/**
 * The one write path for memories.
 *
 * Invariant: every memory write lands in the `memories` table AND in the
 * `{teamId}:memory` index that `recall` and the claim/planning blocks read.
 * `learn`, `buildd_memory` save/update, the dashboard and the feedback digest
 * all go through `saveMemory` / `updateMemory` (and the dashboard's review
 * actions through `transitionMemory`), so no writer can forget the mirror.
 *
 * A mirror failure never fails the write (the row is the source of truth), but
 * it is never silent either: it logs `MEMORY_MIRROR_FAILED_TAG` and bumps a
 * per-path counter. The reconcile pass in ./memory-index-reconcile re-mirrors
 * rows the index is missing.
 *
 * No DB import here: mcp-tools (which the runner also loads) depends on this.
 */
import { buildNamespace } from './knowledge-store/pg-vector-store';
import type { KnowledgeStore, UpsertChunk } from './knowledge-store/types';
import type { MemoryRecord, MemoryTransitionResult, SaveMemoryInput, UpdateMemoryInput } from './memory-store';
import type { MemoryReviewAction } from './memory-candidates';

/** Log prefix for a memory row that did not reach the index. Grep prod logs for this. */
export const MEMORY_MIRROR_FAILED_TAG = '[memory-mirror-failed]';

/** Which writer produced the memory. Used as the counter key and in the log line. */
export type MemoryWriteVia =
  | 'learn'
  | 'buildd_memory:save'
  | 'buildd_memory:update'
  | 'dashboard:create'
  | 'dashboard:update'
  | 'dashboard:review'
  | 'feedback-digest'
  | 'reconcile';

/** The memory fields the index needs. `MemoryRecord` satisfies it. */
export type IndexableMemory = Pick<MemoryRecord, 'id' | 'type' | 'title' | 'content' | 'tags' | 'files' | 'project'>
  & { teamId?: string | null };

const mirrorFailures = new Map<MemoryWriteVia, number>();

/**
 * Mirror failures per write path for the life of this process. Serverless
 * instances are short-lived, so this is a probe for tests and local runs; the
 * durable signal is the tagged log line, and the durable fix is reconcile.
 */
export function getMemoryMirrorFailureCounts(): Partial<Record<MemoryWriteVia, number>> {
  return Object.fromEntries(mirrorFailures);
}

export function resetMemoryMirrorFailureCounts(): void {
  mirrorFailures.clear();
}

/** The index chunk for a memory. Memory ids ARE the chunk source_ids in `{teamId}:memory`. */
export function memoryIndexChunk(m: IndexableMemory, supersedes?: string[]): UpsertChunk {
  return {
    id: m.id,
    content: m.content,
    lexicalText: `${m.title}\n\n${m.content}`,
    sourceType: 'memory',
    sourceUrl: `/app/memory/${m.id}`,
    metadata: { memoryId: m.id, type: m.type, tags: m.tags, files: m.files, project: m.project },
    ...(supersedes && supersedes.length > 0 ? { supersedes } : {}),
  };
}

export type MirrorOutcome =
  | { mirrored: true; superseded: number }
  | { mirrored: false; superseded: 0; reason: 'no-index' | 'failed' };

/**
 * Upsert one memory into its team's memory namespace. Never throws. No store
 * or no team is `no-index` (e.g. a runner-side context), not a failure.
 */
export async function mirrorMemoryToIndex(
  store: KnowledgeStore | null | undefined,
  teamId: string | null | undefined,
  m: IndexableMemory,
  opts: { via: MemoryWriteVia; supersedes?: string[] },
): Promise<MirrorOutcome> {
  const team = teamId ?? m.teamId ?? null;
  if (!store || !team) return { mirrored: false, superseded: 0, reason: 'no-index' };
  try {
    const res = await store.upsert(buildNamespace(team, 'memory'), [memoryIndexChunk(m, opts.supersedes)]);
    return { mirrored: true, superseded: res ? res.superseded : 0 };
  } catch (err) {
    const next = (mirrorFailures.get(opts.via) ?? 0) + 1;
    mirrorFailures.set(opts.via, next);
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `${MEMORY_MIRROR_FAILED_TAG} via=${opts.via} team=${team} memory=${m.id} failures=${next}`
      + ` error=${reason.slice(0, 200)}; reconcile will retry`,
    );
    return { mirrored: false, superseded: 0, reason: 'failed' };
  }
}

export interface MemoryWriteOpts {
  /** Team whose namespace the memory is mirrored into. Defaults to the saved row's team. */
  teamId?: string | null;
  knowledgeStore?: KnowledgeStore | null;
  via: MemoryWriteVia;
  /**
   * Memory ids this write replaces. The caller MUST have narrowed these to its
   * own project already: the index is team-wide and flips whatever it is given.
   */
  supersedes?: string[];
}

export interface MemoryWriteResult {
  memory: MemoryRecord;
  mirrored: boolean;
  superseded: number;
}

/** Optional row-level supersession; `MemoryStore` has it. */
type SupersedeRows = { markSuperseded?(ids: string[], byId: string): Promise<number> };

/**
 * Record supersession on the memories rows, whether or not the mirror worked,
 * so reconcile can never re-index a replaced memory as current. Never throws.
 */
async function recordSupersession(client: SupersedeRows, memoryId: string, opts: MemoryWriteOpts): Promise<void> {
  if (!opts.supersedes || opts.supersedes.length === 0 || !client.markSuperseded) return;
  try {
    await client.markSuperseded(opts.supersedes, memoryId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`${MEMORY_MIRROR_FAILED_TAG} via=${opts.via} memory=${memoryId} step=mark-superseded error=${reason.slice(0, 200)}`);
  }
}

/** Save a memory row, then mirror it. */
export async function saveMemory(
  client: { save(input: SaveMemoryInput): Promise<{ memory: MemoryRecord }> } & SupersedeRows,
  input: SaveMemoryInput,
  opts: MemoryWriteOpts,
): Promise<MemoryWriteResult> {
  const { memory } = await client.save(input);
  const mirror = await mirrorMemoryToIndex(opts.knowledgeStore, opts.teamId, memory, opts);
  await recordSupersession(client, memory.id, opts);
  return { memory, mirrored: mirror.mirrored, superseded: mirror.superseded };
}

/** Update a memory row, then re-mirror it. */
export async function updateMemory(
  client: { update(id: string, fields: UpdateMemoryInput): Promise<{ memory: MemoryRecord }> } & SupersedeRows,
  id: string,
  fields: UpdateMemoryInput,
  opts: MemoryWriteOpts,
): Promise<MemoryWriteResult> {
  const { memory } = await client.update(id, fields);
  const mirror = await mirrorMemoryToIndex(opts.knowledgeStore, opts.teamId, memory, opts);
  await recordSupersession(client, memory.id, opts);
  return { memory, mirrored: mirror.mirrored, superseded: mirror.superseded };
}

export interface MemoryTransitionWriteResult extends MemoryWriteResult {
  /** Rows the promotion superseded (same team and project). */
  supersededIds: string[];
}

/**
 * Apply a human review action (promote / dismiss / reverified) to a memory in
 * `project`, then re-mirror it. The store's UPDATE is the gate: null means the
 * row is missing, under another project, superseded, or not in a state the
 * action starts from, and nothing was written. A promotion's superseded rows
 * are flipped in the index by the same mirror call.
 */
export async function transitionMemory(
  client: { transition(id: string, project: string, action: MemoryReviewAction): Promise<MemoryTransitionResult | null> },
  id: string,
  project: string,
  action: MemoryReviewAction,
  opts: Omit<MemoryWriteOpts, 'supersedes'>,
): Promise<MemoryTransitionWriteResult | null> {
  const res = await client.transition(id, project, action);
  if (!res) return null;
  const mirror = await mirrorMemoryToIndex(opts.knowledgeStore, opts.teamId, res.memory, {
    via: opts.via,
    supersedes: res.supersededIds,
  });
  return { memory: res.memory, mirrored: mirror.mirrored, superseded: mirror.superseded, supersededIds: res.supersededIds };
}

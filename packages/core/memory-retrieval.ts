/**
 * One door for memory reads, and the ledger of what came through it.
 *
 * Every read of team memory that reaches an agent goes through
 * `retrieveMemory`: `recall` and `query_knowledge` (pulls), and the claim-time
 * "Related prior work" block, the claim recipe block, mission planning,
 * authoring-time prior work, the `claim_task` "Relevant Memory" reply and the
 * runner's `## Workspace Memory` search (pushes). See
 * docs/design/memory-done-right.md.
 *
 * What it owns, so no caller re-implements it:
 *
 * - **Scope.** The caller's project is resolved once (or taken pre-resolved)
 *   and every hit is narrowed to it by the rule in ./memory-hit-scope.
 * - **Ranking.** Hybrid search, rerank and recency x authority are the store's
 *   (`PgVectorStore.query`); this passes the caller's budget through unchanged.
 * - **Gating.** A hit can be retrieved and still held back (score floor,
 *   handoff exclusion). It comes back with `gated: true` and the rule's name,
 *   so the ledger records what the gate dropped, not just what survived.
 * - **Hit counting.** Only pulls increment `knowledge_chunks.hit_count`; a push
 *   the agent never asked for is not a hit.
 * - **The ledger.** One `memory_uses` row per hit, written fire-and-forget as a
 *   single INSERT per retrieval. It never blocks the read and never fails it.
 *
 * Defaults reproduce each caller's pre-existing output exactly; the golden
 * tests (`memory-read-golden.test.ts` in packages/core and apps/web, and the
 * memory route test) pin that.
 *
 * No static DB import: the store, the scope resolver and the ledger writer are
 * all loaded lazily, same as ./memory-hit-scope.
 */
import {
  memoryIdOfHit,
  memoryOverfetchTopK,
  memoryScopeFor,
  keepOwnProjectMemoryHits,
  hasMemoryScope,
  type MemoryHitScope,
  type MemoryQuerier,
} from './memory-hit-scope';
import { buildNamespace } from './knowledge-store/pg-vector-store';
import type { QueryMode, QueryResult } from './knowledge-store/types';

// ── Vocabulary ────────────────────────────────────────────────────────────────

/** Which read path a retrieval served. Stored in `memory_uses.caller`. */
export type MemoryCaller =
  | 'recall'
  | 'query_knowledge'
  | 'claim_context'
  | 'claim_recipe'
  | 'mission_planning'
  | 'authoring_prior_work'
  | 'claim_task_reply'
  | 'runner_workspace_memory';

export type MemoryVia = 'push' | 'pull';

/** Pull = the agent asked for it. Everything else is a push. */
export const MEMORY_CALLER_VIA: Record<MemoryCaller, MemoryVia> = {
  recall: 'pull',
  query_knowledge: 'pull',
  claim_context: 'push',
  claim_recipe: 'push',
  mission_planning: 'push',
  authoring_prior_work: 'push',
  claim_task_reply: 'push',
  runner_workspace_memory: 'push',
};

/** Why a retrieved hit was held back. Stored in `memory_uses.gated_by`. */
export type MemoryGate =
  | 'score_floor'
  | 'excluded'
  | 'cross_corpus_cap'
  | 'char_budget'
  | 'recipe_fallback';

/** One memory a retrieval returned. */
export interface MemoryHit {
  /** `knowledge_chunks.source_id`; null for a store (ILIKE) search hit. */
  chunkId: string | null;
  memoryId: string;
  /** 1-based position in the retrieval's result list. */
  rank: number;
  /** Store score; null for a store search, which has no score. */
  score: number | null;
  gated: boolean;
  gatedBy: MemoryGate | null;
}

/** Who the retrieval was for. Ids that are not UUIDs are dropped, never sent. */
export interface MemoryAttribution {
  taskId?: string | null;
  workerId?: string | null;
}

/** A `memory_uses` row as the writer receives it. */
export interface MemoryUseRow {
  teamId: string;
  workspaceId: string | null;
  taskId: string | null;
  workerId: string | null;
  chunkId: string | null;
  memoryId: string;
  caller: MemoryCaller;
  via: MemoryVia;
  rank: number;
  score: number | null;
  gatedBy: MemoryGate | null;
}

/** Receives one retrieval's rows. Must not throw and must not be awaited. */
export type MemoryLedgerWriter = (rows: MemoryUseRow[]) => void;

// ── Ledger ────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null | undefined): string | null =>
  typeof v === 'string' && UUID_RE.test(v) ? v : null;

type LedgerDb = { insert: (table: any) => { values: (rows: MemoryUseRow[]) => PromiseLike<unknown> } };

/**
 * A writer that sends each batch as ONE INSERT, not awaited, errors
 * swallowed. A missing table, a missing DATABASE_URL (the runner) or a failed
 * insert costs the ledger rows and nothing else.
 */
export function createDbMemoryLedger(
  loadDb: () => Promise<{ db: LedgerDb; table: unknown }> = async () => {
    const { db } = await import('./db');
    const { memoryUses } = await import('./db/schema');
    return { db: db as unknown as LedgerDb, table: memoryUses };
  },
): MemoryLedgerWriter {
  return (rows) => {
    if (rows.length === 0) return;
    void (async () => {
      const { db, table } = await loadDb();
      await db.insert(table).values(rows);
    })().catch(() => {});
  };
}

const writeToDb = createDbMemoryLedger();

/**
 * The default writer. Inert under `bun test` (NODE_ENV=test): unit tests drive
 * the read paths with real-shaped ids, and a checkout's env can point at a
 * live database, so no test may be one stray default away from writing ledger
 * rows into it. Tests that want the rows inject a writer.
 */
export const dbMemoryLedger: MemoryLedgerWriter = (rows) => {
  if (process.env.NODE_ENV === 'test') return;
  writeToDb(rows);
};

/**
 * Build the rows for one retrieval. Skips everything when the team id is not a
 * UUID (the column is NOT NULL uuid, so one bad id would fail the whole batch).
 */
export function buildMemoryUseRows(args: {
  hits: readonly MemoryHit[];
  teamId: string | null | undefined;
  workspaceId?: string | null;
  caller: MemoryCaller;
  attribution?: MemoryAttribution;
}): MemoryUseRow[] {
  const teamId = uuidOrNull(args.teamId);
  if (!teamId) return [];
  const via = MEMORY_CALLER_VIA[args.caller];
  return args.hits.map(h => ({
    teamId,
    workspaceId: uuidOrNull(args.workspaceId),
    taskId: uuidOrNull(args.attribution?.taskId),
    workerId: uuidOrNull(args.attribution?.workerId),
    chunkId: h.chunkId,
    memoryId: h.memoryId,
    caller: args.caller,
    via,
    rank: h.rank,
    score: typeof h.score === 'number' && Number.isFinite(h.score) ? h.score : null,
    gatedBy: h.gatedBy,
  }));
}

let defaultLedger: MemoryLedgerWriter = dbMemoryLedger;

/**
 * Swap the writer used when a caller passes no `ledger`, returning the
 * previous one. For tests of paths that do not expose a `ledger` option
 * (recall, claim_task); restore it afterwards.
 */
export function setDefaultMemoryLedger(writer: MemoryLedgerWriter): MemoryLedgerWriter {
  const previous = defaultLedger;
  defaultLedger = writer;
  return previous;
}

function writeLedger(
  writer: MemoryLedgerWriter | false | undefined,
  rows: MemoryUseRow[],
): void {
  if (writer === false || rows.length === 0) return;
  try {
    (writer ?? defaultLedger)(rows);
  } catch {
    // The ledger is telemetry: it never affects the read.
  }
}

// ── Hybrid (knowledge store) retrieval ───────────────────────────────────────

export interface MemoryRetrievalScope {
  teamId: string | null | undefined;
  workspaceId?: string | null;
  /**
   * The caller's memory scope. Omitted: resolved from the DB for
   * `workspaceId` in `teamId`. `null`: no memory (and no query).
   */
  memoryScope?: MemoryHitScope | null;
}

export interface RetrieveMemoryInput {
  strategy?: 'hybrid';
  query: string;
  scope: MemoryRetrievalScope;
  caller: MemoryCaller;
  budget: {
    /** Hits returned, after narrowing and filtering. */
    topK: number;
    /** Candidate depth before narrowing. Default `topK`; over-fetched from there. */
    candidates?: number;
  };
  /** Store to query. Default: a PgVectorStore with the Voyage embedder and reranker. */
  store?: MemoryQuerier;
  mode?: QueryMode;
  /** Drop `isCurrent === false` hits before narrowing. Default false. */
  excludeSuperseded?: boolean;
  /** Caller's post-narrowing filter (recall's type/files). Applied before the topK cut. */
  filter?: (r: QueryResult) => boolean;
  /** Retrieved-but-held-back rules. Gated hits are returned flagged, not dropped. */
  gate?: { minScore?: number; exclude?: ReadonlySet<string> };
  attribution?: MemoryAttribution;
  /** Ledger writer. Default: the DB. `false`: no ledger. */
  ledger?: MemoryLedgerWriter | false;
  /**
   * Hold the ledger write until the caller knows what it showed; the caller
   * must call `commitLedger`. For callers that post-process (merge across
   * corpora, apply a char budget) after this returns.
   */
  deferLedger?: boolean;
  /** 'empty' (default): any failure is an empty result. 'throw': propagate. */
  onError?: 'empty' | 'throw';
}

export interface RetrievedMemoryHit extends MemoryHit {
  result: QueryResult;
}

export interface RetrieveMemoryResult {
  /** Every hit retrieved, in rank order, gated ones included. */
  hits: RetrievedMemoryHit[];
  /** The ungated hits' results, in rank order: what the caller renders. */
  results: QueryResult[];
  /**
   * Write the ledger now (only meaningful with `deferLedger`). `gateFor`
   * may hold back more hits than the retrieval's own gate did; return null to
   * keep a hit's existing verdict. Idempotent: only the first call writes.
   */
  commitLedger: (gateFor?: (hit: RetrievedMemoryHit) => MemoryGate | null) => void;
}

// ── Store (ILIKE) search ─────────────────────────────────────────────────────

/** The `MemoryStore.search` params, passed through verbatim. */
export interface MemoryStoreSearchParams {
  query?: string;
  type?: string;
  project?: string;
  files?: string[];
  limit?: number;
  offset?: number;
}

/** The slice of MemoryStore a store search needs. */
export interface MemoryStoreSearcher {
  search(params: MemoryStoreSearchParams): Promise<{ results: Array<{ id: string }>; total: number }>;
  batch(ids: string[]): Promise<{ memories: Array<{ id: string } & Record<string, any>> }>;
}

export interface RetrieveStoreMemoryInput {
  /**
   * The memories table's own token search (ILIKE), for the two push paths
   * that have always used it: the runner's workspace memory block and the
   * claim_task reply. Kept as a strategy so they share scope handling and the
   * ledger while their output stays what it was.
   */
  strategy: 'store-search';
  searcher: MemoryStoreSearcher;
  /** Passed to `searcher.search` verbatim; `project` scopes it. */
  search: MemoryStoreSearchParams;
  scope: { teamId: string | null | undefined; workspaceId?: string | null };
  caller: MemoryCaller;
  attribution?: MemoryAttribution;
  ledger?: MemoryLedgerWriter | false;
}

export interface RetrieveStoreMemoryResult<M> {
  /** Hydrated rows, in the order `batch` returned them. */
  memories: M[];
  /** The search's total (0 when it matched nothing). */
  total: number;
  hits: MemoryHit[];
}

// ── The door ─────────────────────────────────────────────────────────────────

export function retrieveMemory(input: RetrieveMemoryInput): Promise<RetrieveMemoryResult>;
export function retrieveMemory<M = Record<string, any>>(
  input: RetrieveStoreMemoryInput,
): Promise<RetrieveStoreMemoryResult<M>>;
export async function retrieveMemory(
  input: RetrieveMemoryInput | RetrieveStoreMemoryInput,
): Promise<RetrieveMemoryResult | RetrieveStoreMemoryResult<unknown>> {
  if (input.strategy === 'store-search') return retrieveStoreMemory(input);
  return retrieveHybridMemory(input);
}

const EMPTY_COMMIT = () => {};

async function defaultStore(): Promise<MemoryQuerier> {
  const { PgVectorStore } = await import('./knowledge-store/pg-vector-store');
  const { getVoyageEmbedder } = await import('./knowledge-store/voyage-embedder');
  const { getVoyageReranker } = await import('./knowledge-store/reranker');
  return new PgVectorStore(getVoyageEmbedder(), getVoyageReranker());
}

async function retrieveHybridMemory(input: RetrieveMemoryInput): Promise<RetrieveMemoryResult> {
  const empty: RetrieveMemoryResult = { hits: [], results: [], commitLedger: EMPTY_COMMIT };
  const { teamId, workspaceId } = input.scope;
  if (!teamId) return empty;

  try {
    // A pre-resolved scope is used as is, without an await, so a caller that
    // resolved once and fans out does not pay a tick before the query starts.
    const memoryScope = input.scope.memoryScope !== undefined
      ? input.scope.memoryScope
      : await memoryScopeFor(undefined, workspaceId, teamId);
    if (!hasMemoryScope(memoryScope)) return empty;

    const store = input.store ?? await defaultStore();
    const via = MEMORY_CALLER_VIA[input.caller];
    const candidates = input.budget.candidates ?? input.budget.topK;
    const raw = await store.query(buildNamespace(teamId, 'memory'), {
      text: input.query,
      topK: memoryOverfetchTopK(candidates),
      mode: input.mode,
      // Only a pull is a hit. A push counted here made a memory injected into
      // a hundred ignored prompts look popular to consolidation.
      trackHits: via === 'pull',
    });

    const current = input.excludeSuperseded ? raw.filter(r => r.isCurrent !== false) : raw;
    let own = await keepOwnProjectMemoryHits(current, memoryScope);
    if (input.filter) own = own.filter(input.filter);
    own = own.slice(0, input.budget.topK);

    const exclude = input.gate?.exclude;
    const minScore = input.gate?.minScore;
    const hits: RetrievedMemoryHit[] = own.map((r, i) => {
      const gatedBy: MemoryGate | null = exclude?.has(r.id)
        ? 'excluded'
        : typeof minScore === 'number' && (r.score ?? 0) < minScore
          ? 'score_floor'
          : null;
      return {
        chunkId: r.id,
        memoryId: memoryIdOfHit(r),
        rank: i + 1,
        score: typeof r.score === 'number' ? r.score : null,
        gated: gatedBy !== null,
        gatedBy,
        result: r,
      };
    });

    let committed = false;
    const commitLedger: RetrieveMemoryResult['commitLedger'] = (gateFor) => {
      if (committed) return;
      committed = true;
      const final = gateFor
        ? hits.map(h => {
            if (h.gated) return h;
            const extra = gateFor(h);
            return extra ? { ...h, gated: true, gatedBy: extra } : h;
          })
        : hits;
      writeLedger(input.ledger, buildMemoryUseRows({
        hits: final,
        teamId,
        workspaceId,
        caller: input.caller,
        attribution: input.attribution,
      }));
    };
    if (!input.deferLedger) commitLedger();

    return { hits, results: hits.filter(h => !h.gated).map(h => h.result), commitLedger };
  } catch (err) {
    if (input.onError === 'throw') throw err;
    return empty;
  }
}

async function retrieveStoreMemory(
  input: RetrieveStoreMemoryInput,
): Promise<RetrieveStoreMemoryResult<unknown>> {
  const searchData = await input.searcher.search(input.search);
  const results = searchData.results || [];
  if (results.length === 0) return { memories: [], total: 0, hits: [] };

  const batchData = await input.searcher.batch(results.map(r => r.id));
  const memories = batchData.memories || [];

  // Ranked by the search's order: that is the retrieval's ranking. The rows
  // come back in batch order, which is what the caller renders.
  const rankOf = new Map(results.map((r, i) => [r.id, i + 1]));
  const hits: MemoryHit[] = memories
    .map(m => ({
      chunkId: null,
      memoryId: m.id,
      rank: rankOf.get(m.id) ?? 0,
      score: null,
      gated: false,
      gatedBy: null,
    }))
    .filter(h => h.rank > 0)
    .sort((a, b) => a.rank - b.rank);

  writeLedger(input.ledger, buildMemoryUseRows({
    hits,
    teamId: input.scope.teamId,
    workspaceId: input.scope.workspaceId,
    caller: input.caller,
    attribution: input.attribution,
  }));

  return { memories, total: searchData.total, hits };
}

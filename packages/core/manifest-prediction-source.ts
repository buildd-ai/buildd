/**
 * Creation-time manifest prediction — the stores and the orchestration
 * (knowledge-base: buildd/design/conflict-aware-orchestration.md §5a). Pure rules live in
 * `./manifest-prediction.ts`.
 *
 * Runs in SHADOW, after the task-creation response (the web route schedules it
 * with `after()`), for teams that opted in to `orchestration_manifest`. It never
 * writes `tasks.path_manifest` or `dependsOn`, and it never throws.
 *
 * ── Candidates ─────────────────────────────────────────────────────────────
 *  - **Neighbours** are reused from task-area prediction (`findNeighbourTasks`
 *    over the workspace's `task` corpus). The retrieval experiment itself is
 *    untouched: its config switch, arms and rail are not read or written here.
 *  - **No future leakage**: each neighbour is dated by its first worker
 *    completion (workspace-scoped read) and must predate the new task's
 *    creation; its diff paths come from `pr` corpus chunks stamped before the
 *    same cutoff. At creation time this is trivially true; it matters for any
 *    replay over historical tasks, which reuses this exact code path.
 *  - **Tree-pinned** (knowledge-base: buildd/design/jev-scheduling.md §1d):
 *    the repository tree at the task's base commit, read through the
 *    workspace installation as the knowledge-ingest fallback does and cached
 *    per commit, ranked by the workspace code corpus. Coverage is
 *    `tree_pinned`; a tree or corpus failure degrades to `neighbour_diff_only`
 *    with candidate omissions unknown scope.
 *
 * ── Set confidence and size (jev-scheduling §3) ──────────────────────────
 *  - `setConfidence`: the product of the pick confidences
 *    (`setConfidenceOf`), a starting point the readout recalibrates.
 *  - `expectedSize`: median files and session minutes of the same
 *    neighbours (`./task-size-estimate.ts`); null with fewer than k.
 *
 * One overall deadline (5s default) covers access, retrieval and every pick.
 */
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { FAILED_WORKER_STATUSES } from '@buildd/shared';
import { db } from './db/client';
import { githubInstallations, githubRepos, orchestrationManifestPredictions, workers, workspaces } from './db/schema';
import { getInstallationToken } from './github-installation-auth';
import { buildNamespace } from './knowledge-store/pg-vector-store';
import { inferPathsFromText } from './task-path-inference';
import { hasConcretePathManifest } from './path-overlap';
import { TASK_AREA_FALLBACK, unionNeighbourPaths, type TaskAreaConfig } from './task-area-prediction';
import { findNeighbourTasks, type TaskAreaQuerier } from './task-area-prediction-source';
import {
  ORCHESTRATION_DECISION_DEADLINE_MS,
  candidateDigest,
  runOrchestrationDecision,
  type OrchestrationDecisionDeps,
  type OrchestrationDecisionRow,
} from './orchestration-decision';
import { loadTaskPrDiffs, type LoadTaskPrDiffs } from './task-pr-diffs';
import { estimateTaskSize, type EstimateTaskSizeArgs, type ExpectedTaskSize } from './task-size-estimate';
import { estimateExpectedSize, type EstimateExpectedSizeDeps } from './task-size-bucket-source';
import type { DecisionAccess } from './decision-client';
import { manifestPickIdentity, resolveApplyingFraction, type PromotionEvidence } from './orchestration-promotion';
import {
  MANIFEST_APPLYING_FRACTION,
  MANIFEST_CANDIDATE_POLICY_VERSION,
  MANIFEST_DECISION_ID,
  MANIFEST_PICK_MODE,
  MANIFEST_PICK_QUESTION,
  manifestPromptVersion,
  buildManifestCandidates,
  predictionUnknownScope,
  resolvePickCap,
  runRepeatedManifestChoice,
  type ManifestCandidateSet,
  type ManifestPick,
  type NeighbourEvidence,
  type RepeatedChoiceResult,
  type TreeCandidateResult,
} from './manifest-prediction';

const CAPABILITY = 'orchestration_manifest' as const;

/** A session that ended in one of these did failed work (§5a): its touches are not the task's scope. */
const FAILED_STATUSES: ReadonlySet<string> = new Set<string>(FAILED_WORKER_STATUSES);

/** Neighbour retrieval config: the task-area defaults, diff source, a little wider. Not the experiment's runtime config. */
export const MANIFEST_NEIGHBOUR_CONFIG: TaskAreaConfig = { ...TASK_AREA_FALLBACK, topK: 10, pathSource: 'diff' };
/** Bound on corpus-ranked files requested per prediction (tree-pinned source). */
export const MANIFEST_TREE_RANKED_LIMIT = 64;
/** Task text sent to the model, per field. */
export const MANIFEST_STATE_DESCRIPTION_CHARS = 1_500;

// ── Tree-pinned candidate source (jev-scheduling §1d) ────────────────────────

export interface TreeCandidateRequest {
  workspaceId: string;
  /** The branch or SHA the task will base on. Null ⇒ the repository's default branch. */
  baseRef: string | null;
  seedText: string;
  /** Corpus-ranked files requested. */
  limit: number;
  signal?: AbortSignal;
}

export interface TreeCandidateAdapter {
  lookup(req: TreeCandidateRequest): Promise<TreeCandidateResult>;
}

/** A workspace's repository and an authenticated GitHub GET bound to it. */
export interface TreeRepoAccess {
  repo: string;
  github: (path: string) => Promise<any>;
}

export interface CodeCorpusHit {
  sourcePath: string | null;
  metadata?: Record<string, unknown>;
}

export interface TreeCandidateAdapterDeps {
  /** Null when the workspace has no linked repository or installation. */
  resolveRepo: (workspaceId: string, signal?: AbortSignal) => Promise<TreeRepoAccess | null>;
  /** The workspace `code` corpus (what `recall scope=code` reads), best first. */
  queryCode: (workspaceId: string, text: string, topK: number) => Promise<CodeCorpusHit[]>;
  /** Tree file lists keyed `<repo>@<sha>`. A commit's tree never changes, so entries never go stale. */
  cache?: Map<string, readonly string[]>;
  cacheMax?: number;
}

/** Trees kept per server instance. One large repo's tree is a few MB of paths at most. */
export const TREE_CACHE_MAX_COMMITS = 16;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const encodeRef = (ref: string) => encodeURIComponent(ref);

/**
 * Candidates from the repository tree at the task's base commit, ranked by the
 * workspace code corpus. The ref is resolved to a commit SHA first, so the
 * cache is per commit, not per branch. Any failure (no installation, a failed
 * or truncated tree read, a corpus error) answers `unavailable` and the caller
 * degrades to neighbour-diff-only coverage.
 */
export function createTreeCandidateAdapter(deps: TreeCandidateAdapterDeps): TreeCandidateAdapter {
  const cache = deps.cache ?? new Map<string, readonly string[]>();
  const cacheMax = deps.cacheMax ?? TREE_CACHE_MAX_COMMITS;
  const unavailable = (reason: string): TreeCandidateResult => ({ status: 'unavailable', reason: reason.slice(0, 200) });

  const readTree = async (access: TreeRepoAccess, sha: string): Promise<readonly string[]> => {
    const key = `${access.repo}@${sha}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const body = await access.github(`/repos/${access.repo}/git/trees/${sha}?recursive=1`);
    if (body?.truncated) throw new Error('tree listing truncated by GitHub: absence at the commit cannot be verified');
    if (!Array.isArray(body?.tree)) throw new Error('unexpected tree response');
    const paths = (body.tree as Array<{ path?: unknown; type?: unknown }>)
      .filter(e => e?.type === 'blob' && typeof e.path === 'string')
      .map(e => e.path as string)
      .sort();
    cache.set(key, paths);
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value as string);
    return paths;
  };

  return {
    async lookup(req) {
      try {
        const access = await deps.resolveRepo(req.workspaceId, req.signal);
        if (!access) return unavailable('no GitHub installation or repository linked to the workspace');
        const resolveSha = async (): Promise<string> => {
          const ref = req.baseRef?.trim();
          if (ref && FULL_SHA.test(ref)) return ref.toLowerCase();
          let branch = ref;
          if (!branch) {
            const repo = await access.github(`/repos/${access.repo}`);
            branch = typeof repo?.default_branch === 'string' ? repo.default_branch : '';
            if (!branch) throw new Error('could not resolve the default branch');
          }
          const commit = await access.github(`/repos/${access.repo}/commits/${encodeRef(branch)}`);
          if (typeof commit?.sha !== 'string') throw new Error('could not resolve the base commit');
          return commit.sha;
        };
        const ranking = req.seedText.trim()
          ? deps.queryCode(req.workspaceId, req.seedText, req.limit)
          : Promise.resolve([] as CodeCorpusHit[]);
        const [sha, hits] = await Promise.all([
          resolveSha(),
          ranking.catch((err) => { throw new Error(`code corpus: ${String((err as Error)?.message ?? err)}`); }),
        ]);
        const paths = await readTree(access, sha);
        const ranked = [...new Set(hits
          .map(h => h.sourcePath ?? (typeof h.metadata?.path === 'string' ? h.metadata.path : null))
          .filter((p): p is string => typeof p === 'string' && p !== ''))].slice(0, req.limit);
        return { status: 'ok', revision: sha, paths, ranked };
      } catch (err) {
        return unavailable(`tree source: ${String((err as Error)?.message ?? err)}`);
      }
    },
  };
}

const SERVER_TREE_CACHE = new Map<string, readonly string[]>();

async function resolveServerRepo(workspaceId: string, signal?: AbortSignal): Promise<TreeRepoAccess | null> {
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!workspace?.githubInstallationId) return null;
  let repo = workspace.repo ?? null;
  if (workspace.githubRepoId) {
    const linked = await db.query.githubRepos.findFirst({ where: eq(githubRepos.id, workspace.githubRepoId) });
    repo = linked?.fullName ?? repo;
  }
  const installation = await db.query.githubInstallations.findFirst({ where: eq(githubInstallations.id, workspace.githubInstallationId) });
  if (!repo || !installation) return null;
  const token = await getInstallationToken(installation.installationId);
  return {
    repo,
    github: async (path: string) => {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: signal ?? AbortSignal.timeout(ORCHESTRATION_DECISION_DEADLINE_MS),
      });
      if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
      return response.json();
    },
  };
}

async function queryServerCodeCorpus(workspaceId: string, text: string, topK: number): Promise<CodeCorpusHit[]> {
  const store = await defaultStore();
  const results = await store.query(buildNamespace(workspaceId, 'code'), {
    text,
    topK,
    filters: { corpus: 'code' },
    useGraph: false,
    trackHits: false,
  });
  return results.map(r => ({ sourcePath: r.sourcePath, metadata: r.metadata }));
}

/** The tree-pinned source the deployed server uses: the workspace installation's tree read, cached per commit. */
export function getServerTreeCandidateAdapter(): TreeCandidateAdapter {
  return createTreeCandidateAdapter({ resolveRepo: resolveServerRepo, queryCode: queryServerCodeCorpus, cache: SERVER_TREE_CACHE });
}

// ── Neighbour evidence (predicates rendered by the tests) ────────────────────

export function neighbourCompletionWhere(opts: { workspaceId: string; taskIds: string[] }) {
  return and(
    eq(workers.workspaceId, opts.workspaceId),
    inArray(workers.taskId, opts.taskIds),
    isNotNull(workers.completedAt),
  );
}

export function neighbourDiffPathsQuery(opts: { workspaceId: string; taskIds: string[]; cutoff: Date }) {
  const ns = buildNamespace(opts.workspaceId, 'pr');
  const idList = sql.join(opts.taskIds.map(id => sql`${id}`), sql`, `);
  return sql`
    SELECT metadata->>'taskId' AS "taskId",
           metadata->>'path'   AS "path",
           COUNT(*)            AS "chunks"
      FROM knowledge_chunks
     WHERE namespace = ${ns}
       AND corpus = 'pr'
       AND is_current = true
       AND metadata->>'taskId' IN (${idList})
       AND metadata->>'path' IS NOT NULL
       AND COALESCE(source_ts, updated_at) < ${opts.cutoff.toISOString()}
     GROUP BY 1, 2
     ORDER BY 1, 3 DESC
  `;
}

/** First completion per neighbour (a later retry cannot re-date it into the past). */
async function loadNeighbourCompletions(workspaceId: string, taskIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (taskIds.length === 0) return out;
  const rows = await db
    .select({ taskId: workers.taskId, completedAt: sql<Date>`MIN(${workers.completedAt})`.as('completed_at') })
    .from(workers)
    .where(neighbourCompletionWhere({ workspaceId, taskIds }))
    .groupBy(workers.taskId);
  for (const r of rows as Array<{ taskId: string | null; completedAt: Date | string | null }>) {
    if (!r.taskId || !r.completedAt) continue;
    const d = r.completedAt instanceof Date ? r.completedAt : new Date(r.completedAt);
    if (Number.isFinite(d.getTime())) out.set(r.taskId, d);
  }
  return out;
}

async function loadNeighbourDiffPaths(workspaceId: string, taskIds: string[], cutoff: Date, perNeighbour: number): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (taskIds.length === 0) return out;
  const result = await db.execute(neighbourDiffPathsQuery({ workspaceId, taskIds, cutoff }));
  for (const raw of (result.rows ?? []) as Array<{ taskId: string; path: string }>) {
    if (!raw?.taskId || !raw?.path) continue;
    const list = out.get(raw.taskId) ?? [];
    if (list.length < perNeighbour) list.push(raw.path);
    out.set(raw.taskId, list);
  }
  return out;
}

/** Completed neighbours with their completion date and pre-cutoff diff paths. */
export async function loadNeighbourEvidence(
  store: TaskAreaQuerier,
  args: { workspaceId: string; taskId: string; seedText: string; cutoff: Date; config?: TaskAreaConfig },
): Promise<NeighbourEvidence[]> {
  const config = args.config ?? MANIFEST_NEIGHBOUR_CONFIG;
  const found = await findNeighbourTasks(store, { workspaceId: args.workspaceId, taskId: args.taskId, seedText: args.seedText, config });
  if (found.length === 0) return [];
  const ids = found.map(n => n.taskId);
  const [completions, paths] = await Promise.all([
    loadNeighbourCompletions(args.workspaceId, ids),
    loadNeighbourDiffPaths(args.workspaceId, ids, args.cutoff, config.maxPathsPerNeighbour * 4),
  ]);
  return found.map(n => ({
    taskId: n.taskId,
    score: n.score,
    completedAt: completions.get(n.taskId) ?? null,
    paths: paths.get(n.taskId) ?? [],
  }));
}

async function defaultStore(): Promise<TaskAreaQuerier> {
  const { PgVectorStore, getVoyageEmbedder } = await import('./knowledge-store');
  return new PgVectorStore(getVoyageEmbedder()) as unknown as TaskAreaQuerier;
}

// ── The prediction ───────────────────────────────────────────────────────────

export interface CreationManifestInput {
  taskId: string;
  teamId: string;
  workspaceId: string;
  missionId?: string | null;
  accountId?: string | null;
  userId?: string | null;
  title: string;
  description?: string | null;
  /** The task row's createdAt: the leakage cutoff. */
  createdAt: Date;
  /** What the caller declared (before the route's `['**']` default). */
  callerManifest: readonly string[] | null;
  /** The base the task will branch from, for revision-scoped candidates. */
  baseRef?: string | null;
  pickCap?: number;
}

export interface CreationManifestDeps {
  resolveAccess?: OrchestrationDecisionDeps['resolveAccess'];
  call?: OrchestrationDecisionDeps['call'];
  recordDecision?: OrchestrationDecisionDeps['record'];
  onReceipt?: OrchestrationDecisionDeps['onReceipt'];
  recordPrediction?: (row: ManifestPredictionRow) => Promise<void>;
  loadNeighbours?: (args: { workspaceId: string; taskId: string; seedText: string; cutoff: Date; signal: AbortSignal }) => Promise<NeighbourEvidence[]>;
  /** Default: `getServerTreeCandidateAdapter()`. */
  tree?: TreeCandidateAdapter;
  /** Expected size from the same neighbours (jev-scheduling §3). Default: `estimateTaskSize`. */
  estimateSize?: (args: EstimateTaskSizeArgs & { signal: AbortSignal }) => Promise<ExpectedTaskSize | null>;
  /** The Jev S/M/L fallback when `estimateSize` has fewer than k neighbours (jev-scheduling §3). Default: the real `orchestration_ordering` decision call. */
  sizeBucketDeps?: EstimateExpectedSizeDeps;
  now?: () => number;
  deadlineMs?: number;
  /** The REQUESTED applying fraction (default `MANIFEST_APPLYING_FRACTION`); the promotion guard grants it. */
  applyingFraction?: number;
  /** Default: the committed `ORCHESTRATION_PROMOTIONS` (empty). */
  promotions?: readonly PromotionEvidence[];
}

export type ManifestPredictionRow = typeof orchestrationManifestPredictions.$inferInsert;

export type CreationManifestOutcome =
  | { skipped: 'caller_declared' | 'capability_disabled' | 'error' }
  | { row: ManifestPredictionRow };

/** The same "declared scope" test the creation gate uses: too-wide globs and the sentinel are missing scope. */
const isConcreteDeclaration = (m: readonly string[] | null | undefined) =>
  Array.isArray(m) && hasConcretePathManifest(m.filter((p): p is string => typeof p === 'string'));

const RETRIEVAL_DEADLINE = Symbol('retrieval_deadline');

/**
 * How sure the model is of the whole selected set (jev-scheduling §3): the
 * product of its pick confidences, the DONE pick included. A starting point
 * the readout recalibrates. Null with no picks, or when any pick has none.
 */
export function setConfidenceOf(picks: readonly Pick<ManifestPick, 'confidence'>[]): number | null {
  if (picks.length === 0) return null;
  let p = 1;
  for (const k of picks) {
    if (typeof k.confidence !== 'number' || !Number.isFinite(k.confidence)) return null;
    p *= k.confidence;
  }
  return p;
}

export async function predictCreationManifest(
  input: CreationManifestInput,
  deps: CreationManifestDeps = {},
): Promise<CreationManifestOutcome> {
  // Explicit caller manifests always win: nothing to predict.
  if (isConcreteDeclaration(input.callerManifest)) return { skipped: 'caller_declared' };

  const now = deps.now ?? (() => Date.now());
  const started = now();
  const deadlineAt = started + (deps.deadlineMs ?? ORCHESTRATION_DECISION_DEADLINE_MS);
  const remaining = () => deadlineAt - now();
  const pickCap = resolvePickCap(input.pickCap);
  const seedText = [input.title ?? '', input.description ?? ''].filter(Boolean).join('\n');
  const regexPaths = (() => { try { return inferPathsFromText(input.title, input.description); } catch { return []; } })();

  const persist = async (row: ManifestPredictionRow) => {
    try {
      await (deps.recordPrediction ?? recordManifestPrediction)(row);
    } catch (err) {
      console.warn('[manifest-prediction] record failed (non-fatal):', (err as Error)?.message ?? err);
    }
  };

  const rowOf = (
    c: ManifestCandidateSet,
    r: RepeatedChoiceResult | null,
    stop: string,
    neighbourUnion: string[],
    expectedSize: ExpectedTaskSize | null = null,
  ): ManifestPredictionRow => ({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    decisionId: MANIFEST_DECISION_ID,
    promptVersion: manifestPromptVersion(),
    candidatePolicyVersion: MANIFEST_CANDIDATE_POLICY_VERSION,
    mode: MANIFEST_PICK_MODE,
    taskCreatedAt: input.createdAt,
    candidates: c.candidates,
    candidateSources: c.sources,
    candidateCount: c.candidates.length,
    candidateTruncated: c.truncated,
    candidateOmitted: c.omitted,
    coverage: { ...c.coverage },
    picks: (r?.picks ?? []) as unknown as Array<Record<string, unknown>>,
    selected: r?.selected ?? [],
    stopReason: stop,
    complete: r?.complete ?? false,
    unknownScope: predictionUnknownScope(c, r),
    allApplied: r?.allApplied ?? false,
    pickCap,
    regexPaths,
    neighbourUnionPaths: neighbourUnion,
    setConfidence: setConfidenceOf(r?.picks ?? []),
    expectedSize,
    latencyMs: Math.max(0, Math.round(now() - started)),
  });

  try {
    // 1. Policy first: a team that has not opted in costs this one read.
    const resolveAccess = deps.resolveAccess ?? (async (opts) => {
      const { resolveDecisionAccess } = await import('./decision-client');
      return resolveDecisionAccess(opts);
    });
    let access: DecisionAccess;
    try {
      access = await resolveAccess({ capability: CAPABILITY, teamId: input.teamId, workspaceId: input.workspaceId, accountId: input.accountId ?? null, userId: input.userId ?? null });
    } catch {
      return { skipped: 'error' };
    }
    if (!access.ok && access.error.kind === 'capability_disabled') return { skipped: 'capability_disabled' };

    const emptyCandidates = buildManifestCandidates({ cutoff: input.createdAt, neighbours: [] });
    if (!access.ok) {
      // Opted in, no key: record the miss; spend nothing on retrieval.
      const row = rowOf(emptyCandidates, null, 'missing_key', []);
      await persist(row);
      return { row };
    }

    // 2. Retrieval inside the shared deadline, abandoned on expiry.
    const controller = new AbortController();
    const retrieval = (async () => {
      const loadNeighbours = deps.loadNeighbours ?? (async (a) => loadNeighbourEvidence(await defaultStore(), a));
      const tree = deps.tree ?? getServerTreeCandidateAdapter();
      const estimateSize = deps.estimateSize ?? ((a) => estimateTaskSize(a));
      const [[neighbours, expectedSize], treeResult] = await Promise.all([
        loadNeighbours({ workspaceId: input.workspaceId, taskId: input.taskId, seedText, cutoff: input.createdAt, signal: controller.signal })
          .catch((err) => { console.warn('[manifest-prediction] neighbour lookup failed:', (err as Error)?.message ?? err); return [] as NeighbourEvidence[]; })
          // The size reads the same neighbours: no second retrieval. Fewer
          // than k ⇒ the Jev S/M/L bucket fallback (jev-scheduling §3).
          .then(async (found): Promise<[NeighbourEvidence[], ExpectedTaskSize | null]> => [
            found,
            await estimateExpectedSize({
              workspaceId: input.workspaceId,
              taskId: input.taskId,
              seedText,
              cutoff: input.createdAt,
              neighbourTaskIds: found.map(n => n.taskId),
              signal: controller.signal,
              teamId: input.teamId,
              missionId: input.missionId ?? null,
              accountId: input.accountId ?? null,
              userId: input.userId ?? null,
              title: input.title,
              description: input.description ?? null,
            }, { estimateSize, ...deps.sizeBucketDeps })
              .catch((err) => { console.warn('[manifest-prediction] size estimate failed:', (err as Error)?.message ?? err); return null; }),
          ]),
        tree.lookup({ workspaceId: input.workspaceId, baseRef: input.baseRef ?? null, seedText, limit: MANIFEST_TREE_RANKED_LIMIT, signal: controller.signal })
          .catch((err): TreeCandidateResult => ({ status: 'unavailable', reason: `adapter error: ${String((err as Error)?.message ?? err).slice(0, 120)}` })),
      ]);
      return { neighbours, expectedSize, treeResult };
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raced = await Promise.race([
      retrieval,
      new Promise<typeof RETRIEVAL_DEADLINE>(resolve => { timer = setTimeout(() => resolve(RETRIEVAL_DEADLINE), Math.max(0, remaining())); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (raced === RETRIEVAL_DEADLINE) {
      controller.abort();
      retrieval.catch(() => {});
      const row = rowOf(emptyCandidates, null, 'retrieval_deadline', []);
      await persist(row);
      return { row };
    }

    const { neighbours, expectedSize, treeResult } = raced;
    const candidates = buildManifestCandidates({ cutoff: input.createdAt, neighbours, tree: treeResult, namedPaths: regexPaths });
    // Same-task neighbour-union baseline over the same leakage-filtered neighbours.
    const pastNeighbours = neighbours
      .filter(n => n.completedAt && n.completedAt.getTime() < input.createdAt.getTime())
      .map(n => ({ taskId: n.taskId, score: n.score, paths: [...n.paths] }));
    const neighbourUnion = unionNeighbourPaths(pastNeighbours, MANIFEST_NEIGHBOUR_CONFIG).paths;

    // 3. The bounded repeated Choice, every pick on the shared deadline.
    const cachedAccess = async () => access;
    const pickIdentity = manifestPickIdentity();
    const description = (input.description ?? '').slice(0, MANIFEST_STATE_DESCRIPTION_CHARS);
    const result = await runRepeatedManifestChoice({
      candidates: candidates.candidates,
      pickCap,
      deadlineAt,
      now,
      runPick: (args) => runOrchestrationDecision({
        decision: args.decision,
        question: MANIFEST_PICK_QUESTION,
        capability: CAPABILITY,
        scope: {
          teamId: input.teamId,
          workspaceId: input.workspaceId,
          missionId: input.missionId ?? null,
          taskId: input.taskId,
          accountId: input.accountId ?? null,
          userId: input.userId ?? null,
          baseRef: input.baseRef ?? null,
        },
        ruleVerdict: args.ruleVerdict,
        candidatePolicy: {
          version: MANIFEST_CANDIDATE_POLICY_VERSION,
          digest: candidateDigest(Object.values(args.labelMap)),
          count: Object.keys(args.labelMap).length,
          truncated: candidates.truncated,
        },
        buildState: async () => ({
          task: { title: input.title, description },
          alreadySelected: args.selected,
          note: candidates.coverage.source === 'tree_pinned'
            ? 'Candidates are files that exist at the base commit: files similar completed tasks changed, files ranked relevant to the task, and their neighbours. New files are never listed.'
            : 'Candidates come from files that similar completed tasks actually changed. New files are never listed.',
        }),
        isValidAnswer: args.isValidAnswer,
        cohort: {
          unitId: input.taskId,
          fraction: resolveApplyingFraction({
            decision: args.decision,
            question: MANIFEST_PICK_QUESTION,
            candidatePolicyVersion: MANIFEST_CANDIDATE_POLICY_VERSION,
            requestedFraction: deps.applyingFraction ?? MANIFEST_APPLYING_FRACTION,
            identity: pickIdentity,
            promotions: deps.promotions,
          }).fraction,
        },
        deadlineAt: args.deadlineAt,
        step: args.step,
        deps: {
          resolveAccess: cachedAccess,
          ...(deps.call ? { call: deps.call } : {}),
          ...(deps.recordDecision ? { record: deps.recordDecision } : {}),
          ...(deps.onReceipt ? { onReceipt: deps.onReceipt } : {}),
          now,
        },
      }),
    });

    const row = rowOf(candidates, result, result.stop, neighbourUnion, expectedSize);
    await persist(row);
    return { row };
  } catch (err) {
    console.warn('[manifest-prediction] failed open (non-fatal):', (err as Error)?.message ?? err);
    return { skipped: 'error' };
  }
}

// ── Writes and readout predicates ────────────────────────────────────────────

/** One row per task per candidate policy; a re-run never double-counts. Never throws. */
export async function recordManifestPrediction(row: ManifestPredictionRow): Promise<void> {
  try {
    await db.insert(orchestrationManifestPredictions).values(row).onConflictDoNothing({
      target: [orchestrationManifestPredictions.taskId, orchestrationManifestPredictions.candidatePolicyVersion],
    });
  } catch (err) {
    console.warn('[manifest-prediction] insert failed (non-fatal):', (err as Error)?.message ?? err);
  }
}

export function manifestPredictionsWhere(opts: { workspaceId: string; since: Date; until: Date }) {
  return and(
    eq(orchestrationManifestPredictions.workspaceId, opts.workspaceId),
    gte(orchestrationManifestPredictions.createdAt, opts.since),
    lt(orchestrationManifestPredictions.createdAt, opts.until),
  );
}

/**
 * Labels for one workspace's predictions in a window, for Step I's readout:
 * each prediction graded against the task's terminal touch labels (F's
 * `orchestration_touch_labels`, unioned across sessions; `landed` when the
 * task's PR merged), with candidate misses and same-task baselines. Never the
 * caller manifest. Workspace-scoped reads throughout.
 */
export async function loadManifestPredictionLabels(opts: { workspaceId: string; since: Date; until: Date; limit?: number }, deps: { loadPrDiffs?: LoadTaskPrDiffs } = {}) {
  const { labelsWhere, prWorkersWhere } = await import('./orchestration-ledger-source');
  const { orchestrationTouchLabels } = await import('./db/schema');
  const { labelManifestPrediction } = await import('./manifest-prediction');
  const predictions = await db
    .select()
    .from(orchestrationManifestPredictions)
    .where(manifestPredictionsWhere(opts))
    .limit(opts.limit ?? 5_000);
  const taskIds = [...new Set(predictions.map(p => p.taskId))];
  if (taskIds.length === 0) return [];
  const scope = { workspaceId: opts.workspaceId, taskIds };
  const [labels, prs] = await Promise.all([
    db.select({
      taskId: orchestrationTouchLabels.taskId,
      workerStatus: orchestrationTouchLabels.workerStatus,
      touchedPaths: orchestrationTouchLabels.touchedPaths,
      truncated: orchestrationTouchLabels.truncated,
      prNumber: orchestrationTouchLabels.prNumber,
    }).from(orchestrationTouchLabels).where(labelsWhere(scope)),
    db.select({ taskId: workers.taskId, mergedAt: workers.mergedAt, prNumber: workers.prNumber, prUrl: workers.prUrl }).from(workers).where(prWorkersWhere(scope)),
  ]);
  const merged = new Set((prs as Array<{ taskId: string | null; mergedAt: Date | null }>).filter(p => p.taskId && p.mergedAt).map(p => p.taskId!));
  const prRefs = [...prs, ...labels.filter(l => l.prNumber && !prs.some(pr => pr.taskId === l.taskId && pr.prNumber === l.prNumber)).map(l => ({ taskId: l.taskId, prNumber: l.prNumber }))];
  const prDiffs = await (deps.loadPrDiffs ?? loadTaskPrDiffs)(opts.workspaceId, prRefs);
  return predictions.map(p => {
    const diffs = prDiffs.get(p.taskId) ?? [];
    const taskLabels = (labels as Array<{ taskId: string; workerStatus: string; touchedPaths: string[]; truncated?: boolean }>).filter(l => l.taskId === p.taskId);
    const reasons = [
      ...diffs.filter(diff => diff.status !== 'complete').map(diff => diff.status === 'incomplete' ? `pr_diff_${diff.reason}` : 'pr_diff_closed'),
      ...(taskLabels.some(l => l.truncated && !FAILED_STATUSES.has(l.workerStatus)) ? ['touch_labels_truncated'] : []),
    ];
    const touched = taskLabels
      .map(l => ({ paths: l.touchedPaths ?? [], landed: merged.has(p.taskId), failed: FAILED_STATUSES.has(l.workerStatus) }));
    for (const diff of diffs) if (diff.status === 'complete') touched.push({ paths: diff.files, landed: merged.has(p.taskId), failed: false });
    return {
      prDiffs: diffs,
      predictionId: p.id,
      taskId: p.taskId,
      decisionId: p.decisionId,
      candidatePolicyVersion: p.candidatePolicyVersion,
      fingerprints: (p.picks as Array<{ fingerprint?: string }>).map(k => k.fingerprint ?? null),
      label: reasons.length ? {
        status: 'missing' as const, reason: 'incomplete_observation' as const, reasons,
        observedPaths: [...new Set(touched.filter(t => !t.failed).flatMap(t => t.paths))].sort(),
      } : labelManifestPrediction({
        prediction: {
          candidates: p.candidates,
          selected: p.selected,
          picks: p.picks as never,
          stop: p.stopReason as never,
          complete: p.complete,
          unknownScope: p.unknownScope || diffs.some(diff => diff.status !== 'complete'),
          allApplied: p.allApplied,
          decisionId: p.decisionId,
          candidatePolicyVersion: p.candidatePolicyVersion,
          regexPaths: p.regexPaths,
          neighbourUnionPaths: p.neighbourUnionPaths,
        },
        touched,
      }),
    };
  });
}

export type { OrchestrationDecisionRow };

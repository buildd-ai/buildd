/**
 * Early release — wiring: upstream PR raised → per-dependent decision →
 * `dependency_releases` row.
 *
 * Called from the upstream task's own PR `pull_request.opened` / `ready_for_review`
 * webhook (apps/web/src/app/api/github/webhook/route.ts). For every PENDING task
 * whose `dependsOn` names the upstream task, runs the `buildd.early_release` kind
 * (early-release-decision.ts) and writes one `dependency_releases` row. Does not
 * touch deps-gate.ts — that already reads the rows this writes.
 *
 * Because the dependent is always `pending` at this point (it has no worker or PR
 * yet), its review/CI features are always the "not started" shape — only
 * `docsOnlyUpstream` and `zeroManifestOverlap` can fire here; `terminalApproveGreenCi`
 * is for a later recheck (the reconciler), not this trigger.
 *
 * Gated on the workspace opt-in `gitConfig.earlyRelease.mode`
 * (`resolveEarlyReleaseMode`):
 *
 * - `off` (default): a true no-op. Returns before any DB or GitHub call beyond
 *   the caller-supplied `gitConfig` — no dependents are looked up, no decision is
 *   made, nothing is written.
 * - `rule_only`: runs the kind with its runtime forced to a bare `{ mode:
 *   'disabled', cheap: null }` via `runDecisionKind` directly (not
 *   `runBuilddDecision`) — `defineDecisionKind`'s override still runs regardless
 *   of runtime mode (a firing rule applies in every mode, disabled included), but
 *   no route is ever resolved and no model is ever called. Recorded with our own
 *   `onRecord` so a non-firing rule still writes a ledger row — `runBuilddDecision`'s
 *   own wrapper deliberately drops a `disabled`-mode fallback write (a truly
 *   disabled capability should record nothing), which is right for that case but
 *   wrong for this one: `rule_only` is a deliberate choice to skip Jev, not an
 *   unavailable capability, and the scheduled review needs every decision sampled.
 * - `rule_and_jev`: the full pipeline via `runBuilddDecision` — resolves the
 *   team's own decision-model route and asks it when no rule fires, with the
 *   kind's normal ledger recording.
 *
 * Every mode but `off` writes exactly one `dependency_releases` row per
 * dependent, whatever the decision — `wait` included — so the sample-collection
 * the scheduled review needs never sees a silent nothing.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { dependencyReleases, tasks, type WorkspaceGitConfig } from '@buildd/core/db/schema';
import { resolveEarlyReleaseMode, type EarlyReleaseMode } from '@/lib/early-release-mode';
import { readPinnedPrScope, type GithubGet } from '@buildd/core/pr-scope-read';
import { githubApi } from '@/lib/github';
import {
  type DecisionRequest,
  type DecisionResponse,
  runDecisionKind,
} from '@builddai/ai-kit/decide';
import {
  runBuilddDecision,
  toDecisionLedgerInput,
  type BuilddDecisionDeps,
  type BuilddDecisionScope,
} from '@buildd/core/decision-policy';
import { recordDecision, type DecisionLedgerInput } from '@buildd/core/decision-ledger';
import type { DecisionSource } from '@buildd/core/decision-kinds';
import type { EstimateTaskSizeArgs, ExpectedTaskSize } from '@buildd/core/task-size-estimate';
import {
  dependentSizeBucket,
  earlyReleaseKind,
  type EarlyReleaseFeatures,
  type EarlyReleaseKindDecision,
} from './early-release-decision';

/**
 * The caller-input shape `parseEarlyReleaseFeatures` actually reads — NOT
 * `EarlyReleaseFeatures` itself, which also carries `upstreamDiff` and
 * `declaredOverlap`: fields the kind derives from this input during parsing
 * and never reads back from the caller (see early-release-decision.ts). The
 * kit's `DecisionRequest<F>` is typed as the kind's post-parse `F` for every
 * caller regardless, so this is cast through at the one call site below
 * rather than threaded through the kit's types.
 */
interface EarlyReleaseRawInput {
  upstreamChangedFiles: string[];
  upstreamLinesChanged: number;
  dependentPathManifest: string[] | null;
  predictedManifestCandidates: string[] | null;
  review: { state: 'not_requested'; merged: false; reviewTaskId: null; reviewHeadSha: null; reviewEquivalentHeadShas: [] };
  currentHeadSha: null;
  ci: 'unknown';
  sizeBucket: EarlyReleaseFeatures['sizeBucket'];
}

export { EARLY_RELEASE_MODES, resolveEarlyReleaseMode, type EarlyReleaseMode } from '@/lib/early-release-mode';

export interface EarlyReleasePendingDependent {
  id: string;
  title: string;
  /** The dependent's own author-declared manifest. Never a predicted one — see early-release-rules.ts. */
  pathManifest: string[] | null;
}

export interface DispatchEarlyReleaseInput {
  workspaceId: string;
  teamId: string;
  gitConfig: WorkspaceGitConfig | null | undefined;
  upstreamTaskId: string;
  upstreamPrNumber: number;
  /** The upstream PR's head branch — stamped as `baseBranch` on a `start_stacked` row. */
  upstreamBranch: string;
  repoFullName: string;
  installationId: number;
  /** From the webhook payload's `pull_request.additions`/`.deletions`, when GitHub sent them. */
  upstreamAdditions?: number | null;
  upstreamDeletions?: number | null;
}

export interface EarlyReleaseDispatchDeps {
  findPendingDependents?: (upstreamTaskId: string) => Promise<EarlyReleasePendingDependent[]>;
  /** The upstream PR's changed-file list, or null when it could not be read completely (closed, truncated, moved mid-read). */
  getUpstreamDiffFiles?: (input: { repoFullName: string; prNumber: number; installationId: number }) => Promise<string[] | null>;
  insertRelease?: (row: {
    dependentTaskId: string;
    upstreamTaskId: string;
    upstreamPrNumber: number;
    decision: EarlyReleaseKindDecision;
    source: DecisionSource;
    reasonCode: string;
    baseBranch: string | null;
  }) => Promise<void>;
  /** Ledger write for every decision, `rule_only`'s own and `rule_and_jev`'s default both route through this. Default `recordDecision`. */
  record?: (input: DecisionLedgerInput) => Promise<string | null | void>;
  /** Passed through to `runBuilddDecision` for `rule_and_jev` only (`record` above is layered on top via `decisionDeps.record`). */
  decisionDeps?: Omit<BuilddDecisionDeps, 'record'>;
  /** `dependentSizeBucket`'s own seam — stub in tests to avoid a DB-backed neighbour query. */
  estimateSize?: (args: EstimateTaskSizeArgs) => Promise<Pick<ExpectedTaskSize, 'files'> | null>;
  now?: () => Date;
}

export interface EarlyReleaseDispatchResult {
  mode: EarlyReleaseMode;
  releases: Array<{
    dependentTaskId: string;
    decision: EarlyReleaseKindDecision;
    source: DecisionResponse['source'];
    reasonCode: string;
  }>;
}

const defaultFindPendingDependents = async (upstreamTaskId: string): Promise<EarlyReleasePendingDependent[]> =>
  db
    .select({ id: tasks.id, title: tasks.title, pathManifest: tasks.pathManifest })
    .from(tasks)
    .where(
      and(
        sql`${tasks.dependsOn}::jsonb @> ${JSON.stringify([upstreamTaskId])}::jsonb`,
        eq(tasks.status, 'pending'),
      ),
    );

const defaultGetUpstreamDiffFiles = async (input: {
  repoFullName: string;
  prNumber: number;
  installationId: number;
}): Promise<string[] | null> => {
  const get: GithubGet = (path) => githubApi(input.installationId, path);
  const scope = await readPinnedPrScope(get, { repoFullName: input.repoFullName, prNumber: input.prNumber });
  return scope.status === 'complete' ? scope.files : null;
};

const defaultInsertRelease: NonNullable<EarlyReleaseDispatchDeps['insertRelease']> = async (row) => {
  await db.insert(dependencyReleases).values(row);
};

/**
 * One kind call for one dependent: `rule_only` never resolves a route or calls a
 * model (override still runs); `rule_and_jev` is the kind's full pipeline.
 */
async function decideForDependent(
  mode: Exclude<EarlyReleaseMode, 'off'>,
  request: DecisionRequest<EarlyReleaseFeatures>,
  scope: BuilddDecisionScope,
  deps: EarlyReleaseDispatchDeps,
) {
  const record = deps.record ?? recordDecision;
  if (mode === 'rule_only') {
    return runDecisionKind(earlyReleaseKind, request, { mode: 'disabled', cheap: null, escalation: null, unavailable: null }, {
      onRecord: async (response) => {
        await record(toDecisionLedgerInput(response, scope));
      },
    });
  }
  return runBuilddDecision(earlyReleaseKind, request, scope, { ...deps.decisionDeps, record });
}

/**
 * Entry point: the upstream PR's `pull_request.opened` / `ready_for_review`
 * webhook. See the module doc comment for the per-mode contract.
 */
export async function dispatchEarlyRelease(
  input: DispatchEarlyReleaseInput,
  deps: EarlyReleaseDispatchDeps = {},
): Promise<EarlyReleaseDispatchResult> {
  const mode = resolveEarlyReleaseMode(input.gitConfig);
  if (mode === 'off') return { mode, releases: [] };

  const findPendingDependents = deps.findPendingDependents ?? defaultFindPendingDependents;
  const dependents = await findPendingDependents(input.upstreamTaskId);
  if (dependents.length === 0) return { mode, releases: [] };

  const getUpstreamDiffFiles = deps.getUpstreamDiffFiles ?? defaultGetUpstreamDiffFiles;
  const files = await getUpstreamDiffFiles({
    repoFullName: input.repoFullName,
    prNumber: input.upstreamPrNumber,
    installationId: input.installationId,
  });
  // An unreadable diff is not evidence of anything either way — leave today's
  // merge-gated default in place rather than decide on a partial read.
  if (!files) return { mode, releases: [] };

  const upstreamLinesChanged = (input.upstreamAdditions ?? 0) + (input.upstreamDeletions ?? 0);
  const insertRelease = deps.insertRelease ?? defaultInsertRelease;
  const now = deps.now ?? (() => new Date());

  const releases: EarlyReleaseDispatchResult['releases'] = [];
  for (const dependent of dependents) {
    const sizeBucket = await dependentSizeBucket(
      { workspaceId: input.workspaceId, taskId: dependent.id, seedText: dependent.title, cutoff: now() },
      deps.estimateSize ? { estimateSize: deps.estimateSize } : {},
    );

    const rawFeatures: EarlyReleaseRawInput = {
      upstreamChangedFiles: files,
      upstreamLinesChanged,
      dependentPathManifest: dependent.pathManifest,
      predictedManifestCandidates: null,
      // Always the "not started" shape: the dependent is pending by construction
      // (the SQL filter above), so it has no worker, PR, review or CI yet.
      review: { state: 'not_requested', merged: false, reviewTaskId: null, reviewHeadSha: null, reviewEquivalentHeadShas: [] },
      currentHeadSha: null,
      ci: 'unknown',
      sizeBucket,
    };

    const scope: BuilddDecisionScope = { teamId: input.teamId, workspaceId: input.workspaceId, taskId: dependent.id };
    const request: DecisionRequest<EarlyReleaseFeatures> = {
      // `parseEarlyReleaseFeatures` (called inside the kind) reads this raw
      // shape and derives `upstreamDiff`/`declaredOverlap` itself — see
      // `EarlyReleaseRawInput`'s doc comment.
      features: rawFeatures as unknown as EarlyReleaseFeatures,
      subjectRef: { type: 'task', id: dependent.id },
    };

    const response = await decideForDependent(mode, request, scope, deps);
    const decision = response.decision as EarlyReleaseKindDecision;
    const baseBranch = decision === 'start_stacked' ? input.upstreamBranch : null;

    await insertRelease({
      dependentTaskId: dependent.id,
      upstreamTaskId: input.upstreamTaskId,
      upstreamPrNumber: input.upstreamPrNumber,
      decision,
      source: response.source,
      reasonCode: response.reasonCode,
      baseBranch,
    });
    releases.push({ dependentTaskId: dependent.id, decision, source: response.source, reasonCode: response.reasonCode });
  }

  return { mode, releases };
}

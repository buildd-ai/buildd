/**
 * What a finished experiment schedules for itself.
 *
 * A concluded experiment leaves scaffolding behind — a schedule that still
 * ticks, a guard that still pins a version, a CLI, a published artifact. The
 * previous answer to that was a notification saying "remember to clean this
 * up", which is a reminder, and a reminder is a task nobody owns. So the
 * terminal verdict files real work instead.
 *
 * ── Why the description is this explicit ────────────────────────────────────
 *
 * "Clean up the finished experiment" is an instruction an agent can satisfy by
 * deleting the readout module, the CLI, the pin guard and the published
 * artifact. Every one of those is either the reusable half (the next experiment
 * computes its readout with the same code) or the record of the result. None of
 * them is what "finished" licenses removing.
 *
 * The prohibitions are therefore stated as a list of named assets with reasons,
 * not left to judgement, and `packages/core/__tests__/experiment-cleanup.test.ts`
 * pins each name so a later edit that drops one fails a test rather than
 * quietly widening the blast radius.
 *
 * ── The two stages ─────────────────────────────────────────────────────────
 *
 * Retirement is not one event:
 *
 *  1. **The schedule** can retire at the verdict. The stopping rule is
 *     satisfied, so more rows cannot move the answer and every further tick is
 *     pure cost.
 *  2. **The pin guard** cannot. It is what makes the cohort's rows comparable;
 *     a later change to the measured path that did not bump the policy version
 *     would silently rebase a cohort someone may still re-analyse. It stays
 *     until the experiment's decision is recorded.
 *
 * Only stage one is automatable, because stage two is gated on a human writing
 * the decision down. The task says so rather than implying that "cleanup" is
 * finished when the cron is gone.
 *
 * ── What this task is NOT ──────────────────────────────────────────────────
 *
 * The experiment's decision — keep the treatment or revert it — is a separate
 * human call. A cleanup task that assumed it would ship a behaviour change on
 * the strength of an interval nobody had read yet, which is the one outcome an
 * experiment exists to prevent.
 */

import { eq } from 'drizzle-orm';
import { workspaces } from './db/schema';
import { READOUT_POLICY_VERSION } from './memory-digest-readout';

/**
 * Namespace for the cleanup task's subject signature.
 *
 * A namespaced system signature (`namespace:slug`) is what
 * `normalizeErrorSignature` accepts, which makes this an `error`-kind anchor —
 * and `error` is in `IDENTIFYING_SUBJECT_KEY_TYPES`, so a live match is precise
 * enough to STOP a second filing. That is the second line of defence; the
 * once-ever `system_cache` claim is the first. There is deliberately no third.
 */
export const EXPERIMENT_CLEANUP_SIGNATURE_NS = 'experiment-cleanup';

/** Title prefix, so the task is greppable the way `[friction] ` tasks are. */
export const EXPERIMENT_CLEANUP_TITLE_PREFIX = '[experiment cleanup] ';

/** `tasks.context.type` discriminator for a cleanup filing. */
export const EXPERIMENT_CLEANUP_CONTEXT_TYPE = 'experiment-cleanup';

export function experimentCleanupSignature(slug: string): string {
  return `${EXPERIMENT_CLEANUP_SIGNATURE_NS}:${slug}`;
}

/** A named file or asset, with the reason it is on the list it is on. */
export interface CleanupAsset {
  path: string;
  why: string;
}

export interface ExperimentCleanupSpec {
  /** Stable experiment identity. For memory-digest this is the policy version. */
  slug: string;
  /** Human label used in the title and the opening line. */
  label: string;
  /** The terminal verdict that triggered this filing. */
  verdict: string;
  /** Where the verdict is published, when it could be written. */
  artifactUrl: string | null;
  /** The branch the cleanup PR targets. */
  baseBranch: string;
  /** Stage one: what this task removes, and what stops as a result. */
  scaffolding: CleanupAsset[];
  /** Must survive. Each entry states why removing it would be a loss. */
  keep: CleanupAsset[];
  /** Unreferenced afterwards; removing it is the PR author's call. */
  optional: CleanupAsset[];
  /** Stage two: what stays until the decision is recorded, and why. */
  stageTwo: string;
  /** Narrow path manifest for the filed task. */
  pathManifest: string[];
}

export function experimentCleanupTitle(spec: ExperimentCleanupSpec): string {
  return `${EXPERIMENT_CLEANUP_TITLE_PREFIX}retire the ${spec.slug} readout schedule`;
}

function bullets(assets: CleanupAsset[]): string {
  return assets.map(a => `- \`${a.path}\` — ${a.why}`).join('\n');
}

function numbered(assets: CleanupAsset[]): string {
  return assets.map((a, i) => `${i + 1}. \`${a.path}\` — ${a.why}`).join('\n');
}

/**
 * The task description.
 *
 * Written as prose an agent reads top-to-bottom, with the prohibitions above
 * the optional section so the narrow reading is the first one available.
 */
export function buildExperimentCleanupDescription(spec: ExperimentCleanupSpec): string {
  const artifactLine = spec.artifactUrl
    ? `Readout artifact: ${spec.artifactUrl}`
    : 'The readout artifact could not be written on the run that filed this task — read the last persisted readout, or re-run the CLI, before assuming anything about the result.';

  return `${spec.label} has reached a terminal verdict (\`${spec.verdict}\`). The readout is
published and will not change with more data. This task retires the experiment's
**scaffolding** and nothing else.

${artifactLine}

## DO

${numbered(spec.scaffolding)}

Then open a PR to \`${spec.baseBranch}\`.

## DO NOT remove or modify

These are not leftovers. Removing any of them is a regression, not cleanup.

${bullets(spec.keep)}

## Optional — the PR author's judgement, NOT required by this task

${bullets(spec.optional)}

Either answer is acceptable. Say which you chose, and why, in the PR body.

## Two stages, and why only stage one is automated

**Stage one is this task**: the schedule. It can retire now because the
experiment's stopping rule is satisfied — more data adds nothing to the verdict,
so every further tick is pure cost.

**Stage two is NOT this task**: ${spec.stageTwo}

Stage two cannot be automated from a verdict, because it is gated on a human
writing the decision down. Do not do it here, and do not treat the experiment as
tidied up once the cron is gone.

## This task does NOT decide the experiment

Keeping or reverting the treatment is a separate human call, recorded elsewhere.
Do not make it, do not assume it, and do not change any run-time behaviour on the
strength of the verdict. If the diff of this PR changes what an agent does at run
time, it is out of scope — drop it and say so.`;
}

/**
 * One line for the terminal-verdict push.
 *
 * Says it plainly when no task could be filed: silence there is
 * indistinguishable from success, and the recipient would never learn that the
 * manual step is back on them. The push's `url` stays pointed at the artifact —
 * the verdict is what the notification is about.
 */
export function cleanupNoticeLine(taskId: string | null, error: string | null): string {
  if (taskId) return `Cleanup task filed: ${taskId} (retires the readout schedule).`;
  return `NO cleanup task could be filed${error ? ` (${error})` : ''} — retire the readout schedule by hand.`;
}

/**
 * Scope for the workspace row the filed task is dispatched against.
 *
 * Exported and rendered through `PgDialect` in the tests rather than asserted
 * over a mocked `db`: mocking the client makes every predicate unobservable,
 * which is how a class of wrong-column bug has survived in this repo before.
 */
export function cleanupTaskWorkspaceScope(workspaceId: string) {
  return eq(workspaces.id, workspaceId);
}

/**
 * The memory-digest experiment's cleanup spec.
 *
 * Concrete paths, verified against the tree. The shape above is general because
 * `docs/design/experiment-lifecycle.md` makes "the `retired` state emits a
 * scoped cleanup task" the rule for every experiment, not just this one.
 */
export function memoryDigestCleanupSpec(opts: {
  verdict: string;
  artifactUrl: string | null;
}): ExperimentCleanupSpec {
  return {
    slug: READOUT_POLICY_VERSION,
    label: 'The workspace-memory-digest experiment',
    verdict: opts.verdict,
    artifactUrl: opts.artifactUrl,
    baseBranch: 'dev',
    scaffolding: [
      {
        path: 'cron-manifest.json',
        why:
          'remove the whole `/api/cron/memory-digest-readout` job object (not `enabled: false`) so `bun run cron:sync` deletes the job at the external scheduler and the daily tick stops. This file is the single source of truth for the scheduler, so nothing else can stop it',
      },
    ],
    keep: [
      {
        path: 'packages/core/memory-digest-readout.ts',
        why:
          'the reusable half: the arithmetic, the power calculation and the verdict rules. The next experiment computes its readout with this, so it is not this experiment\'s property',
      },
      {
        path: 'packages/core/memory-digest-readout-source.ts',
        why: 'the cohort queries and the artifact/claim helpers, reusable for the same reason',
      },
      {
        path: 'packages/core/scripts/memory-digest-readout.ts',
        why: 'the CLI. It is how anyone re-reads the analysis once the schedule is gone',
      },
      {
        path: 'readout:memory-digest',
        why: 'the `package.json` script that runs that CLI. Deleting it strands the CLI',
      },
      {
        path: 'packages/core/__tests__/memory-digest-readout-policy-pin.test.ts',
        why: 'the policy-version pin guard. It MUST outlive the verdict — see "two stages" below',
      },
      {
        path: 'apps/runner/__tests__/unit/memory-digest-policy-version-pin.test.ts',
        why: 'the runner-side half of the same pin. Same rule',
      },
      {
        path: `memory-digest-readout:${READOUT_POLICY_VERSION}`,
        why:
          'the published `analysis` artifact under that `artifacts.key`. It is the verdict of record, and the reason the experiment is re-readable at all',
      },
      {
        path: 'system_cache',
        why:
          'the `memory-digest-readout:notified:*` claim row and `memory-digest-readout:latest`. Deleting the claim row un-retires the route and re-arms a notification that was already delivered',
      },
      {
        path: 'apps/runner/src/memory-digest-policy.ts',
        why:
          'the arm-assignment code. Changing or removing it IS the experiment\'s decision, not its cleanup — see the last section',
      },
    ],
    optional: [
      {
        path: 'apps/web/src/app/api/cron/memory-digest-readout/',
        why:
          'once the manifest entry is gone this route (and its co-located test) is unreferenced. Deleting it is a judgement call and is NOT required by this task. If you keep it, `scripts/cron-coverage.test.ts` requires every `/api/cron/*` route to appear in `cron-manifest.json` exactly once, so you must satisfy that gate; if you delete it, you lose the delivery tests along with it',
      },
    ],
    stageTwo:
      'the policy-version pin guard stays until the experiment\'s decision is recorded. The guard is what makes the cohort\'s rows comparable — a later change to the measured retrieval path that did not bump the policy version would silently rebase a cohort someone may still re-analyse, turning a reproducible analysis into an unreproducible one.',
    pathManifest: ['cron-manifest.json', 'apps/web/src/app/api/cron/memory-digest-readout/**'],
  };
}

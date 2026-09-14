/**
 * Files the cleanup task a finished experiment schedules for itself.
 *
 * The "what" — the narrow scope, the explicit prohibitions, the two-stage split
 * — lives in `@buildd/core/experiment-cleanup`, which is pure and testable
 * without a database. This module is only the filing: one insert and a
 * best-effort dispatch, in the shape every other server-side filer in this
 * repo uses (`lib/release-health-watcher.ts`, `lib/mission-surface-audit.ts`,
 * `lib/reviewer.ts`) rather than an HTTP call to `POST /api/tasks`, which a
 * cron has no credential for.
 *
 * ── Dedupe: one mechanism, plus a net ──────────────────────────────────────
 *
 * There is deliberately no liveness query here. The caller gates this on the
 * once-ever `system_cache` claim that already gates the terminal notification,
 * and that claim is the dedupe — a second check-then-act would be a parallel
 * mechanism that can disagree with the first.
 *
 * What this module adds is a *subject anchor*, so buildd's existing dedupe is a
 * second line of defence behind the claim: an `error`-kind anchor whose
 * signature is `experiment-cleanup:<slug>`. `error` is in
 * `IDENTIFYING_SUBJECT_KEY_TYPES`, so a live match on it is precise enough to
 * stop a filing — which means a human or an agent re-filing the same cleanup
 * through the API or MCP collapses onto this task instead of duplicating it.
 * `source: 'system'` because the machinery asserted the subject; it was not
 * scraped from prose.
 *
 * ── Never load-bearing ─────────────────────────────────────────────────────
 *
 * Every failure path returns or throws to a caller that swallows it. The
 * verdict's delivery — the persisted readout, the published artifact, the push
 * — must not depend on a task insert succeeding.
 */

import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import {
  EXPERIMENT_CLEANUP_CONTEXT_TYPE,
  buildExperimentCleanupDescription,
  cleanupTaskWorkspaceScope,
  experimentCleanupSignature,
  experimentCleanupTitle,
  type ExperimentCleanupSpec,
} from '@buildd/core/experiment-cleanup';
import { extractSubjectAnchor } from '@buildd/core/subject-anchor-extractor';
import { projectSubjectAnchor } from '@buildd/core/subject-anchor-observe';
import { dispatchNewTask } from '@/lib/task-dispatch';

export interface FileExperimentCleanupTaskParams {
  /**
   * Where the task is filed.
   *
   * The caller passes the workspace the readout artifact was written to, so the
   * cleanup task lands next to the verdict a human just got a link to. That
   * also means there is exactly one workspace-resolution rule for this
   * experiment (`resolveReadoutArtifactWorkspaceId`), not two that can drift.
   */
  workspaceId: string;
  spec: ExperimentCleanupSpec;
}

export async function fileExperimentCleanupTask(
  params: FileExperimentCleanupTaskParams,
): Promise<{ id: string } | null> {
  const { workspaceId, spec } = params;

  const anchor = extractSubjectAnchor({
    systemContext: {
      origin: 'watcher',
      errorSignature: experimentCleanupSignature(spec.slug),
    },
  }).anchor;
  const subjectValues = anchor ? projectSubjectAnchor(anchor) : {};

  const title = experimentCleanupTitle(spec);
  const description = buildExperimentCleanupDescription(spec);

  const [task] = await db
    .insert(tasks)
    .values({
      workspaceId,
      title,
      description,
      status: 'pending',
      mode: 'execution',
      category: 'chore',
      // A PR is the deliverable. Without this the gate accepts a completion
      // that only *describes* removing the manifest entry.
      outputRequirement: 'pr_required',
      priority: 5,
      // The closest truthful value in the enum: filed by server-side machinery
      // reacting to an event, same as the release-degradation filer. There is
      // no `cron` source, and `schedule` means "a task_schedules row spawned
      // this" and carries a reverse-lookup FK that does not exist here.
      creationSource: 'webhook',
      // Narrow on purpose: the claim-time overlap guard and the orchestrator
      // both read this, and it is the machine-readable half of "scaffolding
      // only".
      pathManifest: spec.pathManifest,
      context: {
        type: EXPERIMENT_CLEANUP_CONTEXT_TYPE,
        experimentSlug: spec.slug,
        verdict: spec.verdict,
        artifactUrl: spec.artifactUrl,
        // Read by the runner when it opens the PR.
        baseBranch: spec.baseBranch,
      },
      ...subjectValues,
    })
    .returning({ id: tasks.id });

  if (!task?.id) return null;

  // Best-effort: the row exists and a runner will claim it on its next poll
  // whether or not the realtime fan-out worked.
  try {
    const [workspace] = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        repo: workspaces.repo,
        webhookConfig: workspaces.webhookConfig,
        githubInstallationId: workspaces.githubInstallationId,
        githubRepoId: workspaces.githubRepoId,
      })
      .from(workspaces)
      .where(cleanupTaskWorkspaceScope(workspaceId))
      .limit(1);

    await dispatchNewTask(
      { id: task.id, title, description, workspaceId },
      workspace ?? { id: workspaceId },
    );
  } catch (err) {
    console.error('[experiment-cleanup] dispatch failed:', err);
  }

  return { id: task.id };
}

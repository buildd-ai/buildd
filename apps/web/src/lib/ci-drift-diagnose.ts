/**
 * Schema-drift CI failures are diagnose-only — never auto-fixed.
 *
 * `packages/core/db/schema.ts` and `drizzle/` sit behind `escalateToPaths`
 * because an agent reconciling a schema against production papers over
 * whatever actually caused the divergence, and that gate exists because of a
 * real prior outage. The same rule applies here, one level earlier: when the
 * failing *check* is the drift job itself, no fix agent — automatic or
 * manual — may run. A human decides whether a migration is the answer.
 *
 * Classification is by CHECK NAME, not by guessing from log text: the
 * `check_suite` webhook carries no structured failure reason, so the failed
 * job's display `name` (from `fetchCIFailureLogs`, which reads
 * `GET /actions/runs/{id}/jobs`) is the only reliable signal available. The
 * name below is `.github/workflows/build.yml`'s `schema-drift` job's own
 * `name:` field — GitHub Actions uses that as the check run's displayed name.
 * If that job is ever renamed, this constant must be updated too.
 */

export const SCHEMA_DRIFT_JOB_NAME = 'Schema Drift / check-prod';

/** True when any failed job in the run is the schema-drift check. */
export function isSchemaDriftFailure(failedJobNames: string[] | null | undefined): boolean {
  const target = SCHEMA_DRIFT_JOB_NAME.toLowerCase();
  return (failedJobNames ?? []).some((name) => name.trim().toLowerCase() === target);
}

export interface DriftDiagnoseParams {
  originalTask: {
    id: string;
    title: string;
    workspaceId: string;
    missionId?: string | null;
  };
  repoFullName: string;
  prNumber: number;
  headSha: string;
  failureContext: string;
  ciRunUrl?: string | null;
}

export interface DriftDiagnoseTask {
  title: string;
  description: string;
  workspaceId: string;
  parentTaskId: string;
  creationSource: 'webhook' | 'dashboard';
  taskClass: 'attempt';
  missionId: string | null;
  outputRequirement: 'artifact_required';
  context: Record<string, unknown>;
}

/**
 * Build a diagnose-and-report task for a schema-drift CI failure.
 *
 * Unlike `buildCIRetryTask`, this never returns null — a drift failure always
 * gets a diagnose task; there is no retry budget to exhaust because this task
 * never touches the schema or the database, so there is nothing to bound.
 */
export function buildDriftDiagnoseTask(params: DriftDiagnoseParams): DriftDiagnoseTask {
  const { originalTask, repoFullName, prNumber, headSha, failureContext, ciRunUrl } = params;

  return {
    title: `[CI Diagnose] Schema drift on PR #${prNumber}`,
    description: `The schema-drift check failed on ${repoFullName} PR #${prNumber} (SHA: ${headSha}) for "${originalTask.title}".

## This is a DIAGNOSE-ONLY task

Schema drift failures are never auto-fixed, automatically or manually. Reconciling
a schema against production papers over whatever actually caused the divergence —
that rule exists because of a real prior outage. Do not weaken it here.

- Do **not** generate or apply a migration.
- Do **not** touch the production database.
- Do **not** open a PR.
- Submit your findings as an artifact (\`type: report\`): what actually diverged
  (a migration never generated, a manual prod change, a drizzle-kit ordering
  issue, etc.), the evidence for it, and a recommended next step for a human
  to take deliberately.

## Why this was classified as drift

Identified by check name only — the \`check_suite\` webhook carries no
structured failure reason, so the failing job's display name was compared
against \`"${SCHEMA_DRIFT_JOB_NAME}"\` (the \`schema-drift\` job in
\`.github/workflows/build.yml\`). This is the only reliable signal available.

## Failure context

\`\`\`
${failureContext}
\`\`\`
${ciRunUrl ? `\nRun: ${ciRunUrl}` : ''}`,
    workspaceId: originalTask.workspaceId,
    parentTaskId: originalTask.id,
    creationSource: 'webhook',
    taskClass: 'attempt',
    missionId: originalTask.missionId ?? null,
    outputRequirement: 'artifact_required',
    context: {
      driftDiagnosis: true,
      prNumber,
      headSha,
      repoFullName,
    },
  };
}

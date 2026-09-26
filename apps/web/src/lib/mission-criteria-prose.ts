import { db } from '@buildd/core/db';
import { missions, tasks, workspaces, secrets } from '@buildd/core/db/schema';
import { eq, and, or, desc, sql } from 'drizzle-orm';
import { recalculateOverall, criterionFingerprint } from '@buildd/core/mission-helpers';
import type { GoalCriteriaState, GoalCriterion } from '@buildd/shared';
import { dispatchNewTask } from '@/lib/task-dispatch';

/**
 * `description` (prose) goal criteria under the `runner` grader: one read-only
 * verification task per criterion, claimed by one of the team's runners.
 *
 * The `api` grader (`mission-criteria-eval.ts` → `inferenceCall`) needs an API
 * key and bills per token. A team that runs on OAuth subscription seats has no
 * such key, and an inference call structurally cannot use a seat (see
 * `inference-client.ts`). A dispatched agent run can: the claim route resolves
 * whatever backend credential the team connected, OAuth included. So the runner
 * grader is the same machinery `command` criteria use
 * (`mission-criteria-verify.ts`), with a structured verdict instead of an exit
 * code.
 *
 * Shape, mirroring command criteria:
 *   1. `resolveProseCriterion` — per (mission, criterion): reuse an open task
 *      (`pending`), reuse a fresh terminal result (`verdict`), or dispatch one.
 *      One task per criterion, not a batch: each verdict lands on its own and a
 *      slow or stuck grading run holds up only the criterion it is about.
 *   2. `handleProseEvalOutcome` — from the worker-completion hook: map the
 *      task's `structuredOutput` onto its criterion, re-fold, re-attempt
 *      completion.
 *
 * Verdict mapping ({@link mapProseOutcome}): `pass`/`fail` land as-is; `unsure`,
 * a failed/cancelled task, and missing or malformed output all land as
 * NOT_EVALUATED with the reason — never a silent pass, never a silent fail.
 */

/** Context marker on a prose verification task, read back on completion. */
export interface ProseEvalContext {
  missionId: string;
  criterionIndex: number;
  /**
   * `criterionFingerprint()` of the criterion as asked. An index alone is a
   * position, and positions get reused when criteria are edited.
   */
  fingerprint: string;
}

/**
 * How long a finished grading run stays authoritative. Also the loop guard: a
 * run that ended without a usable verdict is not retried until this elapses,
 * so a criterion whose runner keeps coming back empty costs one agent run per
 * TTL rather than one per evaluation round.
 */
export const PROSE_VERDICT_TTL_MS = 30 * 60 * 1000;

/**
 * How long a verification task may sit unclaimed before the criterion says it
 * is waiting for a runner. Past this, "verifying" is no longer the honest
 * description: nothing is verifying it, and the completion gate would otherwise
 * hold on a criterion that reads as in-progress indefinitely.
 */
export const RUNNER_WAIT_BOUND_MS = 15 * 60 * 1000;

const REASON_MAX = 400;
const VERIFY_TASK_TITLE_PREFIX = 'Verify goal criterion:';

/** Backend credentials a runner can actually grade with. */
const AGENT_BACKEND_PURPOSES = ['oauth_token', 'anthropic_api_key', 'claude_credential', 'codex_credential'] as const;

/** JSON Schema handed to the SDK's outputFormat. */
export const PROSE_EVAL_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'reason'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'fail', 'unsure'],
      description: 'pass = you confirmed it holds, fail = you confirmed it does not, unsure = you could not tell',
    },
    reason: {
      type: 'string',
      maxLength: REASON_MAX,
      description: 'One or two sentences a reviewer can check: what you looked at and what it showed',
    },
    evidence: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional pointers you relied on: PR URLs, file paths, task or artifact ids',
    },
  },
  additionalProperties: false,
} as const;

export interface ProseRunnerEvidence {
  /** Deliverable tasks of the mission, with PR state. */
  deliverables: Array<{
    id: string;
    title: string | null;
    status: string;
    prUrl: string | null;
    prNumber: number | null;
    merged: boolean;
  }>;
  /** Artifacts as pointers — id, title, type, key. Content is never embedded. */
  artifacts: Array<{ id: string; title: string | null; type: string; key?: string | null }>;
}

export interface ProseCriterionInput {
  missionId: string;
  criterionIndex: number;
  text: string;
  fingerprint: string;
  evidence: ProseRunnerEvidence;
  now?: number;
}

export type ProseCriterionResolution =
  | { kind: 'pending'; taskId: string; evidence: string; awaitingRunner: boolean }
  | { kind: 'verdict'; verdict: 'pass' | 'fail' | 'NOT_EVALUATED'; taskId: string; evidence: string; evaluatedAt: string }
  | { kind: 'unavailable'; evidence: string };

const TERMINAL = ['completed', 'failed', 'cancelled'];

function readMarker(context: unknown): ProseEvalContext | null {
  const m = (context as Record<string, unknown> | null)?.criteriaProseEval as ProseEvalContext | undefined;
  if (!m || typeof m.missionId !== 'string' || typeof m.criterionIndex !== 'number') return null;
  return m;
}

/** True when this task is a prose criterion verification task (cheap context check). */
export function isProseEvalTask(context: unknown): boolean {
  return readMarker(context) !== null;
}

function short(id: string): string {
  return id.slice(0, 8);
}

function quote(text: string): string {
  const t = text.trim();
  return `“${t.length > 80 ? t.slice(0, 80) + '…' : t}”`;
}

/**
 * The newest verification task for one criterion, open or finished.
 *
 * Matched on the marker in SQL, not by scanning recent bookkeeping rows: a
 * heartbeat mission writes a bookkeeping row every cycle, so any fixed window
 * eventually holds nothing but heartbeat rows and the dedupe goes dead.
 */
async function findProseEvalTask(missionId: string, criterionIndex: number) {
  const rows = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, missionId),
      sql`${tasks.context} -> 'criteriaProseEval' ->> 'missionId' = ${missionId}`,
      sql`${tasks.context} -> 'criteriaProseEval' ->> 'criterionIndex' = ${String(criterionIndex)}`,
    ),
    columns: { id: true, status: true, context: true, result: true, createdAt: true, updatedAt: true },
    orderBy: [desc(tasks.createdAt)],
    limit: 5,
  });
  // Re-check in JS so a mocked or loose `where` can never widen the match.
  return rows.find(r => {
    const m = readMarker(r.context);
    return m?.missionId === missionId && m.criterionIndex === criterionIndex;
  }) ?? null;
}

/**
 * True when the team has a credential a runner could grade with. When it has
 * none, the criterion names the screen that fixes it instead of dispatching a
 * task no runner can ever claim.
 */
async function hasAgentBackendCredential(teamId: string | null): Promise<boolean> {
  if (!teamId) return false;
  const row = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.teamId, teamId),
      or(...AGENT_BACKEND_PURPOSES.map(p => eq(secrets.purpose, p))),
    ),
    columns: { id: true },
  });
  return !!row;
}

/**
 * Map a finished verification task onto a criterion verdict.
 *
 * Only an explicit, well-formed `pass` or `fail` from a task that completed is a
 * verdict. Everything else is NOT_EVALUATED with the reason, so the completion
 * gate keeps holding and the operator can see why.
 */
export function mapProseOutcome(
  status: string,
  structuredOutput: unknown,
  taskId: string,
): { verdict: 'pass' | 'fail' | 'NOT_EVALUATED'; evidence: string } {
  if (status !== 'completed') {
    return {
      verdict: 'NOT_EVALUATED',
      evidence: `Verification task ${short(taskId)} ${status} on the runner before returning a verdict (an infrastructure failure). A later round re-grades it.`,
    };
  }
  const out = structuredOutput && typeof structuredOutput === 'object' ? structuredOutput as Record<string, unknown> : null;
  const verdict = out?.verdict;
  const reason = typeof out?.reason === 'string' ? out.reason.trim().slice(0, REASON_MAX) : '';
  if (!out || !['pass', 'fail', 'unsure'].includes(verdict as string) || !reason) {
    return {
      verdict: 'NOT_EVALUATED',
      evidence: `Verification task ${short(taskId)} finished with no usable structured verdict. A later round re-grades it.`,
    };
  }
  const pointers = Array.isArray(out.evidence)
    ? (out.evidence as unknown[]).filter((e): e is string => typeof e === 'string' && e.trim() !== '').slice(0, 3)
    : [];
  const cite = pointers.length > 0 ? ` [${pointers.join('; ').slice(0, 200)}]` : '';

  if (verdict === 'unsure') {
    return { verdict: 'NOT_EVALUATED', evidence: `Runner was unsure: ${reason}${cite}` };
  }
  return { verdict: verdict as 'pass' | 'fail', evidence: `${reason}${cite}` };
}

/**
 * Ensure one prose criterion has, or is about to have, a runner verdict.
 *
 * - `pending`     — a task is open (reused) or was just dispatched.
 * - `verdict`     — a task for this exact criterion finished within the TTL; its
 *                   result is the answer (which may be NOT_EVALUATED — the loop
 *                   guard against re-dispatching an empty run every round).
 * - `unavailable` — nowhere to run one.
 */
export async function resolveProseCriterion(opts: ProseCriterionInput): Promise<ProseCriterionResolution> {
  const { missionId, criterionIndex, text, fingerprint, evidence } = opts;
  const now = opts.now ?? Date.now();

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: { id: true, title: true, description: true, teamId: true, workspaceId: true },
  });
  if (!mission) return { kind: 'unavailable', evidence: `Mission ${missionId} not found` };

  if (!mission.workspaceId) {
    return {
      kind: 'unavailable',
      evidence: 'Prose criterion cannot be verified on a runner: mission has no workspace',
    };
  }

  if (!(await hasAgentBackendCredential(mission.teamId))) {
    return {
      kind: 'unavailable',
      evidence: 'Prose criterion cannot be verified on a runner: no agent backend credential is connected. Connect one in Settings → Agent Backends.',
    };
  }

  const existing = await findProseEvalTask(missionId, criterionIndex);
  if (existing && readMarker(existing.context)!.fingerprint === fingerprint) {
    if (!TERMINAL.includes(existing.status)) {
      const queuedMs = now - new Date(existing.createdAt ?? existing.updatedAt).getTime();
      const awaitingRunner = existing.status === 'pending' && queuedMs > RUNNER_WAIT_BOUND_MS;
      return {
        kind: 'pending',
        taskId: existing.id,
        awaitingRunner,
        evidence: awaitingRunner
          ? `Waiting for a runner to verify ${quote(text)} · task ${short(existing.id)} unclaimed for ${Math.round(queuedMs / 60000)}m`
          : `Verifying on runner… (task ${short(existing.id)}, ${existing.status})`,
      };
    }

    const age = now - new Date(existing.updatedAt).getTime();
    if (age < PROSE_VERDICT_TTL_MS) {
      const mapped = mapProseOutcome(
        existing.status,
        (existing.result as Record<string, unknown> | null)?.structuredOutput,
        existing.id,
      );
      return {
        kind: 'verdict',
        verdict: mapped.verdict,
        taskId: existing.id,
        evidence: mapped.evidence,
        evaluatedAt: new Date(existing.updatedAt).toISOString(),
      };
    }
    // Aged out — a verdict is about the code as it is now. Grade again.
  }

  const dispatched = await dispatchProseEvalTask({ mission, criterionIndex, text, fingerprint, evidence });
  if (!dispatched.ok) return { kind: 'unavailable', evidence: dispatched.reason };
  return {
    kind: 'pending',
    taskId: dispatched.taskId,
    awaitingRunner: false,
    evidence: `Verifying on runner… (task ${short(dispatched.taskId)} dispatched)`,
  };
}

function buildVerifierPrompt(
  mission: { title: string; description: string | null },
  text: string,
  evidence: ProseRunnerEvidence,
): string {
  const deliverables = evidence.deliverables.map(d => {
    const pr = d.prUrl
      ? ` — PR ${d.prNumber != null ? `#${d.prNumber} ` : ''}${d.prUrl} (${d.merged ? 'merged' : 'not merged'})`
      : ' — no PR';
    return `- [task:${d.id}] "${d.title ?? '(untitled)'}" — ${d.status}${pr}`;
  }).join('\n');

  const artifacts = evidence.artifacts.map(a =>
    `- [artifact:${a.id}] "${a.title ?? '(untitled)'}" (${a.type}${a.key ? `, key ${a.key}` : ''})`,
  ).join('\n');

  return `## Goal criterion verification (read-only)

Mission: **${mission.title}**
${mission.description ? `\n### Mission goal\n${mission.description}\n` : ''}
### Criterion to verify
${text}

### Deliverable tasks (${evidence.deliverables.length})
${deliverables || '(none)'}

### Artifacts and records — pointers only (${evidence.artifacts.length})
${artifacts || '(none)'}

Fetch any of these with the buildd tools (\`get_task\`, artifact reads) and inspect the
repository and the PRs above as needed.

### Rules
This is a read-only verification task. Do NOT change or modify any code, file, branch,
task or artifact. Do NOT open a PR, do NOT commit, do NOT create tasks, do NOT fix
anything you notice. Read, decide, report.

### Verdict
- \`pass\`   — you checked, and the criterion holds on the mission's current code/PRs.
- \`fail\`   — you checked, and it does not hold.
- \`unsure\` — you could not establish either. This is the honest answer whenever
  the evidence is out of reach; a guessed \`pass\` completes a mission nobody verified.

Return it via your outputSchema: \`verdict\`, a \`reason\` of at most ${REASON_MAX}
characters saying what you looked at and what it showed, and optionally \`evidence\`
(PR URLs, file paths, ids). Keep your turn short.`;
}

/**
 * Create + dispatch the verification task for one prose criterion. Never throws:
 * a dispatch problem must not 500 the operator's "Run verification" button.
 */
async function dispatchProseEvalTask(opts: {
  mission: { id: string; title: string; description: string | null; workspaceId: string | null };
  criterionIndex: number;
  text: string;
  fingerprint: string;
  evidence: ProseRunnerEvidence;
}): Promise<{ ok: true; taskId: string } | { ok: false; reason: string }> {
  const { mission, criterionIndex, text, fingerprint, evidence } = opts;
  if (!mission.workspaceId) return { ok: false, reason: 'Prose criterion cannot be verified: mission has no workspace' };

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, mission.workspaceId),
  });
  if (!workspace) return { ok: false, reason: 'Prose criterion cannot be verified: workspace not found' };

  const marker: ProseEvalContext = { missionId: mission.id, criterionIndex, fingerprint };
  const title = `${VERIFY_TASK_TITLE_PREFIX} ${text.trim()}`.slice(0, 200);
  const description = buildVerifierPrompt(mission, text, evidence);

  const [task] = await db
    .insert(tasks)
    .values({
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      title,
      description,
      priority: 2,
      status: 'pending',
      mode: 'execution',
      kind: 'analysis',
      complexity: 'normal',
      // Bookkeeping: counted as a deliverable, it would keep the mission's
      // pending count above zero and block the completion its verdict gates.
      taskClass: 'bookkeeping',
      creationSource: 'orchestrator',
      // Same contract as a command verification task: a judgment, not a PR.
      outputRequirement: 'none',
      outputSchema: PROSE_EVAL_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      context: {
        criteriaProseEval: marker,
        // Opt out of the mission-task auto-retry: one honest grading run; a
        // silent second attempt would only delay the verdict.
        retryCount: 1,
      },
    } as any)
    .returning({ id: tasks.id });

  if (!task) return { ok: false, reason: 'Prose verification task insert returned no row' };

  await dispatchNewTask(
    { id: task.id, title, description: null, workspaceId: mission.workspaceId, mode: 'execution', priority: 2, missionId: mission.id },
    workspace as any,
  ).catch(e => console.error(`[criteria-prose] dispatch failed for task ${task.id}:`, e));

  console.log(`[criteria-prose] mission ${mission.id} criterion ${criterionIndex}: dispatched ${task.id}`);
  return { ok: true, taskId: task.id };
}

/**
 * Hand a finished prose verification task's verdict back to its criterion.
 *
 * Called from the worker-completion hook for any task carrying a
 * `criteriaProseEval` marker. The criterion always leaves PENDING here — a
 * criterion left PENDING with no task in flight would hold the mission open with
 * nothing left that could resolve it.
 */
export async function handleProseEvalOutcome(
  taskId: string,
  structuredOutput?: unknown,
): Promise<{ applied: boolean }> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, status: true, context: true, result: true, missionId: true },
  });
  if (!task) return { applied: false };

  const marker = readMarker(task.context);
  if (!marker || !task.missionId) return { applied: false };
  if (!TERMINAL.includes(task.status)) return { applied: false };

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, task.missionId),
    columns: { id: true, goalCriteria: true, goalCriteriaState: true },
  });
  const state = (mission?.goalCriteriaState ?? null) as GoalCriteriaState | null;
  if (!state) return { applied: false };

  const cs = state.criteria.find(c => c.index === marker.criterionIndex);
  if (!cs) return { applied: false };

  // Identity check against the criterion as it is NOW: edited while the task
  // ran, index `n` points at a different claim and this verdict would be a
  // transplant.
  const current = Array.isArray(mission?.goalCriteria)
    ? (mission!.goalCriteria as GoalCriterion[])[marker.criterionIndex]
    : undefined;
  const stillTheSame = current?.type === 'description' && criterionFingerprint(current) === marker.fingerprint;

  const nowIso = new Date().toISOString();
  if (!stillTheSame) {
    console.warn(
      `[criteria-prose] mission ${task.missionId} criterion ${marker.criterionIndex} changed while task ${task.id} ran — discarding its verdict`,
    );
    if (cs.workerTaskId === task.id || cs.verdict === 'PENDING') {
      cs.verdict = 'NOT_EVALUATED';
      cs.evidence = 'Someone edited the criterion during verification. The next round re-grades it.';
      delete cs.awaitingRunner;
    }
  } else {
    // Structured output arrives on the completion request; fall back to whatever
    // the completion route persisted onto the task result.
    const output = structuredOutput ?? (task.result as Record<string, unknown> | null)?.structuredOutput;
    const mapped = mapProseOutcome(task.status, output, task.id);
    cs.verdict = mapped.verdict;
    cs.evidence = mapped.evidence;
    cs.workerTaskId = task.id;
    cs.evaluatedAt = nowIso;
    delete cs.awaitingRunner;
  }

  const next: GoalCriteriaState = {
    ...state,
    evaluatedAt: nowIso,
    overall: recalculateOverall(state.criteria),
    criteria: state.criteria,
  };

  await db
    .update(missions)
    .set({ goalCriteriaState: next as any, updatedAt: new Date() })
    .where(eq(missions.id, task.missionId));

  console.log(
    `[criteria-prose] mission ${task.missionId} criterion ${marker.criterionIndex} → ${cs.verdict} (task ${task.id}); overall ${next.overall}`,
  );

  // A criterion turning green is a completion trigger in its own right. Reuse the
  // verdict just written — re-evaluating would re-dispatch.
  const { completeMissionIfVerified } = await import('@/lib/mission-completion');
  await completeMissionIfVerified(task.missionId, {
    path: 'criteria_eval',
    predicate: `prose verification task ${task.id}`,
    evaluateCriteria: false,
  }).catch(e => console.error(`[criteria-prose] completion attempt failed for ${task.missionId}:`, e));

  return { applied: true };
}

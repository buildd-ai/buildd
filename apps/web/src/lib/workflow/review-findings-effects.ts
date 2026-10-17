/**
 * Effects of the durable-finding contract (docs/specs/workflow-state-kernel.md
 * §13.13 rules 7 and 10), owned by the reviews module and composed at the root.
 *
 *  - `publish_verdict_status`: buildd's verdict as a commit status GitHub can
 *    require on trunk. Failing at the delivery's head while a finding is open,
 *    success once none is, nothing for a delivery that never had one. The
 *    handler recomputes from the delivery as it is now, so a late or replayed
 *    run states the current truth, never the transition that queued it.
 *  - `file_merged_findings_followup`: a PR merged over open findings keeps them
 *    open, and one follow-up task against trunk carries them. Single-flight on
 *    a task id derived from the delivery.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { githubApi } from '@/lib/github';
import type { EffectHandler, EffectHandlers } from './effects';
import { describeFinding, openFindings } from './findings';
import { loadView, type Exec } from './kernel';
import { workspaceRepo } from './github-facts';
import { sqlWhere } from '@buildd/core/db/relational-sql';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export const VERDICT_STATUS_CONTEXT = 'buildd/review';

/** The status GitHub shows at a head, from the delivery's findings. Pure. */
export function verdictStatusFor(findings: Array<{ status: string; path: string | null; line: number | null; text: string }>): { state: 'failure' | 'success'; description: string } | null {
  if (findings.length === 0) return null;
  const open = openFindings(findings as never);
  if (open.length === 0) return { state: 'success', description: 'buildd review: no open findings' };
  const first = describeFinding(open[0] as never);
  const description = `buildd review: ${open.length} open finding${open.length === 1 ? '' : 's'}. ${first}`;
  return { state: 'failure', description: description.length > 140 ? `${description.slice(0, 137)}...` : description };
}

const publishVerdictStatus: EffectHandler = async (e) => {
  const view = await loadView({ deliveryId: e.deliveryId }, dbExec);
  const d = view.delivery;
  if (!d?.repoFullName || d.prNumber == null || !d.currentHeadSha) return { outcome: 'skipped:no_pr' };
  if (d.state === 'MERGED') return { outcome: 'skipped:merged' };
  const status = verdictStatusFor(view.findings ?? []);
  if (!status) return { outcome: 'skipped:no_findings' };
  const repo = await workspaceRepo(d.workspaceId);
  if (!repo) throw new Error('no GitHub installation for the workspace');
  await githubApi(repo.installationId, `/repos/${d.repoFullName}/statuses/${d.currentHeadSha}`, {
    method: 'POST',
    body: JSON.stringify({ state: status.state, context: VERDICT_STATUS_CONTEXT, description: status.description }),
  });
  return { outcome: `ok:${status.state}` };
};

/** A stable uuid for one delivery's follow-up, so a replay inserts nothing. */
export function followupTaskId(deliveryId: string): string {
  const h = createHash('sha256').update(`merged-findings-followup:${deliveryId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const fileMergedFindingsFollowup: EffectHandler = async (e) => {
  const view = await loadView({ deliveryId: e.deliveryId }, dbExec);
  const d = view.delivery;
  if (!d || d.state !== 'MERGED') return { outcome: 'skipped:not_merged' };
  const open = openFindings(view.findings);
  if (open.length === 0) return { outcome: 'skipped:no_open_findings' };
  const owner = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, d.ownerTaskId)), columns: { title: true, missionId: true } });
  const workspace = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, d.workspaceId)) });
  if (!workspace) return { outcome: 'skipped:no_workspace' };
  const by = e.payload.mergedBy as { kind?: string; login?: string | null } | undefined;
  const who = by?.kind === 'person' ? `a person${by.login ? ` (${by.login})` : ''} on GitHub` : by?.kind === 'app' ? 'a buildd door' : 'an actor GitHub did not identify';
  const [row] = await db.insert(tasks).values({
    id: followupTaskId(d.id),
    workspaceId: d.workspaceId,
    title: `Address review findings left open when PR #${d.prNumber} merged`,
    description: [
      `PR #${d.prNumber} (${d.repoFullName}) was merged by ${who} while review findings were still open. The merge does not resolve them: they are still on the base branch.`,
      '',
      'Open findings (fix each against the base branch, then say which you fixed):',
      ...open.map((f) => `- ${describeFinding(f)} (raised at ${f.reviewedHeadSha.slice(0, 7)})`),
    ].join('\n'),
    missionId: owner?.missionId ?? null,
    category: 'bug',
    kind: 'engineering',
    creationSource: 'webhook',
    outputRequirement: 'pr_required',
    status: 'pending',
    priority: 8,
    context: { baseBranch: d.baseRef, mergedOverFindingsOfDelivery: d.id, findingIds: open.map((f) => f.id) },
  } as never).onConflictDoNothing().returning();
  if (!row) return { outcome: 'ok:task_exists' };
  await announceTaskCreated(row as never, workspace as never);
  await wakeTask(row.id, 'task.created');
  return { outcome: 'ok' };
};

export function withFindingsEffects(base: EffectHandlers): EffectHandlers {
  return { ...base, publish_verdict_status: publishVerdictStatus, file_merged_findings_followup: fileMergedFindingsFollowup };
}

export const __handlers = { publishVerdictStatus, fileMergedFindingsFollowup };

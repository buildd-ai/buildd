/**
 * The trunk circuit breaker's effects (docs/specs/workflow-state-kernel.md
 * §6.10, §10.2).
 *
 *  - `dispatch_trunk_fix`: one open trunk-fix task per red base, not per
 *    incident. A base can hold several open incidents at once (one per
 *    signature: its runs were read before every check finished, or its head
 *    moved and broke more), and each one used to file its own fixer. The task
 *    is filed under the id of the base's oldest unresolved incident whose
 *    fixer is not finished (`Trunk.fixAnchor`), so every incident of one
 *    episode, and concurrent drains and replays, file the same task once; a
 *    later incident joins that fixer and steers it with the checks it was not
 *    filed for. Resolved incidents never anchor, so a red after recovery files
 *    a fix of its own. The incident is linked after the task exists.
 *  - `cancel_open_attempts` (reason `blocked_on_trunk`): cancels the per-PR CI
 *    fix tasks that never started; T25 already skipped their ledger rows.
 *
 * T26's mechanical base refresh (`refresh_branch` with no ledger row) is the
 * conflict family's handler: one handler per kind.
 */
import type { EffectHandler, EffectHandlers } from '../effects';
import { githubOf, type KernelPorts } from '../ports';
import { signatureChecks, trunkRecoveredFrom } from '../trunk-signature';
import { need } from './ports-of';

const NO_INSTALLATION = 'no GitHub installation for the workspace';

export function trunkFixTitle(baseRef: string, signature: string): string {
  const checks = signatureChecks(signature);
  return `fix(ci): ${baseRef} is red — ${checks.length ? checks.slice(0, 3).join(', ') : 'CI'}${checks.length > 3 ? ` +${checks.length - 3}` : ''}`;
}

export function trunkFixDescription(p: { repoFullName: string; baseRef: string; baseHeadSha: string | null; signature: string; prNumbers: number[] }): string {
  const checks = signatureChecks(p.signature);
  return [
    `The base branch \`${p.baseRef}\` of ${p.repoFullName} fails CI on its own head${p.baseHeadSha ? ` (\`${p.baseHeadSha.slice(0, 12)}\`)` : ''}, and open PRs fail the same checks because of it. Their per-PR CI retries are paused until the base is green again (the trunk circuit breaker).`,
    '',
    '## Failing checks',
    ...(checks.length ? checks.map((c) => `- ${c}`) : ['- (not named)']),
    '',
    '## Instructions',
    `1. Branch from the current \`${p.baseRef}\` and reproduce the failure locally.`,
    '2. Fix the cause on the base branch itself (a time-dependent test, a broken dependency, a bad merge). Change nothing unrelated.',
    `3. Open a PR into \`${p.baseRef}\`. Once it merges and CI on \`${p.baseRef}\` is green, every blocked PR resumes on its own.`,
    '',
    p.prNumbers.length ? `Blocked PRs: ${p.prNumbers.map((n) => `#${n}`).join(', ')}` : '',
  ].join('\n');
}

/** What a joining incident tells the open fixer: the checks it was not filed for, or nothing. */
export function trunkSteerNote(p: { incidentId: string; baseRef: string; signature: string; fixSignature: string | null }): { marker: string; note: string } | null {
  const known = new Set(p.fixSignature ? signatureChecks(p.fixSignature) : []);
  const extra = signatureChecks(p.signature).filter((c) => !known.has(c));
  if (!extra.length) return null;
  const marker = `trunk-incident:${p.incidentId}`;
  return {
    marker,
    note: `<!-- ${marker} -->\nThe base branch \`${p.baseRef}\` now also fails: ${extra.join(', ')}. One trunk fix covers every failing check on this base, so fix these in the same PR; no second fix task was filed.`,
  };
}

export const BLOCKED_ON_TRUNK_SUMMARY = 'Skipped: the base branch is red on the same checks (trunk incident)';

export function trunkHandlers(ports: KernelPorts): EffectHandlers {
  const dispatchTrunkFix: EffectHandler = async (e) => {
    const trunk = need(ports, 'trunk', e.kind);
    const inc = await trunk.incident(String(e.payload.incidentId ?? ''));
    if (!inc) return { outcome: 'skipped:no_incident' };
    if (inc.status === 'resolved') return { outcome: 'skipped:resolved' };
    if (inc.fixTaskId) return { outcome: 'ok:task_exists' };
    const reader = await githubOf(ports, inc.workspaceId);
    if (!reader) throw new Error(NO_INSTALLATION);
    const baseHead = reader.branchHead ? await reader.branchHead(inc.repoFullName, inc.baseRef) : null;
    // §10.5 at dispatch: a base that is already green owes no fix; the recovery sweep resolves the incident.
    const runs = baseHead && reader.checkRuns ? await reader.checkRuns(inc.repoFullName, baseHead) : null;
    if (runs?.complete && trunkRecoveredFrom(inc.signature, trunk.signatureOf(runs.failing))) return { outcome: 'skipped:trunk_green' };

    const anchor = await trunk.fixAnchor(inc.id);
    const taskId = anchor?.taskId ?? inc.id;
    const prNumbers: number[] = [];
    for (const did of (inc.affectedDeliveries ?? []).slice(0, 20)) {
      const d = (await ports.store.loadView({ deliveryId: did })).delivery;
      if (d?.prNumber != null) prNumbers.push(d.prNumber);
    }
    const work = need(ports, 'work', e.kind);
    const filed = await work.file({
      role: 'trunk_fix',
      workspaceId: inc.workspaceId,
      taskId,
      title: trunkFixTitle(inc.baseRef, inc.signature),
      description: trunkFixDescription({ repoFullName: inc.repoFullName, baseRef: inc.baseRef, baseHeadSha: baseHead, signature: inc.signature, prNumbers }),
      target: { repoFullName: inc.repoFullName, baseRef: inc.baseRef, headSha: baseHead },
      lineage: { deliveryId: e.deliveryId },
      dedupeKey: `trunk_fix:${taskId}`,
      detail: { incidentId: inc.id, baseRef: inc.baseRef, signature: inc.signature, baseHeadSha: baseHead },
    });
    if (filed.skipped) return { outcome: `skipped:${filed.skipped}` };
    // Woken before the link: once linked, a redelivery answers ok:task_exists above and never wakes it.
    // Our own task not created was filed by a run that died before linking it, maybe before waking it;
    // the wake coalesces while the task is pending. A fix this incident joins was woken by its own.
    if (filed.created || taskId === inc.id) await work.wake(taskId, 'task.created');
    await trunk.linkFix(inc.id, taskId);
    if (filed.created) return { outcome: 'ok' };
    if (taskId === inc.id) return { outcome: 'ok:task_bound' };
    const steer = trunkSteerNote({ incidentId: inc.id, baseRef: inc.baseRef, signature: inc.signature, fixSignature: anchor?.fixSignature ?? null });
    if (steer) await work.steer(taskId, steer);
    return { outcome: 'ok:joined_open_fix' };
  };

  /** Per-PR CI fix tasks that never started: T25 skipped their ledger rows. */
  const cancelBlockedCiTasks: EffectHandler = async (e) => {
    const n = await need(ports, 'work', e.kind).cancelPending({ deliveryId: e.deliveryId, role: 'ci_fix', reason: 'blocked_on_trunk', summary: BLOCKED_ON_TRUNK_SUMMARY });
    return { outcome: `ok:cancelled_${n}` };
  };

  return { dispatch_trunk_fix: dispatchTrunkFix, cancel_open_attempts: cancelBlockedCiTasks };
}

/**
 * The conflict and migration families' effects (docs/specs/workflow-state-kernel.md
 * §6.7, §10.2, §10.5).
 *
 * Mechanical first. `refresh_branch` has the host merge the base in, pinned to
 * the bound head (`Conflicts.refresh`: the semantic check, single-flight and
 * operational bound are the host's); `renumber_migration` has it rename a
 * byte-identical migration (`Conflicts.renumber`). Only a refusal an agent
 * could fix (GitHub's textual-conflict 422, a same-symbol overlap, a migration
 * that must be regenerated) creates an agent attempt, through
 * `ConflictObserved{mechanicalRefused}`; an operational dead end goes to a
 * person (`MechanicalRepairFailed`), never to an agent. The mechanical refresh
 * is also the recheck that a flagged conflict is real against today's base.
 *
 * The ledger row was allocated by the transition that queued the effect
 * (allocation is consumption, §5.7 rule 1). Handlers never count anything.
 */
import { applyCommandOn } from '../command-runner';
import type { Command, LivePr } from '../commands';
import type { EffectHandler, EffectHandlers } from '../effects';
import { acquireLaneOn, laneOutcome, LANE_PARK_BACKSTOP_MS, LANE_PARKED_OUTCOME } from '../landing-lane';
import { githubOf, type ClaimedEffect, type GithubFactReader, type KernelPorts } from '../ports';
import type { AttemptSnapshot, DeliverySnapshot } from '../types';
import { hasPr, need, type WithPr } from './ports-of';

const NO_INSTALLATION = 'no GitHub installation for the workspace';

interface Bound { d: WithPr; attempt: AttemptSnapshot & { boundHeadSha: string }; reader: GithubFactReader; live: LivePr }

export function conflictHandlers(ports: KernelPorts): EffectHandlers {
  const apply = (deliveryId: string, cmd: Command) => applyCommandOn(ports.store, cmd, { ref: { deliveryId }, newId: ports.newId });
  const observeHead = (d: WithPr, source: string, reader: GithubFactReader, kind: string) =>
    need(ports, 'ingest', kind).ingest({ kind: 'head_observed', workspaceId: d.workspaceId, source, repoFullName: d.repoFullName, prNumber: d.prNumber }, reader);

  /**
   * Shared revalidation (§10.5): the attempt is the bound, queued one; the PR is
   * open; its head is still the bound head (a moved head goes through T3, which
   * skips the queued row). An outcome when nothing is owed.
   */
  async function boundAttempt(e: ClaimedEffect, source: string): Promise<Bound | { outcome: string }> {
    const view = await ports.store.loadView({ deliveryId: e.deliveryId });
    const d = view.delivery;
    const attempt = view.attempts.find((a) => a.id === e.payload.attemptId);
    if (!d || !attempt) return { outcome: 'skipped:no_attempt' };
    if (attempt.status !== 'queued') return { outcome: `skipped:attempt_${attempt.status}` };
    if (d.state !== 'REPAIRING' || d.boundAttemptId !== attempt.id) {
      const r = await apply(d.id, { type: 'RepairNotNeeded', actor: source, attemptId: attempt.id, reason: 'state_moved' });
      return { outcome: `skipped:${'reason' in r ? r.reason : 'state_moved'}` };
    }
    if (!hasPr(d) || !attempt.boundHeadSha) return { outcome: 'skipped:no_pr' };
    const reader = await githubOf(ports, d.workspaceId);
    if (!reader) throw new Error(NO_INSTALLATION);
    const live = await reader.readPr(d.repoFullName, d.prNumber);
    if (!live) throw new Error('live PR read failed');
    // A closed or merged PR is answered by its own fact (T17/T18 cancel the row).
    if (live.state !== 'open' || live.merged) return { outcome: 'skipped:pr_not_open' };
    if (live.headSha !== attempt.boundHeadSha) {
      await observeHead(d, source, { ...reader, readPr: async () => live }, e.kind);
      return { outcome: 'skipped:head_moved' };
    }
    return { d, attempt: attempt as Bound['attempt'], reader, live };
  }

  const notNeeded = async (b: Bound, source: string, reason: string) => {
    await apply(b.d.id, { type: 'RepairNotNeeded', actor: source, attemptId: b.attempt.id, reason, live: b.live });
    return { outcome: `skipped:${reason}` };
  };

  /** The mechanical attempt was refused for a reason an agent can fix: allocate the agent attempt (T12). */
  const refusedToAgent = async (b: Bound, source: string, payload: Record<string, unknown>, refusal: Record<string, unknown>) => {
    const migration = b.attempt.family === 'migration';
    const maxAgent = typeof payload.maxAgent === 'number' ? payload.maxAgent : (await need(ports, 'policy', source).forWorkspace(b.d.workspaceId)).maxConflictIterations;
    const r = await apply(b.d.id, {
      type: 'ConflictObserved', actor: source, headSha: b.attempt.boundHeadSha, mergeable: 'dirty',
      migrationCollision: migration, mechanicalRefused: true, maxAgentAttempts: maxAgent,
      refusal, detail: (payload.detail as Record<string, unknown> | null) ?? null,
    });
    if (r.result === 'applied') return { outcome: `ok:refused:${String(refusal.reason ?? 'refused').slice(0, 60)}` };
    return { outcome: `skipped:${r.reason}` };
  };

  const mechanicalFailed = async (b: Bound, source: string, reason: string) => {
    await apply(b.d.id, { type: 'MechanicalRepairFailed', actor: source, attemptId: b.attempt.id, reason });
    return { outcome: `ok:escalated:${reason.slice(0, 60)}` };
  };

  const refreshBranch: EffectHandler = async (e) => {
    const source = 'effect:refresh_branch';
    const conflicts = need(ports, 'conflicts', e.kind);
    if (!e.payload.attemptId) {
      // The trunk-recovery refresh (T26) carries no ledger row: a plain pinned update.
      const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
      if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
      if (await conflicts.botOwned(d)) return { outcome: 'skipped:dependency_bot' };
      // Pinned to the head T26 judged stale; a head that moved since has its own facts.
      const head = String(e.payload.headSha ?? '');
      if (!head || d.currentHeadSha !== head) return { outcome: 'skipped:head_moved' };
      if (!(await githubOf(ports, d.workspaceId))) throw new Error(NO_INSTALLATION);
      const res = await conflicts.updateBranch(d, head);
      if (res.kind === 'updated') return { outcome: 'ok:updated' };
      // Operational: retried by the outbox with backoff. Anything else is answered by the PR's own facts (T3, T12).
      if (res.kind === 'retry') throw new Error(res.reason);
      return { outcome: `skipped:${res.reason}` };
    }
    const b = await boundAttempt(e, source);
    if ('outcome' in b) return b;
    // A dependency bot owns its branch: the platform never pushes to it (S27). A landing door reaches
    // here through T16 without the conflict doors' own check; no agent may push either, so a person lands it.
    if (await conflicts.botOwned(b.d)) return mechanicalFailed(b, source, 'dependency_bot_pr: the platform does not push to a dependency bot\'s branch');
    // The landing lane: one behind-refresh in flight per repo + base. A conflict refresh is not
    // racing for a quiet base, so only `behind` repairs take it.
    let laneNote = '';
    const laneMode = b.attempt.triggerReason === 'behind' && b.d.baseRef ? (await need(ports, 'policy', e.kind).forWorkspace(b.d.workspaceId)).landingLane : 'off';
    if (laneMode !== 'off') {
      const lane = await acquireLaneOn(ports.store, { repoFullName: b.d.repoFullName, baseRef: b.d.baseRef!, deliveryId: b.d.id, headSha: b.attempt.boundHeadSha });
      if (!lane.acquired) {
        if (laneMode === 'enforce') return { outcome: laneOutcome(LANE_PARKED_OUTCOME, lane.holder), park: { delayMs: LANE_PARK_BACKSTOP_MS } };
        laneNote = `(${laneOutcome('lane:would_wait', lane.holder)})`;
      }
    }
    const out = await conflicts.refresh(b.d, b.attempt);
    switch (out.kind) {
      case 'updated':
        // The new head arrives through T3; §6.9 attributes it to this mechanical row. Read it now
        // so the common path does not wait for the webhook.
        await observeHead(b.d, source, b.reader, e.kind);
        return { outcome: `ok:updated${laneNote}` };
      case 'up_to_date':
        // Nothing to merge in: the "behind"/"dirty" reading was stale.
        return notNeeded(b, source, 'up_to_date');
      case 'head_changed':
        await observeHead(b.d, source, b.reader, e.kind);
        return { outcome: 'skipped:head_moved' };
      case 'refused':
        return refusedToAgent(b, source, e.payload, out.refusal);
      case 'retry':
        // Operational and bounded by the host's own counters: the outbox retries with backoff.
        throw new Error(out.reason);
      case 'failed':
        return mechanicalFailed(b, source, out.reason);
    }
  };

  const renumberMigration: EffectHandler = async (e) => {
    const source = 'effect:renumber_migration';
    const b = await boundAttempt(e, source);
    if ('outcome' in b) return b;
    const out = await need(ports, 'conflicts', e.kind).renumber(b.d, b.attempt, e.payload);
    switch (out.kind) {
      case 'renumbered':
        await observeHead(b.d, source, b.reader, e.kind);
        return { outcome: `ok:renumbered:${out.to}` };
      case 'head_moved':
        // Fast-forward only: a push that raced us was refused, and the next head is handled by T3.
        await observeHead(b.d, source, b.reader, e.kind);
        return { outcome: 'skipped:head_moved' };
      case 'not_needed':
        return notNeeded(b, source, out.reason);
      case 'refused':
        return refusedToAgent(b, source, e.payload, out.refusal);
      case 'retry':
        throw new Error(out.reason);
    }
  };

  const dispatchConflictFix: EffectHandler = async (e) => {
    const source = 'effect:dispatch_conflict_fix';
    const view0 = await ports.store.loadView({ deliveryId: e.deliveryId });
    const pre = view0.attempts.find((a) => a.id === e.payload.attemptId);
    // The task id IS the attempt id, so a re-run after a crash between filing and linking files nothing twice.
    if (pre?.taskId) return { outcome: 'ok:task_exists' };
    const b = await boundAttempt(e, source);
    if ('outcome' in b) return b;
    const repairKind = String(e.payload.repairKind ?? b.attempt.triggerReason ?? (b.attempt.family === 'migration' ? 'migration' : 'conflict'));
    // §10.5: is the agent attempt still owed now? Unknown fails toward doing the work.
    let owed: { owed: boolean; reason?: string };
    if (repairKind === 'migration' || repairKind === 'migration_split') {
      owed = await need(ports, 'conflicts', e.kind).migrationOwed(b.d, b.attempt, { repairKind, baseRef: b.live.baseRef ?? null });
    } else {
      const st = b.live.mergeableState;
      owed = st === 'clean' || st === 'unstable' || st === 'has_hooks' || st === 'blocked' ? { owed: false, reason: 'conflict_resolved' } : { owed: true };
    }
    if (!owed.owed) return notNeeded(b, source, owed.reason ?? 'conflict_resolved');

    const headSha = b.attempt.boundHeadSha;
    // One row per (workspace, PR, head) in the host's legacy dedupe; the ledger dedupes a second attempt.
    const firstAtHead = view0.attempts.filter((a) => (a.family === 'conflict' || a.family === 'migration') && a.mode === 'agent' && a.boundHeadSha === headSha && a.status !== 'skipped').length <= 1;
    const work = need(ports, 'work', e.kind);
    const filed = await work.file({
      role: 'conflict_fix',
      workspaceId: b.d.workspaceId,
      taskId: b.attempt.id,
      target: { repoFullName: b.d.repoFullName, prNumber: b.d.prNumber, headSha, baseRef: b.live.baseRef ?? b.d.baseRef },
      lineage: { deliveryId: b.d.id, attemptId: b.attempt.id, parentTaskId: b.d.ownerTaskId },
      dedupeKey: `conflict_fix:${b.attempt.id}`,
      detail: {
        repairKind, family: b.attempt.family, attemptNo: b.attempt.attemptNo, maxAttempts: b.attempt.maxAttempts, firstAtHead,
        headRef: b.live.headRef ?? null, refusal: e.payload.refusal ?? null, repairDetail: e.payload.detail ?? null,
      },
    });
    if (filed.skipped || !filed.taskId) return { outcome: `skipped:${filed.skipped ?? 'not_filed'}` };
    await ports.store.linkAttemptTask(b.attempt.id, filed.taskId);
    // Not created: a run that filed it crashed before binding the row (a bound row returned above),
    // so it was never woken. This run finishes what that one started.
    await work.wake(filed.taskId, 'conflict.retry');
    return { outcome: filed.created ? 'ok' : 'ok:task_bound' };
  };

  return { refresh_branch: refreshBranch, renumber_migration: renumberMigration, dispatch_conflict_fix: dispatchConflictFix };
}

/** `escalate_exhaustion` for families `conflict` and `migration`. */
export async function escalateConflictExhaustion(ports: KernelPorts, e: ClaimedEffect, d: DeliverySnapshot | null): Promise<{ outcome: string }> {
  if (!hasPr(d) || !d.currentHeadSha) return { outcome: 'skipped:no_pr' };
  const family = String(e.payload.family);
  const attempts = Number(e.payload.attempts ?? 0);
  return {
    outcome: await need(ports, 'escalate', e.kind).exhausted(d, {
      family, headSha: d.currentHeadSha, attempts, max: Number(e.payload.max ?? attempts),
      title: 'Conflict resolution exhausted', detail: `${family} repair attempts used ${attempts} on PR #${d.prNumber}`,
    }),
  };
}

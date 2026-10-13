/**
 * Landing and post-merge effects (docs/specs/workflow-state-kernel.md §10.2,
 * T15–T17, §14 Slice C). Every handler re-reads the delivery and is
 * idempotent: the outbox delivers at least once.
 *
 *  - `merge_call`: the one merge of a kernel-owned PR, pinned to the head T15
 *    approved (`GithubWrites.mergeAtHead`); its answer is T16, never a merged fact.
 *  - `verify_merge`: the live read that turns a merge answer into a fact
 *    (through the `Ingest` port), or tells the kernel nothing landed.
 *  - A merge answered `behind` or `conflict` is a conflict-family repair
 *    (T16 → §6.7): its effects are the conflict family's handlers, not these.
 *  - `emit_pr_merged`, `finalize_mission_pr`: the post-merge work, once per
 *    merge (`Lifecycle.merged` / `finalizeMerge`).
 */
import { applyCommandOn } from '../command-runner';
import type { EffectHandler, EffectHandlers } from '../effects';
import { githubOf, type KernelPorts } from '../ports';
import { hasPr, need } from './ports-of';

const NO_INSTALLATION = 'no GitHub installation for the workspace';

export function landingHandlers(ports: KernelPorts): EffectHandlers {
  const apply = (deliveryId: string, cmd: Parameters<typeof applyCommandOn>[1]) =>
    applyCommandOn(ports.store, cmd, { ref: { deliveryId }, newId: ports.newId });

  const mergeCall: EffectHandler = async (e) => {
    const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
    const headSha = String(e.payload.headSha ?? '');
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    if (d.state !== 'LANDING' || d.currentHeadSha !== headSha) return { outcome: `skipped:state_${d.state}` };
    const writes = (await githubOf(ports, d.workspaceId))?.writes;
    if (!writes) throw new Error(NO_INSTALLATION);
    const method = (e.payload.mergeMethod as 'merge' | 'squash' | 'rebase' | undefined) ?? 'squash';
    // Pinned to the head T15 approved: a replay at the same head is a no-op or a clean refusal.
    const ans = await writes.mergeAtHead({ repoFullName: d.repoFullName, prNumber: d.prNumber, headSha, method });
    const landingVersion = typeof e.payload.landingVersion === 'number' ? e.payload.landingVersion : undefined;
    const r = await apply(d.id, {
      type: 'MergeCallResult', actor: 'effect:merge_call', headSha, outcome: ans.outcome, detail: ans.detail,
      ...(landingVersion !== undefined ? { landingVersion } : {}), ...(ans.retryAt ? { retryAt: ans.retryAt } : {}),
    });
    return { outcome: `ok:${ans.outcome}:${r.result}` };
  };

  const verifyMerge: EffectHandler = async (e) => {
    const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    if (d.state === 'MERGED') return { outcome: 'ok:already_merged' };
    const reader = await githubOf(ports, d.workspaceId);
    if (!reader) throw new Error(NO_INSTALLATION);
    const live = await reader.readPr(d.repoFullName, d.prNumber);
    if (!live) throw new Error('live PR read failed');
    // The funnel acts on this read, not another one.
    const github = { ...reader, readPr: async () => live };
    const subject = { workspaceId: d.workspaceId, source: 'effect:verify_merge', repoFullName: d.repoFullName, prNumber: d.prNumber };
    if (live.merged || live.state === 'closed') {
      // The merged (or closed) fact, from the kernel's own read: T17 / T18.
      const r = await need(ports, 'ingest', e.kind).ingest({ kind: 'pr_closed', ...subject }, github);
      return { outcome: `ok:${live.merged ? 'merged' : 'closed'}:${r.result}` };
    }
    const headSha = String(e.payload.headSha ?? '');
    if (live.headSha !== headSha) {
      await need(ports, 'ingest', e.kind).ingest({ kind: 'head_observed', ...subject }, github);
      return { outcome: 'ok:head_moved' };
    }
    if (e.payload.outcome === 'merged') {
      // GitHub accepted the merge and its read has not caught up: read again later (or the webhook arrives first).
      throw new Error('the merge was accepted but the live read still shows the PR open');
    }
    if (d.state !== 'LANDING') return { outcome: `skipped:state_${d.state}` };
    const landingVersion = typeof e.payload.landingVersion === 'number' ? e.payload.landingVersion : undefined;
    // A 5xx's retry-after, carried from the merge call through this read.
    const retryAt = typeof e.payload.retryAt === 'string' ? e.payload.retryAt : undefined;
    const r = await apply(d.id, {
      type: 'MergeCallResult', actor: 'effect:verify_merge', headSha, outcome: 'not_merged',
      detail: 'GitHub shows the PR still open and unmerged after the merge call',
      ...(landingVersion !== undefined ? { landingVersion } : {}), ...(retryAt ? { retryAt } : {}),
    });
    return { outcome: `ok:not_merged:${r.result}` };
  };

  const emitPrMerged: EffectHandler = async (e) => {
    const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
    if (!hasPr(d)) return { outcome: 'skipped:no_pr' };
    if (d.state !== 'MERGED') return { outcome: `skipped:state_${d.state}` };
    // One effect per merge (its dedupe key): the once-per-merge work runs here.
    if (!(await need(ports, 'lifecycle', e.kind).merged(d))) return { outcome: 'skipped:no_worker' };
    return { outcome: 'ok' };
  };

  const finalizeMissionPr: EffectHandler = async (e) => {
    const d = (await ports.store.loadView({ deliveryId: e.deliveryId })).delivery;
    if (!d?.repoFullName || d.state !== 'MERGED') return { outcome: `skipped:state_${d?.state ?? 'none'}` };
    await need(ports, 'lifecycle', e.kind).finalizeMerge(d);
    return { outcome: 'ok' };
  };

  return { merge_call: mergeCall, verify_merge: verifyMerge, emit_pr_merged: emitPrMerged, finalize_mission_pr: finalizeMissionPr };
}

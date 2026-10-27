/**
 * One conformance scenario per row of the docs/specs/workflow-state-kernel.md
 * §16 test matrix that the kernel itself decides (the others point at the
 * scenarios in scenarios.ts that already cover them, or carry a recorded
 * exemption: see matrix-coverage.ts). Same contract as scenarios.ts: each
 * scenario drives the kernel through a `ConformanceHost`'s store and checks
 * what it reads back, with host-independent expectations, so the same list
 * runs on the in-memory store and on Postgres.
 *
 * Kept apart from scenarios.ts so that file's other editors do not collide
 * with this one. The runners take `ALL_CONFORMANCE_SCENARIOS` (all.ts).
 */
import type { Command, EffectKind, LivePr } from '../commands';
import type { CommandResult } from '../ports';
import { deliveryPrState, deriveDeliveryView, repairLabelOf } from '../projections';
import type { CompositionAttestation, ConstituentEvidence } from '../types';
import { Delivery, eq, type ConformanceHost, type ConformanceScenario } from './scenarios';

const MERGED_AT = '2026-01-01T01:00:00.000Z';

function ok(cond: unknown, label: string): void {
  if (!cond) throw new Error(label);
}

function pick<T extends object>(o: T | null | undefined, keys: Array<keyof T>): Partial<T> | null {
  if (!o) return null;
  return Object.fromEntries(keys.map((k) => [k, o[k]])) as Partial<T>;
}

function outcome(r: CommandResult): { result: string; reason?: string; to?: string } {
  return { result: r.result, ...('reason' in r ? { reason: r.reason } : {}), ...(r.result === 'applied' ? { to: r.decision.toState } : {}) };
}

function applied(r: CommandResult, to: string, label: string): void {
  eq(outcome(r), { result: 'applied', to }, label);
}

function notApplied(r: CommandResult, result: 'duplicate' | 'stale' | 'rejected', reason: string, label: string): void {
  eq(outcome(r), { result, reason }, label);
}

/** Rows of a delivery's outbox of one kind, by outcome-free count. */
async function kinds(host: ConformanceHost, s: Delivery, kind: EffectKind): Promise<number> {
  return (await host.effects(s.deliveryId)).filter((e) => e.kind === kind).length;
}

/** A composition of one constituent that was reviewed and approved at its own head. */
function composition(s: Delivery, head: string, novel: CompositionAttestation['novelDelta'] = { result: 'none' }): { attestation: CompositionAttestation; constituents: ConstituentEvidence[] } {
  return {
    attestation: {
      repoFullName: s.repo, prNumber: s.prNumber, baseSha: 'B0', aggregateHeadSha: head, method: 'tree_equal', verifiedAt: MERGED_AT, verifier: 'kernel',
      constituents: [{ deliveryId: 'dx', roundId: 'rx', prNumber: 3, reviewedHeadSha: 'C1', equivalentHeadShas: [], mergedHeadSha: 'C1', landedSha: 'SQ1', landedPatchId: 'a'.repeat(64), reviewedPatchId: 'a'.repeat(64) }],
      novelDelta: novel,
    },
    constituents: [{ roundId: 'rx', deliveryId: 'dx', prNumber: 3, repoFullName: s.repo, roundHeadSha: 'C1', roundStatus: 'decided', effectiveVerdict: 'approve', deliveryApprovedHeads: ['C1'] }],
  };
}

const closedUnmerged = (s: Delivery, head: string): LivePr => s.live(head, { state: 'closed', merged: false });

export const MATRIX_SCENARIOS: ConformanceScenario[] = [
  {
    name: 'S1: a fix that ends with a local commit while GitHub\'s head is unchanged waits for the push: no second round, recovery owed',
    async run(host) {
      const s = await new Delivery(host, 201).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.verdict('request_changes'), 'CHANGES_REQUESTED', 'request changes');
      const fix = await s.startFix();
      applied(await s.fixEnded(fix, { localHeadSha: 'L2', commitCount: 1, live: s.live('H1') }), 'AWAITING_PUSH', 'the fix never reached GitHub');
      const v = await s.view();
      eq(v.rounds.map((r) => r.round), [1], 'no round 2');
      eq(pick(v.attempts.find((a) => a.id === fix)!, ['status', 'outcome']), { status: 'ended', outcome: 'unproven' }, 'the attempt is unproven, not delivered');
      eq(await kinds(host, s, 'push_recovery'), 1, 'push recovery owed');
      eq(await kinds(host, s, 'dispatch_review'), 1, 'only round 1 was ever dispatched for review');
      eq((await s.d()).state, 'AWAITING_PUSH', 'never read as in review');
    },
  },
  {
    name: 'S3: a content-equivalent head the platform moved an approval onto is appended once, a concurrent double call appends once, and own_refresh carries the same way',
    async run(host) {
      const s = await new Delivery(host, 203).open();
      await s.approvedAt('H1');
      const [a, b] = await Promise.all([s.push('H2', { carryForward: 'content_equivalent' }), s.push('H2', { carryForward: 'content_equivalent' })]);
      eq([a.result, b.result].sort(), ['applied', 'duplicate'], 'one applied, one duplicate');
      eq(pick(await s.d(), ['state', 'approvedHeads', 'approvalBasis']), { state: 'APPROVED', approvedHeads: ['H1', 'H2'], approvalBasis: 'verdict' }, 'H2 appended once');
      applied(await s.push('H3', { carryForward: 'own_refresh' }), 'APPROVED', 'a refresh the platform pushed');
      eq((await s.d()).approvedHeads, ['H1', 'H2', 'H3'], 'carried again');
      eq((await s.view()).rounds.length, 1, 'no new review round for either head');
      // A head that is not equivalent carries nothing.
      applied(await s.push('H4'), 'AWAITING_REVIEW', 'a push with no carry evidence');
      eq((await s.d()).approvedHeads, ['H1', 'H2', 'H3'], 'H4 is not approved');
    },
  },
  {
    name: 'S4: a late verdict for a superseded head is stored on its round and changes nothing: no state change, no post_review, no merge',
    async run(host) {
      const s = await new Delivery(host, 204).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      const r1 = await s.latestRound();
      applied(await s.push('H2'), 'AWAITING_REVIEW', 'a new head supersedes round 1');
      const before = { state: (await s.d()).state, version: (await s.d()).version, effects: await s.effectKinds() };
      notApplied(await s.verdict('approve', r1.id, 'H1'), 'stale', 'round_superseded', 'late approve');
      const after = await s.view();
      eq(after.rounds.find((r) => r.id === r1.id)!.verdict, 'approve', 'kept on its round');
      eq({ state: after.delivery!.state, version: after.delivery!.version, effects: await s.effectKinds() }, before, 'nothing moved, nothing owed');
      eq(await kinds(host, s, 'post_review'), 0, 'no review posted');
      eq(await kinds(host, s, 'merge_call'), 0, 'no merge owed');
      eq(after.delivery!.approvedHeads, [], 'nothing approved');
    },
  },
  {
    name: 'S7: two fix dispatches race for one round: one allocates the attempt, the loser is a duplicate; a newer approval cancels the open fix',
    async run(host) {
      const s = await new Delivery(host, 207).open();
      await s.ownerPushed('H1');
      applied(await s.verdict('request_changes'), 'CHANGES_REQUESTED', 'request changes');
      const dispatch = (taskId: string) => s.submit({
        type: 'FixDispatched', actor: 'kernel', roundId: '', taskId, maxAttempts: 3, revalidation: { live: s.live('H1'), newerApprove: false },
      } as Command);
      const roundId = (await s.latestRound()).id;
      const cmd = (taskId: string): Promise<CommandResult> => s.submit({ type: 'FixDispatched', actor: 'kernel', roundId, taskId, maxAttempts: 3, revalidation: { live: s.live('H1'), newerApprove: false } });
      void dispatch;
      const [a, b] = await Promise.all([cmd(host.newId()), cmd(host.newId())]);
      eq([a.result, b.result].sort(), ['applied', 'duplicate'], 'one dispatch wins');
      const fixes = (await s.view()).attempts.filter((x) => x.family === 'review_fix');
      eq(fixes.map((x) => pick(x, ['attemptNo', 'status'])), [{ attemptNo: 1, status: 'queued' }], 'one ledger row for the round');
      // A person asks for another look; the new round approves, and the queued fix has nothing left to do.
      applied(await s.submit({ type: 'ReviewRequested', actor: 'human:u', headSha: 'H1', live: s.live('H1'), forced: true }), 'AWAITING_REVIEW', 'another look');
      applied(await s.verdict('approve'), 'APPROVED', 'approve');
      eq((await s.view()).attempts.filter((x) => x.family === 'review_fix').map((x) => x.status), ['cancelled'], 'the open fix is cancelled by the approval');
    },
  },
  {
    name: 'S8: a spent request-changes budget escalates once with review_exhausted and a later push does not start another round',
    async run(host) {
      const s = await new Delivery(host, 208).open({ maxRounds: 1 });
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.verdict('request_changes'), 'ESCALATED', 'the only round asked for changes');
      eq(pick(await s.d(), ['state', 'stateReason']), { state: 'ESCALATED', stateReason: 'review_exhausted' }, 'review_exhausted');
      eq(await kinds(host, s, 'escalate_exhaustion'), 1, 'one escalation owed');
      eq(await kinds(host, s, 'dispatch_fix'), 0, 'no fix is dispatched past the budget');
      await s.push('H2');
      eq(pick(await s.d(), ['state', 'stateReason', 'currentRound']), { state: 'ESCALATED', stateReason: 'review_exhausted', currentRound: 1 }, 'a push leaves a spent budget with the person');
      eq(await kinds(host, s, 'escalate_exhaustion'), 1, 'still one escalation');
    },
  },
  {
    name: 'S9: an owner attempt reaped with commits and no reported head waits for the push; with no commits it is handed on',
    async run(host) {
      const s = await new Delivery(host, 209).open();
      const lost = (d: Delivery, commitCount: number) => d.submit({
        type: 'AttemptEnded', actor: 'sweep:stale-workers', workerId: 'w9', taskId: d.ownerTaskId, outcome: 'lost', localHeadSha: null, commitCount, live: d.live('H1'),
      });
      applied(await lost(s, 2), 'AWAITING_PUSH', 'commits that never reached GitHub');
      eq(await kinds(host, s, 'push_recovery'), 1, 'push recovery owed');
      eq((await s.view()).rounds.length, 0, 'no review round');
      const t = await new Delivery(host, 210).open();
      applied(await lost(t, 0), 'AWAITING_REVIEW', 'nothing local to lose');
    },
  },
  {
    name: 'S11: a person merges on GitHub from any open state: MERGED, every open attempt cancelled',
    async run(host) {
      // Awaiting review.
      const a = await new Delivery(host, 211).open();
      await a.ownerPushed('H1');
      applied(await a.merged('H1'), 'MERGED', 'merged while awaiting review');
      ok((await a.effectKinds()).includes('cancel_open_attempts'), 'open attempts cancelled');
      eq(await kinds(host, a, 'emit_pr_merged'), 1, 'one merge emitted');
      // Mid-fix: the queued and running fix attempts end cancelled.
      const b = await new Delivery(host, 212).open();
      await b.ownerPushed('H1');
      await b.verdict('request_changes');
      await b.startFix();
      applied(await b.merged('H1'), 'MERGED', 'merged while a fix was running');
      ok((await b.view()).attempts.every((x) => x.status !== 'queued' && x.status !== 'running'), 'no attempt left open');
      // CI repair.
      const c = await new Delivery(host, 213).open();
      await c.approvedAt('H1');
      applied(await c.ciRed('H1'), 'REPAIRING', 'ci red');
      applied(await c.merged('H1'), 'MERGED', 'merged while a CI repair was queued');
      ok((await c.view()).attempts.every((x) => x.status !== 'queued' && x.status !== 'running'), 'the CI repair is closed');
      // Escalated.
      const d = await new Delivery(host, 214).open({ maxRounds: 1 });
      await d.ownerPushed('H1');
      await d.verdict('request_changes');
      applied(await d.merged('H1'), 'MERGED', 'merged out of an escalation');
    },
  },
  {
    name: 'S12: a supersession edge is recorded only from CLOSED_UNMERGED, only when authorised, and never overwritten',
    async run(host) {
      const target = (prNumber: number) => ({ repoFullName: 'acme/other', prNumber, merged: true, url: null });
      const s = await new Delivery(host, 215).open();
      await s.ownerPushed('H1');
      const edge = (d: Delivery, prNumber: number, authorised = true): Promise<CommandResult> =>
        d.submit({ type: 'SupersessionRecorded', actor: 'agent:t2', target: target(prNumber), reason: 'shipped under another PR', authorised });
      eq(outcome(await edge(s, 9)), { result: 'rejected', reason: 'not_closed_unmerged' }, 'an open PR is not superseded');
      applied(await s.submit({ type: 'PrClosedUnmerged', actor: 'webhook', live: closedUnmerged(s, 'H1'), closeCause: 'manual' }), 'CLOSED_UNMERGED', 'closed unmerged');
      eq((await edge(s, 9, false)).result, 'rejected', 'an unauthorised caller records nothing');
      eq((await s.d()).state, 'CLOSED_UNMERGED', 'still closed unmerged');
      applied(await edge(s, 9), 'SUPERSEDED', 'recorded');
      eq(pick(await s.d(), ['state', 'supersededByPr']), { state: 'SUPERSEDED', supersededByPr: 9 }, 'the edge is on the delivery');
      eq((await edge(s, 9)).result, 'duplicate', 'the same target again is a replay');
      eq(outcome(await edge(s, 10)), { result: 'rejected', reason: 'edge_exists' }, 'a different target is refused');
      eq((await s.d()).supersededByPr, 9, 'never overwritten');
    },
  },
  {
    name: 'S13: a transition and its effect rows commit together, a refused or replayed command owes nothing, and a lease that expires re-runs the effect once',
    async run(host) {
      const s = await new Delivery(host, 216).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      eq(await kinds(host, s, 'dispatch_review'), 1, 'the review is owed as soon as the transition is');
      const owed = (await host.effects(s.deliveryId)).length;
      notApplied(await s.land('H1'), 'rejected', 'state_not_allowed', 'a refused command');
      eq((await s.submit({ type: 'AttemptEnded', actor: 'runner', workerId: 'wk1', taskId: s.ownerTaskId, outcome: 'success', localHeadSha: 'H1', commitCount: 1, live: s.live('H1') })).result, 'duplicate', 'a replay');
      eq((await host.effects(s.deliveryId)).length, owed, 'neither wrote an effect');
      // A drain that dies mid-effect: the row is claimed with a short lease and never acknowledged.
      const first = (await host.store.claimDueEffects({ limit: 50, leaseMs: 1, deliveryId: s.deliveryId })).find((e) => e.kind === 'dispatch_review')!;
      ok(first, 'the review effect was claimed');
      await host.passTime(60);
      const second = (await host.store.claimDueEffects({ limit: 50, leaseMs: 60_000, deliveryId: s.deliveryId })).find((e) => e.kind === 'dispatch_review')!;
      ok(second && second.id === first.id, 'the lease expired and the same row was claimed again');
      eq([first.attemptCount, second.attemptCount], [1, 2], 'the second claim is the second attempt');
      eq(await host.store.ackEffect(first.id, first.attemptCount, 'ok'), false, 'the dead drain can no longer settle it');
      eq(await host.store.ackEffect(second.id, second.attemptCount, 'ok'), true, 'the live one settles it');
      const rest = await host.store.claimDueEffects({ limit: 50, leaseMs: 60_000, deliveryId: s.deliveryId });
      ok(!rest.some((e) => e.kind === 'dispatch_review'), 'an acknowledged effect is never claimed again');
    },
  },
  {
    name: 'S15: a base that keeps moving is refreshed a bounded number of times, then the delivery stays with a person',
    async run(host) {
      const s = await new Delivery(host, 217).open();
      await s.approvedAt('H1');
      let head = 'H1';
      let escalatedAt = -1;
      for (let i = 1; i <= 8 && escalatedAt < 0; i++) {
        applied(await s.land(head), 'LANDING', `landing ${i}`);
        const r = await s.submit({ type: 'MergeCallResult', actor: 'kernel', headSha: head, outcome: 'behind' });
        if (r.result === 'applied' && r.decision.toState === 'ESCALATED') { escalatedAt = i; break; }
        applied(r, 'REPAIRING', `behind ${i} is refreshed`);
        eq((await s.view()).attempts.filter((a) => a.family === 'conflict' && a.mode === 'mechanical').length > 0, true, 'a mechanical refresh is on the ledger');
        head = `H${i + 1}`;
        applied(await s.push(head, { carryForward: 'own_refresh', attribution: { descendsFromBound: true } }), 'APPROVED', 'the refresh landed on the PR');
      }
      ok(escalatedAt > 1 && escalatedAt <= 8, `the treadmill is bounded (escalated at ${escalatedAt})`);
      eq(pick(await s.d(), ['state', 'stateReason']), { state: 'ESCALATED', stateReason: 'landing_needs_human' }, 'a person lands it');
      // A person's freshness override lands it.
      applied(await s.submit({ type: 'LandingRequested', actor: 'human:u', door: 'dashboard', headSha: head, live: s.live(head), override: { reason: 'land across the moving base', kinds: ['freshness'] } }), 'LANDING', 'the override lands it');
    },
  },
  {
    name: 'S16: a delivery reads to mission completion as merged, closed or open for every terminal and open state',
    async run(host) {
      const prState = async (d: Delivery) => deliveryPrState(await d.d());
      const open = await new Delivery(host, 218).open();
      eq(await prState(open), 'awaiting_ci', 'open');
      const merged = await new Delivery(host, 219).open();
      await merged.ownerPushed('H1');
      await merged.merged('H1');
      eq(await prState(merged), 'merged', 'merged');
      const closed = await new Delivery(host, 220).open();
      await closed.ownerPushed('H1');
      applied(await closed.submit({ type: 'PrClosedUnmerged', actor: 'webhook', live: closedUnmerged(closed, 'H1'), closeCause: 'manual' }), 'CLOSED_UNMERGED', 'closed');
      eq(await prState(closed), 'closed', 'closed unmerged');
      applied(await closed.submit({ type: 'SupersessionRecorded', actor: 'agent:t', target: { repoFullName: 'acme/o', prNumber: 5, merged: true, url: null }, reason: 'shipped elsewhere', authorised: true }), 'SUPERSEDED', 'superseded');
      eq(await prState(closed), 'closed', 'superseded reads closed');
      const abandoned = await new Delivery(host, 221).open();
      await abandoned.ownerPushed('H1');
      applied(await abandoned.submit({ type: 'PrClosedUnmerged', actor: 'webhook', live: closedUnmerged(abandoned, 'H1'), closeCause: 'manual' }), 'CLOSED_UNMERGED', 'closed');
      applied(await abandoned.submit({ type: 'Abandon', actor: 'human:u', reason: 'not needed' }), 'ABANDONED', 'abandoned');
      eq(await prState(abandoned), 'closed', 'abandoned reads closed');
    },
  },
  {
    name: 'S17: the one read-model view agrees with the stored delivery at every state a PR passes through',
    async run(host) {
      const s = await new Delivery(host, 222).open();
      const seen: string[] = [];
      const check = async (label: string) => {
        const view = await s.view();
        const dv = deriveDeliveryView({ view })!;
        eq(pick(dv, ['state', 'version', 'headSha', 'prNumber']), { state: view.delivery!.state, version: view.delivery!.version, headSha: view.delivery!.currentHeadSha, prNumber: s.prNumber }, `${label}: the view is the delivery`);
        ok(dv.headline.length > 0 && dv.owner, `${label}: a headline and an owner`);
        seen.push(dv.state);
      };
      await check('working');
      await s.ownerPushed('H1');
      await check('awaiting review');
      await s.verdict('request_changes');
      await check('changes requested');
      const fix = await s.startFix();
      await check('fixing');
      await s.fixEnded(fix, { localHeadSha: 'L2', commitCount: 1, live: s.live('H1') });
      await check('awaiting push');
      await s.push('L2');
      await s.verdict('approve');
      await check('approved');
      await s.ciRed('L2');
      await check('repairing');
      await s.merged('L2');
      await check('merged');
      eq(new Set(seen).size, seen.length, 'every step read a different state');
    },
  },
  {
    name: 'S18: a mission branch deleted under an open task PR closes it as base_deleted, a supersession scan is owed, and the re-opened PR is recorded',
    async run(host) {
      const s = await new Delivery(host, 223).open();
      await s.ownerPushed('H1');
      applied(await s.submit({ type: 'PrClosedUnmerged', actor: 'webhook', live: closedUnmerged(s, 'H1'), closeCause: 'base_deleted' }), 'CLOSED_UNMERGED', 'closed');
      eq(pick(await s.d(), ['state', 'stateReason']), { state: 'CLOSED_UNMERGED', stateReason: 'base_deleted' }, 'the cause is kept');
      eq(await kinds(host, s, 'scan_supersession'), 1, 'a scan for the re-opened PR is owed');
      applied(await s.submit({ type: 'SupersessionRecorded', actor: 'kernel', target: { repoFullName: s.repo, prNumber: 77, merged: true, url: null }, reason: 'the re-opened PR carries the work', authorised: true }), 'SUPERSEDED', 'T20');
      eq((await s.d()).supersededByPr, 77, 'the edge names the re-opened PR');
    },
  },
  {
    name: 'S18b: a person closing the PR on GitHub is CLOSED_UNMERGED(manual), and the transition names who closed it',
    async run(host) {
      const s = await new Delivery(host, 2231).open();
      await s.ownerPushed('H1');
      const closedBy = { login: 'some-human', type: 'User' };
      const r = await s.submit({ type: 'PrClosedUnmerged', actor: 'webhook', live: closedUnmerged(s, 'H1'), closeCause: 'manual', closedBy });
      applied(r, 'CLOSED_UNMERGED', 'closed');
      eq(pick(await s.d(), ['state', 'stateReason']), { state: 'CLOSED_UNMERGED', stateReason: 'manual' }, 'the cause is kept');
      eq(r.result === 'applied' ? (r.decision.evidence as Record<string, unknown>).closedBy : null, closedBy, 'the closer is on the transition');
    },
  },
  {
    name: 'S19: a fix worker killed after its claim returns to changes-requested with the next attempt owed, and exhausts at the cap',
    async run(host) {
      const s = await new Delivery(host, 224).open();
      await s.ownerPushed('H1');
      await s.verdict('request_changes');
      const f1 = await s.startFix();
      applied(await s.fixEnded(f1, { outcome: 'lost' }), 'CHANGES_REQUESTED', 'killed');
      eq(pick((await s.view()).attempts.find((a) => a.id === f1)!, ['status']), { status: 'ended' }, 'the ledger row ends');
      eq((await host.effects(s.deliveryId)).filter((e) => e.kind === 'dispatch_fix').map((e) => e.payload.attemptNo).sort(), [1, 2], 'attempt 2 owed');
      const f2 = await s.startFix();
      eq((await s.view()).attempts.find((a) => a.id === f2)!.attemptNo, 2, 'the next dispatch allocates attempt 2');
      applied(await s.fixEnded(f2, { outcome: 'failed' }), 'CHANGES_REQUESTED', 'killed again');
      const f3 = await s.startFix();
      eq((await s.view()).attempts.find((a) => a.id === f3)!.attemptNo, 3, 'and then attempt 3');
      applied(await s.fixEnded(f3, { outcome: 'lost' }), 'ESCALATED', 'the cap is spent');
      eq(pick(await s.d(), ['state', 'stateReason']), { state: 'ESCALATED', stateReason: 'review_exhausted' }, 'exhausted');
    },
  },
  {
    name: 'S21: the kernel refuses a supersession the caller was not authorised to record and a human approval without merge permission',
    async run(host) {
      const s = await new Delivery(host, 225).open();
      await s.ownerPushed('H1');
      applied(await s.submit({ type: 'PrClosedUnmerged', actor: 'webhook', live: closedUnmerged(s, 'H1'), closeCause: 'manual' }), 'CLOSED_UNMERGED', 'closed');
      const edge = (authorised: boolean) => s.submit({ type: 'SupersessionRecorded', actor: 'agent:sibling', target: { repoFullName: s.repo, prNumber: 5, merged: true, url: null }, reason: 'sibling task claims it', authorised });
      eq((await edge(false)).result, 'rejected', 'a caller the route did not authorise records nothing');
      eq((await s.d()).state, 'CLOSED_UNMERGED', 'unchanged');
      const t = await new Delivery(host, 226).open();
      await t.ownerPushed('H1');
      const approve = (hasMergePermission: boolean) => t.submit({ type: 'HumanApproved', actor: 'human:u', reviewId: 'rv1', commitId: 'H1', hasMergePermission });
      eq((await approve(false)).result, 'rejected', 'a person without merge permission cannot approve');
      eq((await t.d()).approvedHeads, [], 'nothing approved');
    },
  },
  {
    name: 'S23: CI provenance: a push the running repair reported is the repair\'s, a person\'s push skips a queued repair without spending budget, and the cap bounds dispatches',
    async run(host) {
      // A running repair's own push (whoever authored it) is its delivery.
      const a = await new Delivery(host, 227).open();
      await a.approvedAt('H1');
      applied(await a.ciRed('H1'), 'REPAIRING', 'ci red');
      const repair = (await a.view()).attempts.find((x) => x.family === 'ci')!;
      applied(await a.submit({ type: 'FixClaimed', actor: 'runner', attemptId: repair.id, revalidation: { live: a.live('H1'), approved: false } }), 'REPAIRING', 'claimed');
      applied(await a.push('H2', { attribution: { descendsFromBound: true } }), 'AWAITING_REVIEW', 'the repair\'s push');
      eq(pick((await a.view()).attempts.find((x) => x.id === repair.id)!, ['outcome']), { outcome: 'delivered' }, 'attributed by SHA, consuming the ledger row');
      eq((await a.view()).attempts.filter((x) => x.family === 'ci').length, 1, 'and no second row');
      // A person pushes while the repair is only queued: the row is skipped.
      const b = await new Delivery(host, 228).open();
      await b.approvedAt('H1');
      applied(await b.ciRed('H1'), 'REPAIRING', 'ci red');
      const queued = (await b.view()).attempts.find((x) => x.family === 'ci')!;
      applied(await b.push('HUMAN1', { attribution: { descendsFromBound: true } }), 'AWAITING_REVIEW', 'a person\'s push');
      eq(pick((await b.view()).attempts.find((x) => x.id === queued.id)!, ['status', 'outcome']), { status: 'skipped', outcome: 'noop' }, 'no budget spent');
      // The cap: every failed repair is followed by the next dispatch until three, then a person.
      const c = await new Delivery(host, 229).open();
      await c.approvedAt('H1');
      applied(await c.ciRed('H1'), 'REPAIRING', 'ci red');
      for (let i = 0; i < 8 && (await c.d()).state === 'REPAIRING'; i++) {
        const row = (await c.view()).attempts.filter((x) => x.family === 'ci' && (x.status === 'queued' || x.status === 'running')).at(-1)!;
        ok(row, 'a repair is open while repairing');
        if (row.status === 'queued') await c.submit({ type: 'FixClaimed', actor: 'runner', attemptId: row.id, revalidation: { live: c.live('H1'), approved: false } });
        await c.submit({ type: 'AttemptEnded', actor: 'runner', workerId: `cw${i}`, attemptId: row.id, taskId: row.taskId ?? host.newId(), outcome: 'failed', localHeadSha: null, commitCount: 0, live: c.live('H9') });
        if ((await c.d()).state !== 'REPAIRING') await c.ciRed('H1');
      }
      eq(pick(await c.d(), ['state', 'stateReason']), { state: 'ESCALATED', stateReason: 'ci_exhausted' }, 'the budget is spent and a person has it');
      eq((await c.view()).attempts.filter((x) => x.family === 'ci').length, 3, 'three dispatches, never a fourth');
    },
  },
  {
    name: 'S24: a trunk-red head is blocked without spending CI budget, files no per-PR repair, and re-enters its prior state when the base recovers',
    async run(host) {
      const s = await new Delivery(host, 230).open();
      await s.approvedAt('H1');
      const incident = host.newId();
      applied(await s.trunkRed(incident, 'sig:trunk'), 'BLOCKED_ON_TRUNK', 'red on trunk too');
      eq((await s.view()).attempts.filter((a) => a.family === 'ci'), [], 'zero per-PR ci attempts');
      eq((await s.d()).trunkIncidentId, incident, 'bound to the incident');
      // A CI failure that matches the open incident routes to it, not to a repair.
      const t = await new Delivery(host, 231).open();
      await t.approvedAt('H1');
      applied(await t.ciRed('H1'), 'REPAIRING', 'a CI repair queued');
      const queued = (await t.view()).attempts.find((a) => a.family === 'ci')!;
      applied(await t.ciRed('H1', { openTrunkIncidentId: host.newId() }), 'BLOCKED_ON_TRUNK', 'joins the incident');
      eq((await t.view()).attempts.find((a) => a.id === queued.id)!.status, 'skipped', 'the queued attempt is skipped, not spent');
      // Recovery.
      applied(await s.submit({ type: 'TrunkRecovered', actor: 'kernel', incidentId: incident, baseStillRed: false, headPredatesFix: false }), 'APPROVED', 'recovery re-enters resume_state');
      eq((await s.view()).attempts.filter((a) => a.family === 'ci'), [], 'ci budget untouched');
    },
  },
  {
    name: 'S28: repair families count independently, and the attempt label is 1-based from the ledger',
    async run(host) {
      const s = await new Delivery(host, 232).open();
      await s.ownerPushed('H1');
      await s.verdict('request_changes');
      const fix = await s.startFix();
      applied(await s.fixEnded(fix, { localHeadSha: 'H2', commitCount: 1, live: s.live('H2'), proof: { liveContainsLocal: true } }), 'AWAITING_REVIEW', 'fix delivered');
      applied(await s.verdict('approve'), 'APPROVED', 'approved');
      applied(await s.ciRed('H2'), 'REPAIRING', 'ci red');
      const v = await s.view();
      const ci = v.attempts.find((a) => a.family === 'ci')!;
      eq(pick(ci, ['attemptNo', 'maxAttempts']), { attemptNo: 1, maxAttempts: 3 }, 'a review fix never consumed the ci budget');
      eq(v.attempts.find((a) => a.id === fix)!.attemptNo, 1, 'the review fix is its own count');
      const label = repairLabelOf(ci, v.attempts);
      ok(/ 1 of 3$/.test(label), `the label is 1-based: ${label}`);
      const dv = deriveDeliveryView({ view: v })!;
      eq(dv.attempts.ci, { n: 1, m: 3 }, 'and the delivery view agrees');
      eq(dv.attempts.review_fix, { n: 1, m: 3 }, 'for each family');
    },
  },
  {
    name: 'S29: a reviewer that answered in prose or not at all fails the round, re-queued at the same head, then escalated; an interrupt escalates at once; prose is never a verdict',
    async run(host) {
      const s = await new Delivery(host, 233).open();
      await s.ownerPushed('H1');
      const r1 = await s.latestRound();
      const fail = (reason: 'no_verdict' | 'prose_verdict' | 'infra' | 'human_takeover', reviewerTaskId: string) =>
        s.submit({ type: 'ReviewRoundFailed', actor: 'runner', roundId: r1.id, reason, maxContractRetries: 2, reviewerTaskId });
      applied(await fail('prose_verdict', 'rv1'), 'AWAITING_REVIEW', 'first failure is re-queued');
      eq(pick(await s.latestRound(), ['round', 'headSha', 'failureCount']), { round: 1, headSha: 'H1', failureCount: 1 }, 'the same round, the same head, no new round number');
      applied(await fail('no_verdict', 'rv2'), 'AWAITING_REVIEW', 'second failure is re-queued');
      applied(await fail('infra', 'rv3'), 'ESCALATED', 'the retries are spent');
      eq(pick(await s.d(), ['state', 'stateReason']), { state: 'ESCALATED', stateReason: 'review_unavailable' }, 'review_unavailable');
      eq((await s.d()).approvedHeads, [], 'prose approved nothing');
      eq((await s.view()).rounds.length, 1, 'no round was added');
      const t = await new Delivery(host, 234).open();
      await t.ownerPushed('H1');
      applied(await t.submit({ type: 'ReviewRoundFailed', actor: 'human:interrupt', roundId: (await t.latestRound()).id, reason: 'human_takeover', maxContractRetries: 2 }), 'ESCALATED', 'an interrupt escalates at once');
      eq((await t.d()).stateReason, 'review_unavailable', 'with the same reason');
    },
  },
  {
    name: 'S30: a runner hand-off with no confirmed outcome waits for the push when commits exist and is requeued when nothing is local, never completed',
    async run(host) {
      const unproven = (d: Delivery, o: Partial<Extract<Command, { type: 'AttemptEnded' }>>) =>
        d.submit({ type: 'AttemptEnded', actor: 'runner', workerId: `w${Math.random()}`, taskId: d.ownerTaskId, outcome: 'unproven', localHeadSha: null, commitCount: 0, live: d.live('H1'), ...o });
      const a = await new Delivery(host, 235).open();
      applied(await unproven(a, { localHeadSha: 'L9', commitCount: 2, taskRetryBudgetLeft: true }), 'AWAITING_PUSH', 'commits but no PR head');
      eq(await kinds(host, a, 'push_recovery'), 1, 'recovery owed');
      const b = await new Delivery(host, 236).open();
      applied(await unproven(b, { taskRetryBudgetLeft: true }), 'WORKING', 'nothing local: requeued');
      eq((await b.view()).rounds.length, 0, 'no review round at the old head');
      eq(await kinds(host, b, 'dispatch_review'), 0, 'no review owed');
      const c = await new Delivery(host, 237).open();
      applied(await unproven(c, { localHeadSha: 'L1', commitCount: 1, live: null }), 'AWAITING_PUSH', 'uncommitted or unpushed work is not a delivery');
      ok((await c.d()).state !== 'MERGED', 'never completed');
    },
  },
  {
    name: 'S31: a CI failure a configured preflight covers is tagged preflight_miss on the transition and changes nothing else',
    async run(host) {
      const a = await new Delivery(host, 238).open();
      await a.approvedAt('H1');
      const tagged = await a.ciRed('H1', { preflightMiss: 'No Production Data' });
      applied(tagged, 'REPAIRING', 'tagged');
      const b = await new Delivery(host, 239).open();
      await b.approvedAt('H1');
      const plain = await b.ciRed('H1');
      applied(plain, 'REPAIRING', 'plain');
      const evidence = (r: CommandResult) => (r.result === 'applied' ? (r.decision.evidence as Record<string, unknown>) : {});
      eq(evidence(tagged).preflightMiss, 'No Production Data', 'the miss is on the transition');
      ok(!('preflightMiss' in evidence(plain)), 'an ordinary failure carries none');
      eq((await a.effectKinds()), (await b.effectKinds()), 'the same effects either way');
    },
  },
  {
    name: 'S32: a release PR composed only of reviewed constituents is approved by composition: no round decided, no reviewer, CI still gates, and a replay is idempotent',
    async run(host) {
      const s = await new Delivery(host, 240).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'release PR opened');
      const c = composition(s, 'H1');
      applied(await s.submit({ type: 'CompositionAttested', actor: 'kernel', ...c, factId: null }), 'APPROVED', 'attested');
      eq(pick(await s.d(), ['approvalBasis', 'compositionHeads', 'approvedHeads']), { approvalBasis: 'composition', compositionHeads: ['H1'], approvedHeads: [] }, 'composition heads only');
      eq((await s.view()).rounds.map((r) => r.status), ['superseded'], 'the open round is withdrawn, not decided');
      eq(await kinds(host, s, 'post_review'), 0, 'no review is posted');
      const again = await s.submit({ type: 'CompositionAttested', actor: 'kernel', ...c, factId: null });
      ok(again.result === 'duplicate' || again.result === 'stale', `a duplicate delivery changes nothing (${again.result})`);
      eq(pick(await s.d(), ['state', 'compositionHeads']), { state: 'APPROVED', compositionHeads: ['H1'] }, 'once');
      applied(await s.ciRed('H1'), 'REPAIRING', 'CI still gates a composed head');
    },
  },
  {
    name: 'S33: a release PR with a release-only novel delta gets a delta round scoped to the novel paths, and its approval stays a composition approval',
    async run(host) {
      const s = await new Delivery(host, 241).open();
      await s.ownerPushed('H1');
      const c = composition(s, 'H1', { result: 'present', paths: ['packages/core/x.ts'] });
      applied(await s.submit({ type: 'CompositionAttested', actor: 'kernel', ...c, factId: null }), 'AWAITING_REVIEW', 'attested with a novel delta');
      const delta = await s.latestRound();
      eq(pick(delta, ['round', 'kind', 'headSha']), { round: 2, kind: 'delta', headSha: 'H1' }, 'a delta round');
      eq((delta as { scope?: unknown }).scope, { novelDeltaPaths: ['packages/core/x.ts'], composition: true }, 'scoped to the novel paths');
      eq((await s.d()).compositionHeads, [], 'nothing covered before the delta is reviewed');
      applied(await s.verdict('approve'), 'APPROVED', 'the delta is approved');
      eq(pick(await s.d(), ['approvalBasis', 'compositionHeads', 'approvedHeads']), { approvalBasis: 'composition', compositionHeads: ['H1'], approvedHeads: [] }, 'a composition approval, not a whole-release verdict');
      const post = (await host.effects(s.deliveryId)).find((e) => e.kind === 'post_review')!;
      eq((post.payload as { scope?: unknown }).scope, { compositionDelta: true, paths: ['packages/core/x.ts'] }, 'the review says it covers only the delta');
    },
  },
  {
    name: 'S34: a composition whose proof fails closes: nothing is borrowed, the head stays in review, and an ordinary PR stays bound to its exact head',
    async run(host) {
      const s = await new Delivery(host, 242).open();
      await s.ownerPushed('H1');
      const att = (o: Partial<CompositionAttestation> = {}, ev?: ConstituentEvidence[]) => {
        const c = composition(s, 'H1');
        return s.submit({ type: 'CompositionAttested', actor: 'kernel', attestation: { ...c.attestation, ...o }, constituents: ev ?? c.constituents, factId: null });
      };
      const good = composition(s, 'H1').constituents[0]!;
      eq(outcome(await att({ novelDelta: { result: 'unverifiable', reason: 'landed_patch_unreadable' } })), { result: 'rejected', reason: 'composition_unverifiable' }, 'unverifiable');
      eq(outcome(await att({}, [])), { result: 'rejected', reason: 'composition_not_verified' }, 'incomplete set');
      eq(outcome(await att({}, [{ ...good, roundHeadSha: 'C0' }])), { result: 'rejected', reason: 'composition_not_verified' }, 'head mismatch');
      eq(outcome(await att({}, [{ ...good, latestDecidedVerdictAtHead: 'request_changes' }])), { result: 'rejected', reason: 'composition_not_verified' }, 'a stale constituent review');
      eq(outcome(await att({ aggregateHeadSha: 'H0' })), { result: 'stale', reason: 'head_not_current' }, 'wrong head');
      eq(pick(await s.d(), ['state', 'compositionHeads', 'approvedHeads']), { state: 'AWAITING_REVIEW', compositionHeads: [], approvedHeads: [] }, 'nothing borrowed');
      // An ordinary PR is bound to its exact head.
      const t = await new Delivery(host, 243).open();
      await t.approvedAt('H1');
      applied(await t.push('H2'), 'AWAITING_REVIEW', 'a new head is not covered by the old approval');
      eq((await t.d()).approvedHeads, ['H1'], 'only the reviewed head');
    },
  },
  {
    name: 'S35: a replacement chain reads the current attempt; the failed predecessor stays auditable, marked superseded',
    async run(host) {
      const s = await new Delivery(host, 244).open();
      await s.ownerPushed('H1');
      await s.verdict('request_changes');
      const f1 = await s.startFix();
      await s.fixEnded(f1, { outcome: 'lost' });
      const f2 = await s.startFix();
      const v = await s.view();
      const t1 = v.attempts.find((a) => a.id === f1)!.taskId!;
      const t2 = v.attempts.find((a) => a.id === f2)!.taskId!;
      const attemptTasks = [
        { taskId: t1, role: 'fix', status: 'failed', createdAt: '2026-10-06T01:00:00Z' },
        { taskId: t2, role: 'fix', status: 'in_progress', createdAt: '2026-10-06T02:00:00Z' },
      ];
      const dv = deriveDeliveryView({ view: v, attemptTasks })!;
      eq(pick(dv, ['state', 'stage']), { state: 'FIXING', stage: 'fixing' }, 'fixing');
      eq(dv.currentAttempt?.taskId, t2, 'the current attempt is the second');
      eq(dv.attempts.review_fix, { n: 2, m: 3 }, 'attempt 2 of 3');
      eq(dv.history.map((h) => ({ taskId: h.taskId, superseded: h.superseded })), [{ taskId: t1, superseded: true }, { taskId: t2, superseded: false }], 'the failed one is superseded, not erased');
    },
  },
  {
    name: 'S36: a recoverable blocker is platform-owned and keeps its evidence; only an escalation is a person\'s',
    async run(host) {
      const s = await new Delivery(host, 245).open();
      await s.ownerPushed('H1');
      await s.verdict('request_changes');
      const fix = await s.startFix();
      await s.fixEnded(fix, { localHeadSha: 'LOCAL77', commitCount: 1, live: s.live('H1') });
      const push = deriveDeliveryView({ view: await s.view() })!;
      eq(pick(push, ['state', 'owner', 'needsYou']), { state: 'AWAITING_PUSH', owner: 'platform', needsYou: false }, 'waiting for the push is not a person\'s');
      ok(push.detail?.includes('H1') || push.detail?.includes('LOCAL7'), `the evidence is kept: ${push.detail}`);
      const t = await new Delivery(host, 246).open({ maxRounds: 1 });
      await t.ownerPushed('H1');
      await t.verdict('request_changes');
      const esc = deriveDeliveryView({ view: await t.view() })!;
      eq(pick(esc, ['state', 'owner', 'needsYou']), { state: 'ESCALATED', owner: 'human', needsYou: true }, 'a spent budget is a person\'s');
      const u = await new Delivery(host, 247).open();
      await u.ownerPushed('H1');
      const working = deriveDeliveryView({ view: await u.view() })!;
      eq(pick(working, ['owner', 'needsYou']), { owner: 'reviewer', needsYou: false }, 'a review in flight is the reviewer\'s');
    },
  },
  {
    name: 'S37: a conflict that already has an agent remediation is not filed twice, and the projection offers to run or repair the existing one',
    async run(host) {
      const s = await new Delivery(host, 248).open();
      await s.approvedAt('H1');
      const conflict = () => s.submit({ type: 'ConflictObserved', actor: 'webhook', headSha: 'H1', mergeable: 'dirty', mechanicalRefused: true, maxAgentAttempts: 3 });
      applied(await conflict(), 'REPAIRING', 'a textual conflict goes to an agent');
      const fixes = (await s.view()).attempts.filter((a) => a.family === 'conflict');
      eq(fixes.length, 1, 'one remediation on the ledger');
      const again = await conflict();
      ok(again.result !== 'applied', `a second observation files nothing (${again.result})`);
      eq((await s.view()).attempts.filter((a) => a.family === 'conflict').length, 1, 'still one');
      eq((await host.effects(s.deliveryId)).filter((e) => e.kind === 'dispatch_conflict_fix').length, 1, 'one dispatch owed');
      const taskId = fixes[0]!.taskId ?? 'cf1';
      const stalled = deriveDeliveryView({ view: await s.view(), remediation: { taskId, family: 'conflict', taskStatus: 'pending', stalled: true, stallReason: 'pending with no runner claim' } })!;
      eq(pick(stalled, ['headline', 'cta']), { headline: 'Conflict fix stalled', cta: { action: 'repair_remediation', label: 'Run fix', taskId } }, 'run the existing fix');
    },
  },
];

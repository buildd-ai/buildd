/**
 * The conformance scenarios as data (docs/specs/workflow-kernel-library.md
 * §2, AC-6 and AC-7): each one drives the kernel's command runner, effect
 * drain, landing lane and decision recording through a `ConformanceHost`'s
 * Store, and checks what it reads back. The package runs them on the
 * in-memory store; buildd runs the same list against its Postgres store under
 * `bun run test:db` (apps/web/tests/db/workflow-kernel-conformance.test.ts).
 *
 * Expectations are host-independent: no test reads ids, wall-clock times or
 * the order of effects written by one transition (Postgres orders those by a
 * random id). Assertions throw; this file imports no test runner.
 */
import { applyCommandOn } from '../command-runner';
import type { Command, EffectKind, LivePr } from '../commands';
import { decideAndRecord, decideAt, VISUAL_IMPACT_POINT } from '../decide';
import { drainEffects, type EffectHandlers } from '../effects';
import { acquireLaneOn, settleLanesOn } from '../landing-lane';
import type { CommandResult, Decide, DeliveryRef, Store } from '../ports';
import { deriveDeliveryView } from '../projections';
import type { DeliverySnapshot, KernelView } from '../types';

/** What a host gives the scenarios: its store, ids it accepts, a way to seed owners, and read-back of the outbox. */
export interface ConformanceHost {
  store: Store;
  /** Ids the host's store accepts for rounds, attempts and tasks (uuids for Postgres). */
  newId(): string;
  /** A fresh workspace + owner task the store will accept a delivery for. */
  seedOwner(): Promise<{ workspaceId: string; ownerTaskId: string }>;
  /** A repo name no other scenario (or test sharing the store) uses: lanes are global per repo + base. */
  uniqueRepo(): string;
  /** The outbox rows of one delivery. */
  effects(deliveryId: string): Promise<Array<{ kind: EffectKind; payload: Record<string, unknown>; status: string; outcome: string | null; attemptCount: number; lastError: string | null }>>;
  /** The transition log of one delivery, in version order. */
  transitions(deliveryId: string): Promise<Array<{ fromVersion: number; toVersion: number; command: string; toState: string }>>;
  /** §14: turn the workspace's kill switch off (or back on). */
  setKernelEnabled(workspaceId: string, on: boolean): Promise<void>;
}

export interface ConformanceScenario {
  name: string;
  run(host: ConformanceHost): Promise<void>;
}

// ── Assertions ──────────────────────────────────────────────────────────────

export class ConformanceFailure extends Error {}

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  return v;
}

export function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(canon(actual));
  const e = JSON.stringify(canon(expected));
  if (a !== e) throw new ConformanceFailure(`${label}\n  expected ${e}\n  actual   ${a}`);
}

function ok(cond: unknown, label: string): void {
  if (!cond) throw new ConformanceFailure(label);
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

// ── One delivery, driven as a host drives it ────────────────────────────────

const live = (repo: string, headSha: string, o: Partial<LivePr> = {}): LivePr => ({ state: 'open', merged: false, headSha, headRepoFullName: repo, baseRef: 'dev', ...o });
const MERGED_AT = '2026-01-01T01:00:00.000Z';

export class Delivery {
  ref!: DeliveryRef;
  workspaceId!: string;
  ownerTaskId!: string;
  deliveryId!: string;
  readonly repo: string;
  readonly prNumber: number;
  private worker = 0;
  private fixTask: string | null = null;

  constructor(readonly host: ConformanceHost, prNumber = 7) {
    this.repo = host.uniqueRepo();
    this.prNumber = prNumber;
  }

  live(head: string, o: Partial<LivePr> = {}): LivePr { return live(this.repo, head, o); }
  mergedLive(head: string): LivePr { return this.live(head, { state: 'closed', merged: true, mergedAt: MERGED_AT, mergeCommitSha: 'M1' }); }

  submit(cmd: Command, factId?: string | null): Promise<CommandResult> {
    return applyCommandOn(this.host.store, cmd, { ref: this.ref, factId, newId: () => this.host.newId() });
  }
  async view(): Promise<KernelView> { return this.host.store.loadView(this.ref); }
  async d(): Promise<DeliverySnapshot> { return (await this.view()).delivery!; }
  async latestRound() { return (await this.view()).rounds.at(-1)!; }
  async effectKinds(): Promise<string[]> { return (await this.host.effects(this.deliveryId)).map((e) => e.kind).sort(); }
  async count(kind: EffectKind): Promise<number> { return (await this.host.effects(this.deliveryId)).filter((e) => e.kind === kind).length; }

  async open(): Promise<this> {
    ({ workspaceId: this.workspaceId, ownerTaskId: this.ownerTaskId } = await this.host.seedOwner());
    this.ref = { workspaceId: this.workspaceId, ownerTaskId: this.ownerTaskId };
    const o = await applyCommandOn(this.host.store, { type: 'DeliveryOpened', actor: 'runner', workspaceId: this.workspaceId, ownerTaskId: this.ownerTaskId, requiresPr: true }, { newId: () => this.host.newId() });
    applied(o, 'WORKING', 'DeliveryOpened');
    this.deliveryId = (o as Extract<CommandResult, { result: 'applied' }>).deliveryId;
    this.ref = { deliveryId: this.deliveryId };
    applied(await this.submit({ type: 'PrBound', actor: 'runner', repoFullName: this.repo, prNumber: this.prNumber, live: this.live('H1') }), 'WORKING', 'PrBound');
    return this;
  }
  ownerPushed(head = 'H1'): Promise<CommandResult> {
    return this.submit({ type: 'AttemptEnded', actor: 'runner', workerId: `wk${++this.worker}`, taskId: this.ownerTaskId, outcome: 'success', localHeadSha: head, commitCount: 1, live: this.live(head) });
  }
  async verdict(verdict: 'approve' | 'request_changes', roundId?: string, headBound?: string): Promise<CommandResult> {
    const rounds = (await this.view()).rounds;
    const r = roundId ? rounds.find((x) => x.id === roundId)! : rounds.at(-1)!;
    return this.submit({ type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: r.id, verdict, effectiveVerdict: verdict, headBound: headBound ?? r.headSha });
  }
  /** T8 then T9: the fix is dispatched for the current round and claimed. Returns its attempt id. */
  async startFix(): Promise<string> {
    const head = (await this.d()).currentHeadSha!;
    this.fixTask = this.host.newId();
    applied(await this.submit({ type: 'FixDispatched', actor: 'kernel', roundId: (await this.latestRound()).id, taskId: this.fixTask, maxAttempts: 3, revalidation: { live: this.live(head), newerApprove: false } }), 'CHANGES_REQUESTED', 'FixDispatched');
    const attempt = (await this.view()).attempts.find((a) => a.family === 'review_fix' && a.status === 'queued')!;
    applied(await this.submit({ type: 'FixClaimed', actor: 'runner', attemptId: attempt.id, revalidation: { live: this.live(head), approved: false } }), 'FIXING', 'FixClaimed');
    return attempt.id;
  }
  push(head: string, o: Partial<Extract<Command, { type: 'HeadObserved' }>> = {}): Promise<CommandResult> {
    return this.submit({ type: 'HeadObserved', actor: 'webhook', live: this.live(head), ...o });
  }
  async fixEnded(attemptId: string, o: Partial<Extract<Command, { type: 'AttemptEnded' }>>): Promise<CommandResult> {
    const head = (await this.d()).currentHeadSha!;
    return this.submit({ type: 'AttemptEnded', actor: 'runner', workerId: `wk${++this.worker}`, taskId: this.fixTask ?? this.host.newId(), attemptId, outcome: 'success', localHeadSha: null, commitCount: 0, live: this.live(head), ...o });
  }
  land(head: string): Promise<CommandResult> {
    return this.submit({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: head, live: this.live(head), rails: { passed: true } });
  }
  merged(head: string): Promise<CommandResult> {
    return this.submit({ type: 'PrMerged', actor: 'webhook', live: this.mergedLive(head) });
  }
  async approvedAt(head = 'H1'): Promise<this> {
    applied(await this.ownerPushed(head), 'AWAITING_REVIEW', 'owner pushed');
    applied(await this.verdict('approve'), 'APPROVED', 'approve');
    return this;
  }
}

/** Every handler a drain may meet, each recording what ran. */
function recordingHandlers(ran: string[], override: EffectHandlers = {}): EffectHandlers {
  const kinds: EffectKind[] = [
    'render_activity', 'stamp_pr_rows', 'notify', 'mission_note', 'wake_mission', 'release_attribution', 'finalize_mission_pr',
    'emit_pr_merged', 'verify_merge', 'cancel_open_attempts', 'scan_supersession', 'project_supersession', 'post_review',
    'escalate_exhaustion', 'gate_event', 'dispatch_review', 'dispatch_fix', 'merge_call', 'refresh_branch', 'renumber_migration', 'push_recovery',
  ];
  const out: EffectHandlers = {};
  for (const k of kinds) out[k] = async () => { ran.push(k); return { outcome: 'ok' }; };
  return { ...out, ...override };
}

const neverAsked: Decide = { id: 'never', decide: async () => { throw new ConformanceFailure('a replay called the decider'); } };

// ── Scenarios ───────────────────────────────────────────────────────────────

export const CONFORMANCE_SCENARIOS: ConformanceScenario[] = [
  {
    name: 'happy path: open → review → changes requested → fix pushed → re-review → approved → landing → merged',
    async run(host) {
      const s = await new Delivery(host).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      eq(pick(await s.latestRound(), ['round', 'headSha', 'kind', 'status']), { round: 1, headSha: 'H1', kind: 'full', status: 'queued' }, 'round 1');
      applied(await s.verdict('request_changes'), 'CHANGES_REQUESTED', 'request changes');
      const kinds = await s.effectKinds();
      ok(kinds.includes('post_review') && kinds.includes('dispatch_fix'), `post_review and dispatch_fix owed: ${kinds}`);
      const fix = await s.startFix();
      applied(await s.push('H2', { attribution: { descendsFromBound: true } }), 'FIXING', 'fix push mid-attempt');
      eq((await s.view()).attempts.find((a) => a.id === fix)!.reportedShas, ['H2'], 'fix push recorded as provenance');
      applied(await s.fixEnded(fix, { localHeadSha: 'H2', commitCount: 1, live: s.live('H2'), proof: { liveContainsLocal: true } }), 'AWAITING_REVIEW', 'fix ended');
      eq(pick(await s.latestRound(), ['round', 'headSha', 'kind', 'status']), { round: 2, headSha: 'H2', kind: 'delta', status: 'queued' }, 'round 2');
      eq(pick((await s.view()).attempts.find((a) => a.id === fix)!, ['status', 'outcome']), { status: 'ended', outcome: 'delivered' }, 'fix attempt delivered');
      applied(await s.verdict('approve'), 'APPROVED', 'approve');
      eq(pick(await s.d(), ['approvedHeads', 'approvalBasis']), { approvedHeads: ['H2'], approvalBasis: 'verdict' }, 'approval binds H2');
      applied(await s.land('H2'), 'LANDING', 'landing');
      eq((await host.effects(s.deliveryId)).filter((e) => e.kind === 'merge_call').map((e) => e.payload.headSha), ['H2'], 'merge at the approved head');
      applied(await s.submit({ type: 'MergeCallResult', actor: 'kernel', headSha: 'H2', outcome: 'merged' }), 'LANDING', 'merge call result');
      applied(await s.merged('H2'), 'MERGED', 'merged');
      eq(pick(await s.d(), ['mergeCommitSha', 'state']), { mergeCommitSha: 'M1', state: 'MERGED' }, 'merged delivery');
      const log = await host.transitions(s.deliveryId);
      eq(log.map((t) => [t.fromVersion, t.toVersion]), log.map((_, i) => [i, i + 1]), 'one version per transition, no gaps');
      eq(log.at(-1)!.toVersion, (await s.d()).version, 'the log ends at the delivery\'s version');
    },
  },
  {
    name: 'S2: a head advance invalidates the approval: a delta round at the new head, and the old approval does not land it',
    async run(host) {
      const s = await (await new Delivery(host).open()).approvedAt('H1');
      applied(await s.push('H2'), 'AWAITING_REVIEW', 'push H2');
      eq(pick(await s.latestRound(), ['round', 'headSha', 'kind', 'status']), { round: 2, headSha: 'H2', kind: 'delta', status: 'queued' }, 'delta round');
      ok(!(await s.d()).approvedHeads.includes('H2'), 'H2 not approved');
      notApplied(await s.land('H2'), 'rejected', 'state_not_allowed', 'land unapproved head');
      eq(await s.count('merge_call'), 0, 'no merge owed');
    },
  },
  {
    name: 'S5: a duplicate event is idempotent: same key answers duplicate and owes no second effect',
    async run(host) {
      const s = await new Delivery(host).open();
      await s.ownerPushed('H1');
      const before = (await s.d()).version;
      notApplied(await s.submit({ type: 'AttemptEnded', actor: 'runner', workerId: 'wk1', taskId: s.ownerTaskId, outcome: 'success', localHeadSha: 'H1', commitCount: 1, live: s.live('H1') }), 'duplicate', 'idempotency_key_seen', 'same worker exit twice');
      applied(await s.verdict('request_changes'), 'CHANGES_REQUESTED', 'verdict');
      const after = { version: (await s.d()).version, effects: await s.effectKinds() };
      notApplied(await s.verdict('request_changes', (await s.view()).rounds[0]!.id), 'duplicate', 'idempotency_key_seen', 'same verdict twice');
      eq({ version: (await s.d()).version, effects: await s.effectKinds() }, after, 'nothing more written');
      eq(after.version, before + 1, 'one version for the verdict');
      applied(await s.merged('H1'), 'MERGED', 'merged');
      notApplied(await s.merged('H1'), 'duplicate', 'idempotency_key_seen', 'same merge webhook twice');
      eq(await s.count('emit_pr_merged'), 1, 'merge emitted once');
    },
  },
  {
    name: 'S20: a stale version from a person is answered stale with the current view; nothing applies',
    async run(host) {
      const s = await new Delivery(host).open();
      await s.ownerPushed('H1');
      const seen = (await s.d()).version;
      await s.push('H2');
      const r = await s.submit({ type: 'HumanResolve', actor: 'human:u', choice: 'approve', expectedVersion: seen, commitId: 'H1', hasMergePermission: true });
      notApplied(r, 'stale', 'version_moved', 'stale person');
      eq(r.result !== 'applied' ? r.current : null, { state: 'AWAITING_REVIEW', version: seen + 1, head: 'H2', round: 2 }, 'current view returned');
      eq((await s.d()).version, seen + 1, 'nothing applied');
    },
  },
  {
    name: 'S6: terminal wins: after MERGED a late head is not applied',
    async run(host) {
      const s = await new Delivery(host).open();
      await s.ownerPushed('H1');
      applied(await s.merged('H1'), 'MERGED', 'merged');
      notApplied(await s.push('H9'), 'stale', 'terminal', 'late head');
      eq((await s.d()).state, 'MERGED', 'still merged');
    },
  },
  {
    name: 'CAS: two writers decide from the same version; one applies, the other re-reads and answers from the new state',
    async run(host) {
      const s = await new Delivery(host).open();
      await s.ownerPushed('H1');
      const v = (await s.d()).version;
      const [a, b] = await Promise.all([s.push('H2'), s.push('H2')]);
      eq([a.result, b.result].sort(), ['applied', 'duplicate'], 'one applied, one duplicate');
      eq((await s.d()).version, v + 1, 'one version');
      eq((await host.transitions(s.deliveryId)).filter((t) => t.command === 'HeadObserved').length, 1, 'one transition');
    },
  },
  {
    name: 'opening twice: the second open is a duplicate, never a second delivery',
    async run(host) {
      const { workspaceId, ownerTaskId } = await host.seedOwner();
      const open = () => applyCommandOn(host.store, { type: 'DeliveryOpened', actor: 'runner', workspaceId, ownerTaskId, requiresPr: true }, { newId: () => host.newId() });
      const [a, b] = await Promise.all([open(), open()]);
      eq([a.result, b.result].sort(), ['applied', 'duplicate'], 'one delivery');
      const c = await open();
      eq(c.result, 'duplicate', 'a later open is a duplicate');
    },
  },
  {
    name: '#4686: a review fix that ends with nothing to show leaves the delivery in changes-required with the next attempt owed',
    async run(host) {
      const s = await new Delivery(host).open();
      await s.ownerPushed('H1');
      applied(await s.verdict('request_changes'), 'CHANGES_REQUESTED', 'request changes');
      const fix = await s.startFix();
      applied(await s.fixEnded(fix, { outcome: 'unproven', localHeadSha: null, commitCount: 0 }), 'CHANGES_REQUESTED', 'fix ended with nothing');
      eq(pick((await s.view()).attempts.find((a) => a.id === fix)!, ['status', 'outcome']), { status: 'ended', outcome: 'failed' }, 'attempt failed');
      eq((await host.effects(s.deliveryId)).filter((e) => e.kind === 'dispatch_fix').map((e) => e.payload.attemptNo).sort(), [1, 2], 'next attempt owed');
      const v = await s.view();
      eq(v.rounds.map((r) => pick(r, ['headSha', 'verdict'])), [{ headSha: 'H1', verdict: 'request_changes' }], 'the verdict still stands');
      eq(v.delivery!.approvedHeads, [], 'nothing approved');
    },
  },
  {
    name: '#4679: a second push before re-review supersedes the fix round; a late approval of the old head approves nothing',
    async run(host) {
      const s = await new Delivery(host).open();
      await s.ownerPushed('H1');
      await s.verdict('request_changes');
      const fix = await s.startFix();
      applied(await s.fixEnded(fix, { localHeadSha: 'H2', commitCount: 1, live: s.live('H2'), proof: { liveContainsLocal: true } }), 'AWAITING_REVIEW', 'fix ended');
      const fixRound = await s.latestRound();
      applied(await s.push('H3'), 'AWAITING_REVIEW', 'second push');
      const v = await s.view();
      eq(pick(v.rounds.find((r) => r.id === fixRound.id)!, ['round', 'headSha', 'status']), { round: 2, headSha: 'H2', status: 'superseded' }, 'fix round superseded');
      eq(pick(v.rounds.at(-1)!, ['round', 'headSha', 'kind', 'status']), { round: 3, headSha: 'H3', kind: 'delta', status: 'queued' }, 'round at H3');
      eq(deriveDeliveryView({ view: v })!.state, 'AWAITING_REVIEW', 'no longer reads as changes requested');
      const version = v.delivery!.version;
      notApplied(await s.verdict('approve', fixRound.id, 'H2'), 'stale', 'round_superseded', 'late approval');
      const after = await s.view();
      eq(after.rounds.find((r) => r.id === fixRound.id)!.verdict, 'approve', 'kept for audit');
      eq(pick(after.delivery!, ['state', 'approvedHeads', 'version']), { state: 'AWAITING_REVIEW', approvedHeads: [], version }, 'approves nothing');
    },
  },

  // ── The outbox drain ──────────────────────────────────────────────────────
  {
    name: 'drain: every due effect runs once and is acked; a second drain finds nothing',
    async run(host) {
      const s = await new Delivery(host).open();
      await s.ownerPushed('H1');
      const ran: string[] = [];
      const first = await drainEffects(host.store, { handlers: recordingHandlers(ran), deliveryId: s.deliveryId });
      ok(first.claimed > 0 && ran.includes('dispatch_review'), `dispatch_review ran: ${ran}`);
      eq({ done: first.done, failed: first.failed, lost: first.lost }, { done: first.claimed - first.skipped, failed: 0, lost: 0 }, 'all settled');
      const due = (await host.effects(s.deliveryId)).filter((e) => ran.includes(e.kind));
      ok(due.every((e) => e.status === 'done' && e.attemptCount === 1), 'each ran once and is done');
      eq((await drainEffects(host.store, { handlers: recordingHandlers([]), deliveryId: s.deliveryId })).claimed, 0, 'nothing due again');
    },
  },
  {
    name: 'drain: a failed handler backs off with its attempt counted; the row is not due again yet',
    async run(host) {
      const s = await new Delivery(host).open();
      await s.ownerPushed('H1');
      const first = await drainEffects(host.store, {
        handlers: recordingHandlers([], { dispatch_review: async () => { throw new Error('gh 502'); } }), deliveryId: s.deliveryId,
      });
      eq(first.failed, 1, 'one failure');
      const row = (await host.effects(s.deliveryId)).find((e) => e.kind === 'dispatch_review')!;
      eq(pick(row, ['status', 'attemptCount', 'lastError']), { status: 'pending', attemptCount: 1, lastError: 'gh 502' }, 'backed off');
      const ran: string[] = [];
      await drainEffects(host.store, { handlers: recordingHandlers(ran), deliveryId: s.deliveryId });
      ok(!ran.includes('dispatch_review'), 'not due during its backoff');
    },
  },
  {
    name: 'drain §10.4: a gated effect whose transition no longer describes the delivery is skipped:superseded',
    async run(host) {
      const s = await new Delivery(host).open();
      await s.ownerPushed('H1');
      applied(await s.verdict('request_changes'), 'CHANGES_REQUESTED', 'moved on before the drain');
      const ran: string[] = [];
      await drainEffects(host.store, { handlers: recordingHandlers(ran), deliveryId: s.deliveryId });
      ok(!ran.includes('dispatch_review'), 'review dispatch not run');
      eq((await host.effects(s.deliveryId)).find((e) => e.kind === 'dispatch_review')!.outcome, 'skipped:superseded', 'superseded');
    },
  },
  {
    name: 'drain §14: a switched-off delivery is released by the drain, a kernel-only effect never runs, and later commands are legacy_owns',
    async run(host) {
      const s = await (await new Delivery(host).open()).approvedAt('H1');
      applied(await s.land('H1'), 'LANDING', 'landing');
      await host.setKernelEnabled(s.workspaceId, false);
      const ran: string[] = [];
      await drainEffects(host.store, { handlers: recordingHandlers(ran), deliveryId: s.deliveryId });
      ok(!ran.includes('merge_call'), 'the merge never ran');
      eq((await host.effects(s.deliveryId)).find((e) => e.kind === 'merge_call')!.outcome, 'skipped:legacy_owns', 'merge skipped');
      eq((await s.d()).authority, 'legacy', 'released');
      notApplied(await s.merged('H1'), 'rejected', 'legacy_owns', 'legacy decides now');
      await host.setKernelEnabled(s.workspaceId, true);
      eq((await s.d()).authority, 'legacy', 'the release is sticky');
    },
  },

  // ── The landing lane ──────────────────────────────────────────────────────
  {
    name: 'lane: one holder per repo + base while it is in the refresh window; released when it leaves it',
    async run(host) {
      const a = await (await new Delivery(host, 11).open()).approvedAt('A1');
      const b = new Delivery(host, 12);
      await b.open();
      const k = { repoFullName: a.repo, baseRef: 'dev' };
      eq(await acquireLaneOn(host.store, { ...k, deliveryId: a.deliveryId, headSha: 'A1' }), { acquired: true }, 'A takes the lane');
      eq(await acquireLaneOn(host.store, { ...k, deliveryId: a.deliveryId, headSha: 'A1' }), { acquired: true }, 'A renews it');
      eq(await acquireLaneOn(host.store, { ...k, deliveryId: b.deliveryId, headSha: 'B1' }), { acquired: false, holder: { deliveryId: a.deliveryId, prNumber: 11 } }, 'B waits on A');
      eq(await settleLanesOn(host.store, a.deliveryId), [], 'A still holds while approved');
      applied(await a.merged('A1'), 'MERGED', 'A merges');
      eq(await settleLanesOn(host.store, a.deliveryId), [], 'released, nobody parked');
      eq(await host.store.laneHolder(k), null, 'nobody holds it');
      eq(await acquireLaneOn(host.store, { ...k, deliveryId: b.deliveryId, headSha: 'B1' }), { acquired: true }, 'B takes the free lane');
    },
  },

  // ── Decide (AC-27, AC-28, AC-29) ──────────────────────────────────────────
  {
    name: 'AC-27: a decider\'s answer is recorded as a fact with its id before the transition that uses it, which links it',
    async run(host) {
      const s = await new Delivery(host).open();
      const decide: Decide = { id: 'test-decider@1', decide: async () => ({ verdict: 'no_visual_impact', confidence: 0.95, reason: 'docs only' }) };
      const subject = { workspaceId: s.workspaceId, deliveryId: s.deliveryId, repoFullName: s.repo, prNumber: s.prNumber, source: 'conformance' };
      const d = await decideAndRecord(host.store, subject, VISUAL_IMPACT_POINT, { headSha: 'H1' }, { decide });
      eq(pick(d.fact, ['point', 'deciderId', 'verdict', 'confidence', 'source', 'fallback']), { point: 'visual_impact', deciderId: 'test-decider@1', verdict: 'no_visual_impact', confidence: 0.95, source: 'decider', fallback: null }, 'the answer');
      eq(d.replayed, false, 'decided now');
      const key = `decide:visual_impact:${s.deliveryId}:H1`;
      const before = await host.store.findFact(s.workspaceId, key);
      eq(before && pick(before, ['id', 'appliedTransitionId']), { id: d.factId, appliedTransitionId: null }, 'recorded before any transition');
      const r = await s.submit({ type: 'AttemptEnded', actor: 'runner', workerId: 'wk-d', taskId: s.ownerTaskId, outcome: 'success', localHeadSha: 'H1', commitCount: 1, live: s.live('H1') }, d.factId);
      applied(r, 'AWAITING_REVIEW', 'the transition that uses it');
      eq((await host.store.findFact(s.workspaceId, key))!.appliedTransitionId, (r as Extract<CommandResult, { result: 'applied' }>).transitionId, 'linked by that transition');
    },
  },
  {
    name: 'AC-28: a recorded decision is replayed from its fact and no decider is called',
    async run(host) {
      const s = await new Delivery(host).open();
      const subject = { workspaceId: s.workspaceId, deliveryId: s.deliveryId, source: 'conformance' };
      const first = await decideAndRecord(host.store, subject, VISUAL_IMPACT_POINT, { headSha: 'H1' }, { decide: { id: 'd@1', decide: async () => ({ verdict: 'no_visual_impact', confidence: 0.9, reason: 'r' }) } });
      const replay = await decideAndRecord(host.store, subject, VISUAL_IMPACT_POINT, { headSha: 'H1' }, { decide: neverAsked });
      eq({ replayed: replay.replayed, factId: replay.factId, verdict: replay.fact.verdict, deciderId: replay.fact.deciderId }, { replayed: true, factId: first.factId, verdict: 'no_visual_impact', deciderId: 'd@1' }, 'the recorded answer');
      const pure = await decideAt(VISUAL_IMPACT_POINT, { headSha: 'H1' }, { decide: neverAsked, recorded: first.fact });
      eq({ replayed: pure.replayed, verdict: pure.fact.verdict }, { replayed: true, verdict: 'no_visual_impact' }, 'decideAt replays a recorded fact');
    },
  },
  {
    name: 'AC-29: no decider, an error, a timeout, no answer or an unusable answer takes the package default, records why, and the delivery still progresses',
    async run(host) {
      const s = await new Delivery(host).open();
      const subject = { workspaceId: s.workspaceId, deliveryId: s.deliveryId, source: 'conformance' };
      const cases: Array<[string, Decide | undefined, string]> = [
        ['N0', undefined, 'no_decider'],
        ['N1', { id: 'err', decide: async () => { throw new Error('model 500'); } }, 'error'],
        ['N2', { id: 'slow', decide: () => new Promise(() => {}) }, 'timeout'],
        ['N3', { id: 'mute', decide: async () => null }, 'no_answer'],
        ['N4', { id: 'odd', decide: async () => ({ verdict: 'ship_it', confidence: 1, reason: 'x' }) }, 'invalid_answer'],
        ['N5', { id: 'unsure', decide: async () => ({ verdict: 'no_visual_impact', confidence: 0.2, reason: 'x' }) }, 'low_confidence'],
      ];
      for (const [head, decide, fallback] of cases) {
        const d = await decideAndRecord(host.store, subject, VISUAL_IMPACT_POINT, { headSha: head }, { decide, timeoutMs: 20 });
        eq(pick(d.fact, ['verdict', 'source', 'fallback', 'confidence']), { verdict: 'review_required', source: 'default', fallback, confidence: null }, `default for ${fallback}`);
        eq((await host.store.findFact(s.workspaceId, `decide:visual_impact:${s.deliveryId}:${head}`))?.payload.fallback, fallback, `fallback recorded for ${fallback}`);
      }
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'the delivery still progresses');
    },
  },
  {
    name: 'a decider\'s answer alone never opens the landing gate',
    async run(host) {
      const s = await new Delivery(host).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'under review');
      const yes: Decide = { id: 'eager', decide: async () => ({ verdict: 'no_visual_impact', confidence: 1, reason: 'land it' }) };
      const d = await decideAndRecord(host.store, { workspaceId: s.workspaceId, deliveryId: s.deliveryId, source: 'conformance' }, VISUAL_IMPACT_POINT, { headSha: 'H1' }, { decide: yes });
      eq(d.fact.source, 'decider', 'the decider answered');
      notApplied(await s.submit({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1', live: s.live('H1'), rails: { passed: true } }, d.factId), 'rejected', 'state_not_allowed', 'no review verdict, no landing');
      eq(await s.count('merge_call'), 0, 'no merge owed');
      eq((await s.d()).state, 'AWAITING_REVIEW', 'still under review');
    },
  },
];

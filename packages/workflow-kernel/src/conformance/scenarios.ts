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
import { decideAndRecord, decideAt, decisionFactKey, invalidRecordFactKey, VISUAL_IMPACT_POINT } from '../decide';
import { drainEffects, EFFECT_MAX_ATTEMPTS, type EffectHandlers } from '../effects';
import { BLOCKED_ON_TRUNK_SUMMARY } from '../handlers/trunk';
import { ciEvidenceFactKey, handOffToLegacyOn, kernelEffectHandlers } from '../handlers/index';
import { acquireLaneOn, settleLanesOn } from '../landing-lane';
import {
  FakeGithub, RecordingConflicts, RecordingEscalate, RecordingEvidence, RecordingHandOff, RecordingIngest, RecordingLifecycle, RecordingNotify,
  RecordingRails, RecordingReviews, RecordingTrunk, RecordingWork, type WorkAnswer,
} from '../memory/ports';
import { NO_ROLE, type ClaimedEffect, type CommandResult, type Decide, type DeliveryRef, type KernelPorts, type Policy, type Store } from '../ports';
import { deriveDeliveryView } from '../projections';
import type { CompositionAttestation, ConstituentEvidence, DeliverySnapshot, KernelView } from '../types';

/** What a host gives the scenarios: its store, ids it accepts, a way to seed owners, and read-back of the outbox. */
export interface ConformanceHost {
  store: Store;
  /** The host's per-workspace knobs; the drain reads the kill switch here. */
  policy: Policy;
  /** Ids the host's store accepts for rounds, attempts and tasks (uuids for Postgres). */
  newId(): string;
  /**
   * A task the host's store can reference (a review round's reviewer): a seeded
   * row where the store keeps a foreign key to tasks. Absent = `newId()`.
   */
  newTaskId?(workspaceId: string): Promise<string>;
  /** A fresh workspace + owner task the store will accept a delivery for. */
  seedOwner(): Promise<{ workspaceId: string; ownerTaskId: string }>;
  /** A repo name no other scenario (or test sharing the store) uses: lanes are global per repo + base. */
  uniqueRepo(): string;
  /** The outbox rows of one delivery. */
  effects(deliveryId: string): Promise<Array<{
    kind: EffectKind; payload: Record<string, unknown>; status: string; outcome: string | null; attemptCount: number; lastError: string | null;
    dedupeKey: string; transitionId: string;
  }>>;
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

  async open(o0: { maxRounds?: number } = {}): Promise<this> {
    ({ workspaceId: this.workspaceId, ownerTaskId: this.ownerTaskId } = await this.host.seedOwner());
    this.ref = { workspaceId: this.workspaceId, ownerTaskId: this.ownerTaskId };
    const o = await applyCommandOn(this.host.store, { type: 'DeliveryOpened', actor: 'runner', workspaceId: this.workspaceId, ownerTaskId: this.ownerTaskId, requiresPr: true, ...(o0.maxRounds ? { maxRounds: o0.maxRounds } : {}) }, { newId: () => this.host.newId() });
    applied(o, 'WORKING', 'DeliveryOpened');
    this.deliveryId = (o as Extract<CommandResult, { result: 'applied' }>).deliveryId;
    this.ref = { deliveryId: this.deliveryId };
    applied(await this.submit({ type: 'PrBound', actor: 'runner', repoFullName: this.repo, prNumber: this.prNumber, live: this.live('H1') }), 'WORKING', 'PrBound');
    return this;
  }
  ownerPushed(head = 'H1'): Promise<CommandResult> {
    return this.submit({ type: 'AttemptEnded', actor: 'runner', workerId: `wk${++this.worker}`, taskId: this.ownerTaskId, outcome: 'success', localHeadSha: head, commitCount: 1, live: this.live(head) });
  }
  async verdict(verdict: 'approve' | 'request_changes' | 'escalate', roundId?: string, headBound?: string): Promise<CommandResult> {
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
  /** T10: CI failed on `head` (`maxAttempts` 0 = CI retries off). */
  ciRed(head: string, o: Partial<Extract<Command, { type: 'CiFailedObserved' }>> = {}): Promise<CommandResult> {
    return this.submit({ type: 'CiFailedObserved', actor: 'webhook', headSha: head, signature: 'ci:unit', maxAttempts: 3, ...o });
  }
  /** T25: the delivery's head fails what the base fails. */
  trunkRed(incidentId: string, signature: string, head = 'H1'): Promise<CommandResult> {
    return this.submit({ type: 'TrunkRedObserved', actor: 'kernel', incidentId, signature, headSha: head, thresholdMet: true });
  }
  land(head: string): Promise<CommandResult> {
    // No rail reading from the door: the merge effect reads the rails itself (§4).
    return this.submit({ type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: head, live: this.live(head) });
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
    'publish_landing_status', 'dispatch_external_merge_fix',
  ];
  const out: EffectHandlers = {};
  for (const k of kinds) out[k] = async () => { ran.push(k); return { outcome: 'ok' }; };
  return { ...out, ...override };
}

// ── The package's effect handlers, on fake ports ────────────────────────────

interface FakePorts {
  ports: KernelPorts; github: FakeGithub; lifecycle: RecordingLifecycle; notify: RecordingNotify; ingest: RecordingIngest;
  work: RecordingWork; trunk: RecordingTrunk; escalate: RecordingEscalate; evidence: RecordingEvidence;
  reviews: RecordingReviews; conflicts: RecordingConflicts; handOff: RecordingHandOff; rails: RecordingRails;
}

/** The handlers' ports over the host's store, with a fake GitHub and recording Work-side ports. */
function fakePorts(host: ConformanceHost, o: {
  lifecycle?: RecordingLifecycle; ingest?: RecordingIngest; notify?: RecordingNotify; trunk?: RecordingTrunk; escalate?: RecordingEscalate;
  evidence?: RecordingEvidence; work?: Record<string, WorkAnswer>; omit?: Array<keyof KernelPorts>;
} = {}): FakePorts {
  const github = new FakeGithub();
  const lifecycle = o.lifecycle ?? new RecordingLifecycle();
  const notify = o.notify ?? new RecordingNotify();
  const ingest = o.ingest ?? new RecordingIngest();
  const work = new RecordingWork((ws) => (host.newTaskId ? host.newTaskId(ws) : host.newId()), o.work ?? {});
  const trunk = o.trunk ?? new RecordingTrunk();
  const escalate = o.escalate ?? new RecordingEscalate();
  const evidence = o.evidence ?? new RecordingEvidence();
  const reviews = new RecordingReviews();
  const conflicts = new RecordingConflicts();
  const handOff = new RecordingHandOff();
  const rails = new RecordingRails();
  const ports: KernelPorts = {
    store: host.store, github, clock: { now: () => new Date().toISOString() }, newId: () => host.newId(), policy: host.policy,
    notify, ingest, lifecycle, work, trunk, escalate, evidence, reviews, conflicts, handOff, rails,
  };
  for (const k of o.omit ?? []) delete ports[k];
  return { ports, github, lifecycle, notify, ingest, work, trunk, escalate, evidence, reviews, conflicts, handOff, rails };
}

/** One of the delivery's outbox rows as a drain would hand it over, to run a handler directly (past the drain's own guards). */
async function direct(host: ConformanceHost, s: Delivery, kind: EffectKind, payload?: Record<string, unknown>): Promise<ClaimedEffect> {
  const rows = await host.effects(s.deliveryId);
  const row = rows.filter((e) => e.kind === kind).at(-1);
  // The row's own transition and key when it has one (a follow-up is keyed off them), else the latest transition's.
  const transitionId = row?.transitionId ?? rows.at(-1)?.transitionId ?? 'direct';
  return {
    id: 'direct', deliveryId: s.deliveryId, transitionId, kind, dedupeKey: row?.dedupeKey ?? `direct:${kind}`,
    payload: payload ?? row?.payload ?? {}, attemptCount: 1, delivery: null, transition: null,
  };
}

/** Drain one delivery until nothing is due: the package's handlers over `ports`, every other kind recorded. */
async function drainKernel(host: ConformanceHost, s: Delivery, ports: KernelPorts): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const r = await drainEffects(host.store, { policy: host.policy, handlers: { ...recordingHandlers([]), ...kernelEffectHandlers(ports) }, deliveryId: s.deliveryId, log: { log: () => {}, error: () => {} } });
    if (r.claimed === 0) return;
  }
}

async function outcomesOf(host: ConformanceHost, s: Delivery, kind: EffectKind): Promise<Array<string | null>> {
  return (await host.effects(s.deliveryId)).filter((e) => e.kind === kind).map((e) => e.outcome);
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
    name: 'AC-11 (the kernel\'s half): one landing request submitted twice at once applies one transition and owes one merge; the other answers duplicate',
    async run(host) {
      const s = await new Delivery(host).open();
      await s.approvedAt('H1');
      const v = (await s.d()).version;
      const [a, b] = await Promise.all([s.land('H1'), s.land('H1')]);
      eq([a.result, b.result].sort(), ['applied', 'duplicate'], 'one applied, one duplicate');
      eq((await s.d()).version, v + 1, 'one version');
      eq((await host.transitions(s.deliveryId)).filter((t) => t.command === 'LandingRequested').length, 1, 'one LandingRequested');
      eq(await s.count('merge_call'), 1, 'one merge owed');
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
      const first = await drainEffects(host.store, { policy: host.policy, handlers: recordingHandlers(ran), deliveryId: s.deliveryId });
      ok(first.claimed > 0 && ran.includes('dispatch_review'), `dispatch_review ran: ${ran}`);
      eq({ done: first.done, failed: first.failed, lost: first.lost }, { done: first.claimed - first.skipped, failed: 0, lost: 0 }, 'all settled');
      const due = (await host.effects(s.deliveryId)).filter((e) => ran.includes(e.kind));
      ok(due.every((e) => e.status === 'done' && e.attemptCount === 1), 'each ran once and is done');
      eq((await drainEffects(host.store, { policy: host.policy, handlers: recordingHandlers([]), deliveryId: s.deliveryId })).claimed, 0, 'nothing due again');
    },
  },
  {
    name: 'drain: a failed handler backs off with its attempt counted; the row is not due again yet',
    async run(host) {
      const s = await new Delivery(host).open();
      await s.ownerPushed('H1');
      const first = await drainEffects(host.store, {
        policy: host.policy, handlers: recordingHandlers([], { dispatch_review: async () => { throw new Error('gh 502'); } }), deliveryId: s.deliveryId,
      });
      eq(first.failed, 1, 'one failure');
      const row = (await host.effects(s.deliveryId)).find((e) => e.kind === 'dispatch_review')!;
      eq(pick(row, ['status', 'attemptCount', 'lastError']), { status: 'pending', attemptCount: 1, lastError: 'gh 502' }, 'backed off');
      const ran: string[] = [];
      await drainEffects(host.store, { policy: host.policy, handlers: recordingHandlers(ran), deliveryId: s.deliveryId });
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
      await drainEffects(host.store, { policy: host.policy, handlers: recordingHandlers(ran), deliveryId: s.deliveryId });
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
      await drainEffects(host.store, { policy: host.policy, handlers: recordingHandlers(ran), deliveryId: s.deliveryId });
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
  // ── The package's effect handlers (§2), on fake GitHub / Ingest / Lifecycle / Notify ──
  {
    name: 'handlers/landing: the merge is pinned to the approved head, a live read turns it into the merged fact, and the post-merge work runs once',
    async run(host) {
      const s = await (await new Delivery(host).open()).approvedAt('H1');
      applied(await s.land('H1'), 'LANDING', 'landing');
      const f = fakePorts(host, { ingest: new RecordingIngest(async (fact) => ({ result: fact.kind === 'pr_closed' ? (await s.merged('H1')).result : 'ignored' })) });
      f.github.setPr(s.repo, s.prNumber, s.live('H1'));
      await drainKernel(host, s, f.ports);
      eq(f.github.merges, [{ repoFullName: s.repo, prNumber: s.prNumber, headSha: 'H1', method: 'squash' }], 'one merge call, pinned to H1');
      eq(f.rails.calls.map((x) => x.headSha), ['H1'], 'the rails were read at merge time, at H1');
      eq(await outcomesOf(host, s, 'merge_call'), ['ok:merged:applied'], 'merge answer applied as T16');
      eq(await outcomesOf(host, s, 'verify_merge'), ['ok:merged:applied'], 'verified by the live read');
      eq(f.ingest.facts.map((x) => pick(x, ['kind', 'source', 'prNumber'])), [{ kind: 'pr_closed', source: 'effect:verify_merge', prNumber: s.prNumber }], 'the merged fact goes through the funnel');
      eq((await s.d()).state, 'MERGED', 'merged');
      eq(f.lifecycle.ops().sort(), ['finalizeMerge', 'merged'], 'post-merge work, once');
      eq({ emit: await outcomesOf(host, s, 'emit_pr_merged'), finalize: await outcomesOf(host, s, 'finalize_mission_pr') }, { emit: ['ok'], finalize: ['ok'] }, 'post-merge effects done');
      await drainKernel(host, s, f.ports);
      eq(f.lifecycle.calls.length, 2, 'a second drain runs nothing again');
    },
  },
  {
    name: 'handlers/landing: an indeterminate answer at an open, unmoved head is not_merged; a moved head goes to the funnel; a behind answer is a repair',
    async run(host) {
      const a = await (await new Delivery(host, 21).open()).approvedAt('H1');
      applied(await a.land('H1'), 'LANDING', 'landing a');
      const fa = fakePorts(host);
      fa.github.mergeAnswer = { outcome: 'indeterminate', detail: 'socket hang up' };
      fa.github.setPr(a.repo, a.prNumber, a.live('H1'));
      await drainKernel(host, a, fa.ports);
      eq({ merge: await outcomesOf(host, a, 'merge_call'), verify: await outcomesOf(host, a, 'verify_merge') }, { merge: ['ok:indeterminate:applied'], verify: ['ok:not_merged:applied'] }, 'verified as not merged');
      eq((await a.d()).state, 'APPROVED', 'the approval still stands');

      const b = await (await new Delivery(host, 22).open()).approvedAt('H1');
      applied(await b.land('H1'), 'LANDING', 'landing b');
      const fb = fakePorts(host);
      fb.github.mergeAnswer = { outcome: 'indeterminate' };
      fb.github.setPr(b.repo, b.prNumber, b.live('H1'));
      // The head moves under the merge call (a push GitHub took first): the verify read sees it.
      fb.github.onMerge = () => fb.github.setPr(b.repo, b.prNumber, b.live('H2'));
      await drainKernel(host, b, fb.ports);
      eq(await outcomesOf(host, b, 'verify_merge'), ['ok:head_moved'], 'a moved head is observed');
      eq(fb.ingest.facts.map((x) => x.kind), ['head_observed'], 'through the funnel, from the same read');

      const c = await (await new Delivery(host, 23).open()).approvedAt('H1');
      applied(await c.land('H1'), 'LANDING', 'landing c');
      const fc = fakePorts(host);
      fc.github.mergeAnswer = { outcome: 'behind', detail: 'Head branch is out of date' };
      fc.github.setPr(c.repo, c.prNumber, c.live('H1'));
      await drainKernel(host, c, fc.ports);
      eq(await outcomesOf(host, c, 'merge_call'), ['ok:behind:applied'], 'behind applied as T16');
      eq(await c.count('verify_merge'), 0, 'nothing to verify');
      ok((await c.d()).state !== 'LANDING', 'left LANDING for the repair');
    },
  },
  {
    name: 'handlers/landing: a merge owed for a head that is no longer current never calls GitHub',
    async run(host) {
      const s = await (await new Delivery(host).open()).approvedAt('H1');
      applied(await s.land('H1'), 'LANDING', 'landing');
      applied(await s.push('H2'), 'AWAITING_REVIEW', 'head moved before the merge ran');
      const f = fakePorts(host);
      await drainKernel(host, s, f.ports);
      eq(f.github.merges, [], 'no merge call');
      const outs = await outcomesOf(host, s, 'merge_call');
      ok(outs.length > 0 && outs.every((o) => String(o).startsWith('skipped:')), `skipped: ${outs}`);
    },
  },
  {
    name: 'handlers/landing: merge_call itself refuses a head that is not the landing one, and a delivery that left LANDING, without calling GitHub',
    async run(host) {
      const s = await (await new Delivery(host, 24).open()).approvedAt('H1');
      applied(await s.land('H1'), 'LANDING', 'landing');
      const f = fakePorts(host);
      const h = kernelEffectHandlers(f.ports);
      eq(await h.merge_call!(await direct(host, s, 'merge_call', { headSha: 'H0' })), { outcome: 'skipped:state_LANDING' }, 'not the head that is landing');
      applied(await s.push('H2'), 'AWAITING_REVIEW', 'head moved');
      eq(await h.merge_call!(await direct(host, s, 'merge_call', { headSha: 'H1' })), { outcome: 'skipped:state_AWAITING_REVIEW' }, 'no longer landing');
      eq(f.github.merges, [], 'no merge call');
    },
  },
  // ── S3b: one landing authority (workflow-kernel-library.md §4) ─────────────
  {
    name: 'AC-14: approved at A, B pushed before the merge effect runs: the effect re-reads, records B and does not merge',
    async run(host) {
      const s = await (await new Delivery(host, 25).open()).approvedAt('H1');
      applied(await s.land('H1'), 'LANDING', 'landing at H1');
      // B is on GitHub; its webhook has not arrived, so the delivery still says LANDING at A.
      const f = fakePorts(host, { ingest: new RecordingIngest(async (fact) => ({ result: fact.kind === 'head_observed' ? (await s.push('H2')).result : 'ignored' })) });
      f.github.setPr(s.repo, s.prNumber, s.live('H2'));
      await drainKernel(host, s, f.ports);
      eq(f.github.merges, [], 'no merge call');
      eq(f.rails.calls, [], 'no rail read for a head that is not the one landing');
      eq(await outcomesOf(host, s, 'merge_call'), ['skipped:head_moved:applied'], 'the effect re-read and recorded B');
      eq(f.ingest.facts.map((x) => pick(x, ['kind', 'source'])), [{ kind: 'head_observed', source: 'effect:merge_call' }], 'B through the funnel, from the same read');
      const d = await s.d();
      eq({ state: d.state, head: d.currentHeadSha, approved: d.approvedHeads.includes('H2') }, { state: 'AWAITING_REVIEW', head: 'H2', approved: false }, 'B is owed its own review');
    },
  },
  {
    name: 'gate at merge time: the door says nothing about rails; a rail that refuses when the effect runs stops the merge and the approval stands',
    async run(host) {
      const s = await (await new Delivery(host, 26).open()).approvedAt('H1');
      applied(await s.land('H1'), 'LANDING', 'landing with no rail reading from the door');
      const f = fakePorts(host);
      f.github.setPr(s.repo, s.prNumber, s.live('H1'));
      f.rails.reading = { passed: false, redCi: true, reasons: ['CI red on H1: unit'] };
      await drainKernel(host, s, f.ports);
      eq(f.github.merges, [], 'no merge call');
      eq(f.rails.calls.map((x) => pick(x, ['headSha', 'door'])), [{ headSha: 'H1', door: 'auto' }], 'the rails were read once, at the landing head');
      eq(await outcomesOf(host, s, 'merge_call'), ['ok:gate_refused:rails:applied'], 'refused by the gate');
      eq(pick(await s.d(), ['state', 'approvedHeads']), { state: 'APPROVED', approvedHeads: ['H1'] }, 'the approval stands');
      f.rails.reading = { passed: true, reasons: [] };
      applied(await s.land('H1'), 'LANDING', 'landing again once the rail passes');
      await drainKernel(host, s, f.ports);
      eq(f.github.merges.map((m) => m.headSha), ['H1'], 'merged once, pinned to H1');
    },
  },
  {
    name: 'gate at merge time: a person\'s verdict override passes a missing review, never a refusing rail',
    async run(host) {
      const ask = async (s: Delivery) => {
        await s.ownerPushed('H1');
        applied(await s.verdict('request_changes'), 'CHANGES_REQUESTED', 'changes asked');
        applied(await s.submit({ type: 'LandingRequested', actor: 'human:owner', door: 'dashboard_override', headSha: 'H1', live: s.live('H1'), override: { reason: 'owner call' } }), 'LANDING', 'override landing');
      };
      const a = await new Delivery(host, 27).open();
      await ask(a);
      const fa = fakePorts(host);
      fa.github.setPr(a.repo, a.prNumber, a.live('H1'));
      fa.rails.reading = { passed: false, denyPaths: true, reasons: ['touches protected path (infra/x)'] };
      await drainKernel(host, a, fa.ports);
      eq(fa.github.merges, [], 'a refusing rail is never overridden');
      eq(pick(await a.d(), ['state', 'stateReason']), { state: 'ESCALATED', stateReason: 'landing_needs_human' }, 'no approval to fall back on: a person looks again');

      const b = await new Delivery(host, 28).open();
      await ask(b);
      const fb = fakePorts(host);
      fb.github.setPr(b.repo, b.prNumber, b.live('H1'));
      await drainKernel(host, b, fb.ports);
      eq(fb.github.merges.map((m) => m.headSha), ['H1'], 'the person\'s override passes the open verdict');
      eq(fb.rails.calls.map((x) => (x.override as { verdict?: boolean } | null)?.verdict ?? null), [true], 'the rails were told it is an override');
    },
  },
  {
    name: 'gate at merge time: a lasting rail (a migration, a protected path) is a person\'s, named on buildd/landing; a person\'s own merge is held only to a person\'s rails',
    async run(host) {
      const s = await (await new Delivery(host, 37).open()).approvedAt('H1');
      applied(await s.land('H1'), 'LANDING', 'an automatic landing');
      const f = fakePorts(host);
      f.github.setPr(s.repo, s.prNumber, s.live('H1'));
      f.rails.reading = { passed: false, lasting: true, reasons: ['destructive migration: DROP COLUMN'] };
      f.rails.personReading = { passed: true, reasons: [] };
      await drainKernel(host, s, f.ports);
      eq(f.github.merges, [], 'the automatic door does not merge it');
      eq(await outcomesOf(host, s, 'merge_call'), ['ok:gate_refused:rails:lasting:applied'], 'refused as lasting');
      eq(pick(await s.d(), ['state', 'stateReason']), { state: 'ESCALATED', stateReason: 'landing_needs_human' }, 'a person is asked, not the sweep');
      const last = f.github.written.filter((w) => w.op === 'publishStatus').at(-1)!;
      eq(last.state, 'failure', 'buildd/landing says no');
      ok(String(last.description).includes('destructive migration'), `names the rail: ${String(last.description)}`);
      ok((await s.count('notify')) >= 1, 'a person is notified');
      // The person merges it ("Merge anyway"): their door is held to their rails, and it lands.
      applied(await s.submit({ type: 'LandingRequested', actor: 'human:owner', door: 'dashboard', headSha: 'H1', live: s.live('H1'), override: { reason: 'migration reviewed by the owner', kinds: ['verdict'] } }), 'LANDING', 'the person\'s landing');
      await drainKernel(host, s, f.ports);
      eq(f.rails.calls.map((c) => c.person), [false, true], 'the second read was a person\'s');
      eq(f.github.merges.map((m) => m.headSha), ['H1'], 'the person merged it');

      // A rail that clears by waiting (pending CI) leaves the approval standing.
      const w = await (await new Delivery(host, 38).open()).approvedAt('H1');
      applied(await w.land('H1'), 'LANDING', 'landing');
      const fw = fakePorts(host);
      fw.github.setPr(w.repo, w.prNumber, w.live('H1'));
      fw.rails.reading = { passed: false, reasons: ['CI checks still pending or failed: unit (in_progress)'] };
      await drainKernel(host, w, fw.ports);
      eq((await w.d()).state, 'APPROVED', 'it waits');
    },
  },
  {
    name: 'gate at merge time: an agent under a person\'s freshness grant is not a person: a destructive migration still escalates',
    async run(host) {
      const s = await (await new Delivery(host, 41).open()).approvedAt('H1');
      applied(await s.land('H1'), 'LANDING', 'an automatic landing');
      const f = fakePorts(host);
      f.github.setPr(s.repo, s.prNumber, s.live('H1'));
      f.rails.reading = { passed: false, lasting: true, reasons: ['destructive migration: DROP COLUMN'] };
      f.rails.personReading = { passed: true, reasons: [] };
      await drainKernel(host, s, f.ports);
      eq((await s.d()).stateReason, 'landing_needs_human', 'escalated on the migration');
      // merge_pr with force (an admin token) and a freshness-only grant a person put on the agent's task.
      applied(await s.submit({ type: 'LandingRequested', actor: 'agent:w1', door: 'merge_pr_force', headSha: 'H1', live: s.live('H1'), override: { reason: 'base keeps moving', kinds: ['freshness'], grantedBy: 'human:owner' } }), 'LANDING', 'the agent\'s landing');
      await drainKernel(host, s, f.ports);
      eq(f.rails.calls.map((c) => c.person), [false, false], 'the agent was never read as a person');
      eq(f.github.merges, [], 'the destructive migration did not merge');
      eq(pick(await s.d(), ['state', 'stateReason']), { state: 'ESCALATED', stateReason: 'landing_needs_human' }, 'still a person\'s');
    },
  },
  {
    name: 'deploy skew: a merge_call queued by the reducer before S3b (no fromState) merges as it would have, after the fresh read',
    async run(host) {
      const s = await (await new Delivery(host, 42).open()).approvedAt('H1');
      applied(await s.land('H1'), 'LANDING', 'landing');
      const f = fakePorts(host);
      f.github.setPr(s.repo, s.prNumber, s.live('H1'));
      f.rails.reading = { passed: false, lasting: true, reasons: ['would refuse'] };
      const row = (await host.effects(s.deliveryId)).find((e) => e.kind === 'merge_call')!;
      const { fromState: _f, ...oldPayload } = row.payload;
      const out = await kernelEffectHandlers(f.ports).merge_call!({ ...(await direct(host, s, 'merge_call')), payload: oldPayload });
      eq(out, { outcome: 'ok:merged:applied:pre_gate_row' }, 'merged without the gate it was never shaped for');
      eq(f.rails.calls, [], 'no rails asked');
      eq(f.github.merges.map((m) => m.headSha), ['H1'], 'one pinned merge');
      // Still behind the fresh read: an old row for a head that moved merges nothing.
      const m = await (await new Delivery(host, 43).open()).approvedAt('H1');
      applied(await m.land('H1'), 'LANDING', 'landing');
      const fm = fakePorts(host);
      fm.github.setPr(m.repo, m.prNumber, m.live('H2'));
      const mrow = (await host.effects(m.deliveryId)).find((e) => e.kind === 'merge_call')!;
      const { fromState: _g, ...oldM } = mrow.payload;
      const outM = await kernelEffectHandlers(fm.ports).merge_call!({ ...(await direct(host, m, 'merge_call')), payload: oldM });
      ok(String(outM?.outcome).startsWith('skipped:head_moved'), `head moved: ${outM?.outcome}`);
      eq(fm.github.merges, [], 'nothing merged');
    },
  },
  {
    name: 'gate at merge time: a base retarget under the call is recorded like a moved head, and nothing merges',
    async run(host) {
      const s = await (await new Delivery(host, 39).open()).approvedAt('H1');
      applied(await s.land('H1'), 'LANDING', 'landing');
      const f = fakePorts(host, { ingest: new RecordingIngest(async (fact) => ({ result: fact.kind === 'base_changed' ? (await s.submit({ type: 'BaseChanged', actor: 'webhook', live: s.live('H1', { baseRef: 'release' }) })).result : 'ignored' })) });
      f.github.setPr(s.repo, s.prNumber, s.live('H1', { baseRef: 'release' }));
      await drainKernel(host, s, f.ports);
      eq(f.github.merges, [], 'no merge');
      eq(f.ingest.facts.map((x) => x.kind), ['base_changed'], 'the retarget through the funnel');
      eq(await outcomesOf(host, s, 'merge_call'), ['skipped:base_moved:applied'], 'recorded');
      ok((await s.d()).state !== 'LANDING' && !(await s.d()).approvedHeads.includes('H1'), 'the approval of the old diff is dropped');
    },
  },
  {
    name: 'D11: the policy-merge rule\'s approval lands past an escalation, never past a request for changes the review loop ran out on',
    async run(host) {
      const policyMerge = (s: Delivery) => s.submit({ type: 'PolicyMergeApproved', actor: 'rule:policy_merge', headSha: 'H1', reason: 'policy-only escalation, CI green' });
      const esc = await new Delivery(host, 35).open();
      await esc.ownerPushed('H1');
      applied(await esc.verdict('escalate'), 'ESCALATED', 'the reviewer escalated');
      applied(await policyMerge(esc), 'APPROVED', 'the rule approved H1');
      applied(await esc.land('H1'), 'LANDING', 'landing');
      const fe = fakePorts(host);
      fe.github.setPr(esc.repo, esc.prNumber, esc.live('H1'));
      await drainKernel(host, esc, fe.ports);
      eq(fe.github.merges.map((m) => m.headSha), ['H1'], 'an escalation the rule lifted lands');

      const rc = await new Delivery(host, 36).open({ maxRounds: 1 });
      await rc.ownerPushed('H1');
      applied(await rc.verdict('request_changes'), 'ESCALATED', 'the review loop ran out with changes asked');
      eq((await rc.d()).stateReason, 'review_exhausted', 'review_exhausted');
      applied(await policyMerge(rc), 'APPROVED', 'the rule approved H1 anyway');
      applied(await rc.land('H1'), 'LANDING', 'landing');
      const fr = fakePorts(host);
      fr.github.setPr(rc.repo, rc.prNumber, rc.live('H1'));
      await drainKernel(host, rc, fr.ports);
      eq(fr.github.merges, [], 'the open request for changes holds at merge time');
      eq(await outcomesOf(host, rc, 'merge_call'), ['ok:gate_refused:review:applied'], 'the review half refused');
      eq(pick(await rc.d(), ['state', 'stateReason']), { state: 'ESCALATED', stateReason: 'landing_needs_human' }, 'a person decides');
    },
  },
  {
    name: 'buildd/landing: failure while review is pending, success once approved, failure again on a new head; an older or duplicate effect never overwrites the newer answer',
    async run(host) {
      const s = await new Delivery(host, 29).open();
      const f = fakePorts(host);
      const published = () => f.github.written.filter((w) => w.op === 'publishStatus').map((w) => ({ sha: w.sha, state: w.state, context: w.context }));
      const lastDesc = () => String(f.github.written.filter((w) => w.op === 'publishStatus').at(-1)?.description ?? '');
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      await drainKernel(host, s, f.ports);
      eq(published().at(-1), { sha: 'H1', state: 'failure', context: 'buildd/landing' }, 'review missing: failure');
      ok(lastDesc().includes('review of H1 is pending'), `names the wait: ${lastDesc()}`);
      applied(await s.verdict('request_changes'), 'CHANGES_REQUESTED', 'changes asked');
      await drainKernel(host, s, f.ports);
      eq(published().at(-1), { sha: 'H1', state: 'failure', context: 'buildd/landing' }, 'changes asked: failure');
      const fix = await s.startFix();
      applied(await s.push('H2', { attribution: { descendsFromBound: true } }), 'FIXING', 'fix pushed');
      applied(await s.fixEnded(fix, { localHeadSha: 'H2', commitCount: 1, live: s.live('H2'), proof: { liveContainsLocal: true } }), 'AWAITING_REVIEW', 'fix ended');
      applied(await s.verdict('approve'), 'APPROVED', 'approved at H2');
      await drainKernel(host, s, f.ports);
      eq(published().at(-1), { sha: 'H2', state: 'success', context: 'buildd/landing' }, 'approved: success at H2');
      ok(!published().some((x) => x.sha === 'H1' && x.state === 'success'), 'H1 was never given success');
      const count = published().length;
      // Every version owes one effect, and only the newest publishes: no older answer was written after a newer one.
      const versions = (await host.effects(s.deliveryId)).filter((e) => e.kind === 'publish_landing_status');
      eq(versions.length, (await host.transitions(s.deliveryId)).length - 1, 'one status effect per version once the PR is bound');
      const now = (await s.d()).version;
      const older = versions.filter((e) => Number(e.payload.version) < now).at(-1)!;
      const h = kernelEffectHandlers(f.ports);
      eq(await h.publish_landing_status!({ ...(await direct(host, s, 'publish_landing_status')), payload: older.payload, dedupeKey: older.dedupeKey }), { outcome: 'skipped:older_version' }, 'a late older effect publishes nothing');
      eq(await h.publish_landing_status!(await direct(host, s, 'publish_landing_status')), { outcome: 'ok:unchanged:success' }, 'a duplicate of the newest finds GitHub already showing it');
      eq(published().length, count, 'no second write of the same answer');
      eq(published().at(-1), { sha: 'H2', state: 'success', context: 'buildd/landing' }, 'still success at H2');
      applied(await s.push('H3'), 'AWAITING_REVIEW', 'a new head');
      await drainKernel(host, s, f.ports);
      eq(published().at(-1), { sha: 'H3', state: 'failure', context: 'buildd/landing' }, 'a new head starts at failure');
    },
  },
  {
    name: 'buildd/landing: a drain holding an older read is never the last write (newest wins across drains)',
    async run(host) {
      const s = await new Delivery(host, 40).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'under review');
      const f = fakePorts(host);
      let moved = false;
      // While this drain publishes "review pending", the review approves (another drain's version).
      f.github.onStatus = async () => { if (moved) return; moved = true; applied(await s.verdict('approve'), 'APPROVED', 'approved mid-publish'); };
      const h = kernelEffectHandlers(f.ports);
      const rows = (await host.effects(s.deliveryId)).filter((e) => e.kind === 'publish_landing_status');
      const mine = rows.at(-1)!;
      await h.publish_landing_status!({ ...(await direct(host, s, 'publish_landing_status')), payload: mine.payload, dedupeKey: mine.dedupeKey });
      const last = f.github.written.filter((w) => w.op === 'publishStatus').at(-1)!;
      eq({ sha: last.sha, state: last.state }, { sha: 'H1', state: 'success' }, 'the newer answer is the last write');
    },
  },
  {
    name: 'buildd/landing: an effect that runs out of retries never leaves a success it could not re-confirm',
    async run(host) {
      const s = await (await new Delivery(host, 30).open()).approvedAt('H1');
      const f = fakePorts(host);
      const writes = f.github.writes;
      let calls = 0;
      const real = writes.publishStatus;
      writes.publishStatus = async (p) => { calls++; if (calls === 1) throw new Error('GitHub 502'); return real(p); };
      const e = { ...(await direct(host, s, 'publish_landing_status')), attemptCount: EFFECT_MAX_ATTEMPTS };
      let threw = false;
      try { await kernelEffectHandlers(f.ports).publish_landing_status!(e); } catch { threw = true; }
      ok(threw, 'the effect still fails (and goes dead)');
      const last = f.github.written.filter((w) => w.op === 'publishStatus').at(-1) as { state: string; description: string } | undefined;
      eq(last?.state, 'failure', 'exhaustion publishes failure');
      ok(String(last?.description).includes('could not confirm'), `actionable: ${last?.description}`);
    },
  },
  {
    name: 'AC-15: a person merges on GitHub over an open verdict: MERGED, merged over open findings, one trunk fix filed and none on replay; nothing approved',
    async run(host) {
      const s = await new Delivery(host, 33).open();
      await s.ownerPushed('H1');
      applied(await s.verdict('request_changes'), 'CHANGES_REQUESTED', 'changes asked');
      const round = await s.latestRound();
      const r = await s.submit({ type: 'PrMerged', actor: 'webhook', live: { ...s.mergedLive('H1'), mergedBy: 'a-person' } });
      applied(r, 'MERGED', 'merged on GitHub');
      const ev = (r as Extract<CommandResult, { result: 'applied' }>).decision.evidence;
      eq(pick(ev as Record<string, unknown>, ['external', 'mergedBy', 'mergedHead', 'merged_over_open_findings', 'reviewClass']),
        { external: true, mergedBy: 'a-person', mergedHead: 'H1', merged_over_open_findings: true, reviewClass: 'merged_over_verdict' }, 'recorded as it happened');
      const f = fakePorts(host);
      f.reviews.outputs.set(round.id, { verdict: 'request_changes', feedback: 'the header copy says "Needs you"' });
      await drainKernel(host, s, f.ports);
      const fixes = () => f.work.filed.filter((w) => w.role === 'external_merge_fix');
      eq(fixes().length, 1, 'one fix filed');
      eq(pick(fixes()[0]!.target, ['repoFullName', 'prNumber', 'baseRef']), { repoFullName: s.repo, prNumber: null, baseRef: 'dev' }, 'against the base, not the PR');
      ok(fixes()[0]!.description!.includes('Needs you'), 'carries what the review asked');
      notApplied(await s.submit({ type: 'PrMerged', actor: 'webhook', live: { ...s.mergedLive('H1'), mergedBy: 'a-person' } }), 'duplicate', 'idempotency_key_seen', 'webhook replayed');
      await drainKernel(host, s, f.ports);
      eq(await kernelEffectHandlers(f.ports).dispatch_external_merge_fix!(await direct(host, s, 'dispatch_external_merge_fix')), { outcome: 'ok:task_exists' }, 'a redelivered effect files nothing');
      eq(fixes().length, 1, 'still one fix');
      const d = await s.d();
      eq(pick(d, ['state', 'approvedHeads', 'approvalBasis']), { state: 'MERGED', approvedHeads: [], approvalBasis: null }, 'nothing approved');
      eq(deriveDeliveryView({ view: await s.view() })!.headline, 'Merged', 'shown as merged, never approved');

      // A buildd door's merge (through LANDING) is not external and owes no fix.
      const b = await (await new Delivery(host, 34).open()).approvedAt('H1');
      applied(await b.land('H1'), 'LANDING', 'landing');
      applied(await b.submit({ type: 'MergeCallResult', actor: 'kernel', headSha: 'H1', outcome: 'merged' }), 'LANDING', 'merge answer');
      const rb = await b.merged('H1');
      applied(rb, 'MERGED', 'merged by the kernel');
      eq((rb as Extract<CommandResult, { result: 'applied' }>).decision.evidence.external ?? null, null, 'not external');
      eq(await b.count('dispatch_external_merge_fix'), 0, 'no fix owed');
    },
  },
  {
    name: 'handlers/supersession: a close is scanned; a recorded edge is projected and wakes the coordinator; an abandon projects as abandoned',
    async run(host) {
      const s = await new Delivery(host, 31).open();
      await s.ownerPushed('H1');
      applied(await s.submit({ type: 'PrClosedUnmerged', actor: 'webhook', live: s.live('H1', { state: 'closed', updatedAt: '2026-01-01T02:00:00Z' }), closeCause: 'manual' }), 'CLOSED_UNMERGED', 'closed');
      const f = fakePorts(host);
      await drainKernel(host, s, f.ports);
      eq(await outcomesOf(host, s, 'scan_supersession'), ['ok:none_found'], 'scanned');
      applied(await s.submit({ type: 'SupersessionRecorded', actor: 'human:u', target: { repoFullName: s.repo, prNumber: 99, merged: true, url: null }, reason: 'landed in #99', authorised: true }), 'SUPERSEDED', 'edge');
      await drainKernel(host, s, f.ports);
      eq({ project: await outcomesOf(host, s, 'project_supersession'), wake: await outcomesOf(host, s, 'wake_mission') }, { project: ['ok:superseded_1'], wake: ['ok:woken'] }, 'projected and woken');
      eq(f.lifecycle.ops()[0], 'scanSupersession', 'the scan ran first');
      eq(f.lifecycle.ops().slice(1).sort(), ['projectResolution:superseded', 'wakeCoordinator:pr_resolved'], 'one projection, one wake');

      const a = await new Delivery(host, 32).open();
      await a.ownerPushed('H1');
      applied(await a.submit({ type: 'PrClosedUnmerged', actor: 'webhook', live: a.live('H1', { state: 'closed', updatedAt: '2026-01-01T03:00:00Z' }), closeCause: 'manual' }), 'CLOSED_UNMERGED', 'closed a');
      const fa = fakePorts(host, { lifecycle: new RecordingLifecycle({ scan: null, wake: null }) });
      await drainKernel(host, a, fa.ports);
      eq(await outcomesOf(host, a, 'scan_supersession'), ['skipped:no_worker'], 'nothing to scan from');
      applied(await a.submit({ type: 'Abandon', actor: 'human:u', reason: 'not needed' }), 'ABANDONED', 'abandoned');
      await drainKernel(host, a, fa.ports);
      eq({ project: await outcomesOf(host, a, 'project_supersession'), wake: await outcomesOf(host, a, 'wake_mission') }, { project: ['ok:abandoned_1'], wake: ['skipped:no_mission'] }, 'projected as abandoned; nothing to wake');
    },
  },
  {
    name: 'handlers/activity: every transition is rendered; a render overtaken while it writes owes the newer one; a released delivery is never rendered',
    async run(host) {
      const s = await new Delivery(host, 41).open();
      const notify = new RecordingNotify();
      let bumped = false;
      notify.onActivity = async () => {
        if (bumped) return;
        bumped = true;
        applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'moved on mid-render');
      };
      const f = fakePorts(host, { notify });
      await drainKernel(host, s, f.ports);
      const outs = await outcomesOf(host, s, 'render_activity');
      ok(outs.some((o) => o === 'ok:rendered+followup'), `the overtaken render owes one more: ${outs}`);
      const version = (await s.d()).version;
      eq(Math.max(...notify.activities.map((x) => x.version)), version, 'the last render is at the current version');
      ok(outs.every((o) => o === 'ok:rendered' || o === 'ok:rendered+followup'), 'every render ran');

      const r = await new Delivery(host, 42).open();
      await host.setKernelEnabled(r.workspaceId, false);
      const fr = fakePorts(host);
      await drainKernel(host, r, fr.ports);
      eq(fr.notify.activities, [], 'nothing rendered for legacy');
      ok((await outcomesOf(host, r, 'render_activity')).every((o) => o === 'skipped:legacy_owns'), 'skipped as legacy-owned');
      await host.setKernelEnabled(r.workspaceId, true);
    },
  },
  {
    name: 'handlers/ci: the CI fix is filed under its ledger row, bound to it and woken; its job log is captured by a follow-up effect that records a fact; a redelivery files nothing twice',
    async run(host) {
      const s = await new Delivery(host, 61).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.ciRed('H1'), 'REPAIRING', 'CI red');
      const f = fakePorts(host, { work: { ci_fix: { evidence: { failedJobId: 42 } } } });
      f.github.setPr(s.repo, s.prNumber, s.live('H1'));
      await drainKernel(host, s, f.ports);
      const attempt = (await s.view()).attempts.find((a) => a.family === 'ci')!;
      eq(
        f.work.filed.map((w) => ({ role: w.role, taskId: w.taskId, headSha: w.target.headSha, parent: w.lineage.parentTaskId, detail: pick(w.detail ?? {}, ['attemptNo', 'maxAttempts', 'firstAtHead']) })),
        [{ role: 'ci_fix', taskId: attempt.id, headSha: 'H1', parent: s.ownerTaskId, detail: { attemptNo: 1, maxAttempts: 3, firstAtHead: true } }],
        'one CI fix, under the ledger row',
      );
      eq(attempt.taskId, attempt.id, 'the row is bound to it');
      eq(f.work.woken, [{ taskId: attempt.id, reason: 'ci.retry' }], 'woken once');
      eq(await outcomesOf(host, s, 'dispatch_ci_fix'), ['ok'], 'dispatched');
      eq(await outcomesOf(host, s, 'capture_ci_evidence'), ['ok:stored'], 'the job log is its own effect');
      eq(f.evidence.captures.map((c) => pick(c.payload, ['failedJobId', 'taskId'])), [{ failedJobId: 42, taskId: attempt.id }], 'for the filed task');
      const fact = await host.store.findFact(s.workspaceId, ciEvidenceFactKey(attempt.id));
      eq(pick(fact?.payload ?? null, ['status', 'taskId', 'objectKey']), { status: 'stored', taskId: attempt.id, objectKey: 'evidence/ci.log.gz' }, 'recorded as a fact');
      // A redelivery finds the bound task; nobody claimed it yet, so it is woken again (the wake coalesces).
      eq(await kernelEffectHandlers(f.ports).dispatch_ci_fix!(await direct(host, s, 'dispatch_ci_fix')), { outcome: 'ok:task_rewoken' }, 'a redelivery finds the bound task');
      eq(await kernelEffectHandlers(f.ports).capture_ci_evidence!(await direct(host, s, 'capture_ci_evidence')), { outcome: 'ok:already_recorded' }, 'and captures nothing twice');
      eq({ asked: f.work.requested.length, captures: f.evidence.captures.length }, { asked: 1, captures: 1 }, 'a bound row asks for nothing again');
    },
  },
  {
    name: 'handlers/ci: a fix owed at a head that moved, for a closed PR, or with CI green now files nothing',
    async run(host) {
      const a = await new Delivery(host, 62).open();
      applied(await a.ownerPushed('H1'), 'AWAITING_REVIEW', 'a pushed');
      applied(await a.ciRed('H1'), 'REPAIRING', 'a red');
      const fa = fakePorts(host);
      fa.github.setPr(a.repo, a.prNumber, a.live('H2'));
      await drainKernel(host, a, fa.ports);
      eq(await outcomesOf(host, a, 'dispatch_ci_fix'), ['skipped:head_moved'], 'a moved head');
      eq(fa.ingest.facts.map((x) => pick(x, ['kind', 'source'])), [{ kind: 'head_observed', source: 'effect:dispatch_ci_fix' }], 'goes through the funnel');

      const b = await new Delivery(host, 63).open();
      applied(await b.ownerPushed('H1'), 'AWAITING_REVIEW', 'b pushed');
      applied(await b.ciRed('H1'), 'REPAIRING', 'b red');
      const fb = fakePorts(host);
      fb.github.setPr(b.repo, b.prNumber, b.live('H1', { state: 'closed' }));
      await drainKernel(host, b, fb.ports);
      eq(await outcomesOf(host, b, 'dispatch_ci_fix'), ['skipped:pr_not_open'], 'a closed PR');

      const c = await new Delivery(host, 64).open();
      applied(await c.ownerPushed('H1'), 'AWAITING_REVIEW', 'c pushed');
      applied(await c.ciRed('H1'), 'REPAIRING', 'c red');
      const fc = fakePorts(host);
      fc.github.setPr(c.repo, c.prNumber, c.live('H1'));
      fc.github.green.set(`${c.repo}@H1`, true);
      await drainKernel(host, c, fc.ports);
      eq(await outcomesOf(host, c, 'dispatch_ci_fix'), ['skipped:ci_green'], 'green now');
      ok((await c.d()).state !== 'REPAIRING', 'the repair is not needed');
      ok((await c.view()).attempts.every((x) => x.status !== 'queued'), 'its row is no longer owed');

      eq([fa, fb, fc].map((f) => f.work.filed.length), [0, 0, 0], 'nothing filed');
    },
  },
  {
    name: 'handlers/ci: a spent or disabled CI budget hands the PR to a person, in the kernel\'s words; a family the kernel does not know stays legacy\'s',
    async run(host) {
      const s = await new Delivery(host, 65).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.ciRed('H1', { maxAttempts: 0 }), 'ESCALATED', 'CI retries off');
      const f = fakePorts(host);
      await drainKernel(host, s, f.ports);
      eq(f.escalate.calls.map((c) => pick(c, ['family', 'headSha', 'attempts', 'max', 'title', 'detail'])), [{
        family: 'ci', headSha: 'H1', attempts: 0, max: 0, title: 'CI failing — retries disabled',
        detail: `CI retries are disabled for this workspace; CI is failing on PR #${s.prNumber}.`,
      }], 'one hand-off, saying retries are off');
      eq(await outcomesOf(host, s, 'escalate_exhaustion'), ['ok'], 'escalated');
      eq(await kernelEffectHandlers(f.ports).escalate_exhaustion!(await direct(host, s, 'escalate_exhaustion', { family: 'release' })), { outcome: 'skipped:legacy_owns' }, 'an unknown family is legacy\'s');
      const none = fakePorts(host, { omit: ['github'] });
      eq(await kernelEffectHandlers(none.ports).escalate_exhaustion!(await direct(host, s, 'escalate_exhaustion')), { outcome: 'skipped:no_installation' }, 'no GitHub, no hand-off');
      eq(f.escalate.calls.length + none.escalate.calls.length, 1, 'only the first reached a person');
    },
  },
  {
    name: 'handlers/ci: a fix filed by a run that crashed before binding its row is bound, woken and owed its evidence by the next run',
    async run(host) {
      const s = await new Delivery(host, 66).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.ciRed('H1'), 'REPAIRING', 'CI red');
      const attempt = (await s.view()).attempts.find((a) => a.family === 'ci')!;
      const f = fakePorts(host, { work: { ci_fix: { evidence: { failedJobId: 7 } } } });
      f.github.setPr(s.repo, s.prNumber, s.live('H1'));
      // The earlier run: filed under the row's id, then died before the kernel bound the row.
      await f.work.file({ role: 'ci_fix', workspaceId: s.workspaceId, taskId: attempt.id, target: { repoFullName: s.repo, prNumber: s.prNumber, headSha: 'H1' }, lineage: { deliveryId: s.deliveryId, attemptId: attempt.id }, dedupeKey: `ci_fix:${attempt.id}` });
      await drainKernel(host, s, f.ports);
      eq(await outcomesOf(host, s, 'dispatch_ci_fix'), ['ok:task_bound'], 'the next run binds it');
      eq((await s.view()).attempts.find((a) => a.id === attempt.id)?.taskId, attempt.id, 'bound to the task already filed');
      eq(f.work.woken, [{ taskId: attempt.id, reason: 'ci.retry' }], 'and wakes it');
      eq(await outcomesOf(host, s, 'capture_ci_evidence'), ['ok:stored'], 'and its job log is still captured');
      eq(f.work.filed.length, 1, 'nothing filed twice');
    },
  },
  {
    name: 'handlers: every family of a shared kind reaches its own handler; a family the kernel does not know is legacy\'s',
    async run(host) {
      const s = await new Delivery(host, 67).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      const f = fakePorts(host);
      const h = kernelEffectHandlers(f.ports);
      eq(await h.cancel_open_attempts!(await direct(host, s, 'cancel_open_attempts', { reason: 'approved', families: ['review_fix'] })), { outcome: 'ok' }, 'an approval\'s cancellation');
      eq(await h.cancel_open_attempts!(await direct(host, s, 'cancel_open_attempts', { reason: 'head_moved', families: ['conflict'] })), { outcome: 'ok:cancelled_0' }, 'a moved head\'s cancellation');
      for (const families of [['ci'], ['migration'], ['review_fix'], undefined]) {
        eq(await h.cancel_open_attempts!(await direct(host, s, 'cancel_open_attempts', { reason: 'head_moved', ...(families ? { families } : {}) })), { outcome: 'ok:cancelled_0' }, `a moved head, families ${families}`);
      }
      eq(f.reviews.ops(), ['supersedeFixOnApproval'], 'the approval supersedes the open fix');
      const moved = 'the PR head moved before the fix started';
      eq(f.work.cancelledPending.map((c) => pick(c, ['role', 'reason'])), [
        { role: 'fix', reason: 'the PR was approved' }, { role: 'conflict_fix', reason: moved },
        { role: 'ci_fix', reason: moved }, { role: 'conflict_fix', reason: moved }, { role: 'fix', reason: moved }, { role: 'fix', reason: moved },
      ], 'each family cancels its own pending tasks; no family named is the review fix');
      eq(await h.cancel_open_attempts!(await direct(host, s, 'cancel_open_attempts', { reason: 'merged' })), { outcome: 'skipped:legacy_owns' }, 'a merge\'s cancellation is legacy\'s');
      eq(await h.escalate_exhaustion!(await direct(host, s, 'escalate_exhaustion', { family: 'conflict', attempts: 3 })), { outcome: 'ok' }, 'a conflict family\'s exhaustion');
      eq(await h.escalate_exhaustion!(await direct(host, s, 'escalate_exhaustion', { family: 'review_fix' })), { outcome: 'ok' }, 'a review family\'s exhaustion');
      // Each through its own family's path: the conflict path would hand the review family over in its own words.
      eq(f.escalate.calls.map((c) => pick(c, ['family', 'title', 'detail', 'attempts'])), [
        { family: 'conflict', title: 'Conflict resolution exhausted', detail: `conflict repair attempts used 3 on PR #${s.prNumber}`, attempts: 3 },
        { family: 'review_fix', title: 'Review fix attempts exhausted', detail: 'after 1 review rounds', attempts: 1 },
      ], 'each handed to a person once, in its own family\'s words');
      eq(await h.escalate_exhaustion!(await direct(host, s, 'escalate_exhaustion', { family: 'release' })), { outcome: 'skipped:legacy_owns' }, 'an unknown family');
    },
  },
  {
    name: 'handlers/trunk: one trunk fix per red base, filed under its anchor, linked and woken; a later incident joins it with the checks it lacks; a green base files nothing; blocked CI fixes are cancelled',
    async run(host) {
      const trunk = new RecordingTrunk();
      const f = fakePorts(host, { trunk });
      f.work.pendingToCancel = 2;
      const a = await new Delivery(host, 71).open();
      applied(await a.ownerPushed('H1'), 'AWAITING_REVIEW', 'a pushed');
      const i1 = host.newId();
      trunk.add({ id: i1, workspaceId: a.workspaceId, repoFullName: a.repo, baseRef: 'dev', signature: 'ci:unit', status: 'open', fixTaskId: null, affectedDeliveries: [a.deliveryId] });
      f.github.heads.set(`${a.repo}:dev`, 'B1');
      f.github.runs.set(`${a.repo}@B1`, { complete: true, failing: ['unit'] });
      applied(await a.trunkRed(i1, 'ci:unit'), 'BLOCKED_ON_TRUNK', 'a blocked');
      await drainKernel(host, a, f.ports);
      eq(f.work.filed.map((w) => pick(w, ['role', 'taskId', 'title'])), [{ role: 'trunk_fix', taskId: i1, title: 'fix(ci): dev is red — unit' }], 'one trunk fix, under the incident');
      ok(f.work.filed[0]!.description?.includes(`Blocked PRs: #${a.prNumber}`), 'naming the blocked PR');
      eq({ links: trunk.links, woken: f.work.woken }, { links: [{ incidentId: i1, taskId: i1 }], woken: [{ taskId: i1, reason: 'task.created' }] }, 'linked and woken');
      eq({ fix: await outcomesOf(host, a, 'dispatch_trunk_fix'), cancel: await outcomesOf(host, a, 'cancel_open_attempts') }, { fix: ['ok'], cancel: ['ok:cancelled_2'] }, 'dispatched; blocked CI fixes cancelled');
      eq(f.work.cancelledPending.map((c) => pick(c, ['deliveryId', 'role', 'reason', 'summary'])), [{ deliveryId: a.deliveryId, role: 'ci_fix', reason: 'blocked_on_trunk', summary: BLOCKED_ON_TRUNK_SUMMARY }], 'the per-PR CI fixes nobody started');

      const b = await new Delivery(host, 72).open();
      applied(await b.ownerPushed('H1'), 'AWAITING_REVIEW', 'b pushed');
      const i2 = host.newId();
      trunk.add({ id: i2, workspaceId: a.workspaceId, repoFullName: a.repo, baseRef: 'dev', signature: 'ci:lint|unit', status: 'open', fixTaskId: null, affectedDeliveries: [b.deliveryId] });
      trunk.anchors.set(i2, { taskId: i1, incidentId: i1, fixSignature: 'ci:unit' });
      applied(await b.trunkRed(i2, 'ci:lint|unit'), 'BLOCKED_ON_TRUNK', 'b blocked');
      await drainKernel(host, b, f.ports);
      eq(await outcomesOf(host, b, 'dispatch_trunk_fix'), ['ok:joined_open_fix'], 'joins the open fix');
      eq(f.work.filed.length, 1, 'no second trunk fix');
      eq(f.work.steered.map((x) => pick(x, ['taskId', 'marker'])), [{ taskId: i1, marker: `trunk-incident:${i2}` }], 'the open fixer is steered');
      ok(f.work.steered[0]!.note.includes('now also fails: lint'), `with the check it lacks: ${f.work.steered[0]!.note}`);

      const c = await new Delivery(host, 73).open();
      applied(await c.ownerPushed('H1'), 'AWAITING_REVIEW', 'c pushed');
      const i3 = host.newId();
      trunk.add({ id: i3, workspaceId: a.workspaceId, repoFullName: a.repo, baseRef: 'main', signature: 'ci:unit', status: 'open', fixTaskId: null, affectedDeliveries: [c.deliveryId] });
      f.github.heads.set(`${a.repo}:main`, 'B2');
      f.github.runs.set(`${a.repo}@B2`, { complete: true, failing: [] });
      applied(await c.trunkRed(i3, 'ci:unit'), 'BLOCKED_ON_TRUNK', 'c blocked');
      await drainKernel(host, c, f.ports);
      eq(await outcomesOf(host, c, 'dispatch_trunk_fix'), ['skipped:trunk_green'], 'a green base owes no fix');
      eq(f.work.filed.length, 1, 'still one trunk fix');
    },
  },
  {
    name: 'handlers/review: one reviewer per round, bound to it and woken; a redelivery files nothing; no role fails the round (T27); an attested composition files no reviewer',
    async run(host) {
      const s = await new Delivery(host, 81).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      const r1 = await s.latestRound();
      const f = fakePorts(host);
      await drainKernel(host, s, f.ports);
      const filed = f.work.filed.filter((w) => w.role === 'review');
      eq(filed.map((w) => ({ headSha: w.target.headSha, roundId: w.detail?.roundId, parent: w.lineage.parentTaskId })), [{ headSha: 'H1', roundId: r1.id, parent: s.ownerTaskId }], 'one reviewer, at the round head');
      const reviewer = filed[0]!.taskId;
      eq((await s.latestRound()).reviewerTaskId, reviewer, 'the round is bound to it');
      eq(f.work.woken, [{ taskId: reviewer, reason: 'task.created' }], 'woken');
      eq(f.work.cancelledPending.map((c) => pick(c, ['role', 'keepTaskId'])), [{ role: 'review', keepTaskId: reviewer }], 'older pending reviewers are cancelled');
      eq(await outcomesOf(host, s, 'dispatch_review'), ['ok'], 'dispatched');
      eq(await kernelEffectHandlers(f.ports).dispatch_review!(await direct(host, s, 'dispatch_review')), { outcome: 'skipped:already_dispatched' }, 'a redelivery');
      eq(f.work.requested.length, 1, 'asked once');

      const b = await new Delivery(host, 82).open();
      applied(await b.ownerPushed('H1'), 'AWAITING_REVIEW', 'b pushed');
      const fb = fakePorts(host, { work: { review: { skipped: NO_ROLE } } });
      await drainKernel(host, b, fb.ports);
      eq((await outcomesOf(host, b, 'dispatch_review'))[0], 'skipped:no_reviewer_role', 'no role');
      ok((await host.transitions(b.deliveryId)).some((t) => t.command === 'ReviewRoundFailed'), 'the round failed (T27), not dropped');

      const c = await new Delivery(host, 83).open();
      applied(await c.ownerPushed('H1'), 'AWAITING_REVIEW', 'c pushed');
      const fc = fakePorts(host);
      fc.reviews.attested.set((await c.latestRound()).id, 'ok:composition_attested');
      await drainKernel(host, c, fc.ports);
      eq(await outcomesOf(host, c, 'dispatch_review'), ['ok:composition_attested'], 'attested');
      eq(fc.work.requested.length, 0, 'no reviewer filed');
    },
  },
  {
    name: 'handlers/review: changes requested are posted at the round\'s own commit; the fix is allocated (T8), filed under its row and woken once; the next round carries the prior verdict; a fix someone claimed is never woken again',
    async run(host) {
      const s = await new Delivery(host, 84).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      const f = fakePorts(host);
      await drainKernel(host, s, f.ports);
      const r1 = await s.latestRound();
      f.reviews.outputs.set(r1.id, { verdict: 'request-changes', confidence: 0.9, summary: 's', feedback: 'check the caller' });
      applied(await s.verdict('request_changes'), 'CHANGES_REQUESTED', 'changes requested');
      f.github.setPr(s.repo, s.prNumber, s.live('H1'));
      await drainKernel(host, s, f.ports);
      eq(f.github.written.filter((w) => w.op === 'postReview').map((w) => pick(w, ['commitId', 'event', 'body'])), [{ commitId: 'H1', event: 'REQUEST_CHANGES', body: 'Changes requested by buildd reviewer: check the caller' }], 'posted at the round head');
      const attempt = (await s.view()).attempts.find((a) => a.family === 'review_fix')!;
      ok(attempt?.taskId, 'T8 allocated the row with its task id');
      eq(f.work.filed.filter((w) => w.role === 'fix').map((w) => ({ taskId: w.taskId, attemptId: w.lineage.attemptId, firstAtHead: w.detail?.firstAtHead })), [{ taskId: attempt.taskId, attemptId: attempt.id, firstAtHead: true }], 'the fix, under the row');
      ok(f.work.woken.some((w) => w.taskId === attempt.taskId && w.reason === 'review.fix_requested'), 'woken');
      eq(await outcomesOf(host, s, 'dispatch_fix'), ['ok'], 'filed');
      eq(await kernelEffectHandlers(f.ports).dispatch_fix!(await direct(host, s, 'dispatch_fix')), { outcome: 'ok:task_rewoken' }, 'a redelivery files nothing twice, and wakes the unclaimed fix again');
      eq(f.work.filed.filter((w) => w.role === 'fix').length, 1, 'one fix');
      eq(f.work.woken.filter((w) => w.taskId === attempt.taskId && w.reason === 'review.fix_requested').length, 2, 'woken again by the redelivery');

      applied(await s.submit({ type: 'FixClaimed', actor: 'runner', attemptId: attempt.id, revalidation: { live: s.live('H1'), approved: false } }), 'FIXING', 'claimed');
      applied(await s.push('H2'), 'FIXING', 'the fix pushed');
      applied(await s.fixEnded(attempt.id, { localHeadSha: 'H2', commitCount: 1 }), 'AWAITING_REVIEW', 'the fix ended on GitHub');
      await drainKernel(host, s, f.ports);
      const second = f.work.filed.filter((w) => w.role === 'review').at(-1)!;
      eq(pick(second.detail?.priorVerdict as Record<string, unknown> ?? null, ['headSha', 'verdict', 'feedback']), { headSha: 'H1', verdict: 'request-changes', feedback: 'check the caller' }, 'the delta round knows what was asked');
      // §8.4: a review owed for a round is posted at that round's commit, not at the head the PR shows now.
      const before = f.github.written.length;
      eq(await kernelEffectHandlers(f.ports).post_review!(await direct(host, s, 'post_review', { roundId: r1.id, event: 'REQUEST_CHANGES' })), { outcome: 'ok' }, 'posted');
      eq(f.github.written.slice(before).filter((w) => w.op === 'postReview').map((w) => w.commitId), ['H1'], 'at the round head, with the PR now at H2');

      // A fix someone already claimed is never woken again. Posting the review went dead while the
      // fix ran (ESCALATED, the attempt still running) and a person asked for changes again: the
      // delivery is back in CHANGES_REQUESTED, and the dispatch that owes finds the running fix.
      const t = await new Delivery(host, 85).open();
      applied(await t.ownerPushed('H1'), 'AWAITING_REVIEW', 't pushed');
      const ft = fakePorts(host);
      await drainKernel(host, t, ft.ports);
      applied(await t.verdict('request_changes'), 'CHANGES_REQUESTED', 't changes requested');
      ft.github.setPr(t.repo, t.prNumber, t.live('H1'));
      await drainKernel(host, t, ft.ports);
      const running = (await t.view()).attempts.find((a) => a.family === 'review_fix')!;
      applied(await t.submit({ type: 'FixClaimed', actor: 'runner', attemptId: running.id, revalidation: { live: t.live('H1'), approved: false } }), 'FIXING', 't fix claimed');
      const posted = (await host.effects(t.deliveryId)).find((e) => e.kind === 'post_review')!;
      applied(await t.submit({ type: 'EffectDead', actor: 'kernel', effectId: host.newId(), effectKind: 'post_review', dedupeKey: posted.dedupeKey }), 'ESCALATED', 'posting the review went dead');
      applied(await t.submit({ type: 'HumanResolve', actor: 'human:u', choice: 'request_changes', expectedVersion: (await t.d()).version }), 'CHANGES_REQUESTED', 'a person asks for changes');
      eq((await t.view()).attempts.find((a) => a.id === running.id)?.status, 'running', 'the claimed fix is still running');
      const humanFix = (await host.effects(t.deliveryId)).find((e) => e.kind === 'dispatch_fix' && e.payload.trigger === 'human')!;
      const wakesBefore = ft.work.woken.length;
      eq(await kernelEffectHandlers(ft.ports).dispatch_fix!(await direct(host, t, 'dispatch_fix', humanFix.payload)), { outcome: 'ok:task_exists' }, 'the running fix is found, not filed again');
      eq({ fixes: ft.work.filed.filter((w) => w.role === 'fix').length, wakes: ft.work.woken.length - wakesBefore }, { fixes: 1, wakes: 0 }, 'and not woken: someone has it');
    },
  },
  {
    name: 'handlers/review: a review GitHub refused is recorded for a person once; a matching review is no failure; a verdict on the host\'s own PR went up as a comment',
    async run(host) {
      const post = async (prNumber: number, answer: { posted: boolean; reason?: string; commentedOwnPr?: boolean }) => {
        const s = await (await new Delivery(host, prNumber).open()).approvedAt('H1');
        const f = fakePorts(host);
        f.github.reviewAnswer = { id: null, ...answer };
        await drainKernel(host, s, f.ports);
        return { outcome: await outcomesOf(host, s, 'post_review'), ops: f.reviews.ops().filter((o) => o.startsWith('postFailed')) };
      };
      eq(await post(85, { posted: false, reason: 'bad token' }), { outcome: ['failed_post:bad token'], ops: ['postFailed:APPROVE:bad token'] }, 'refused: recorded, not retried');
      eq(await post(86, { posted: false, reason: 'a matching review already exists for this commit' }), { outcome: ['ok'], ops: [] }, 'already there');
      eq(await post(87, { posted: true, commentedOwnPr: true }), { outcome: ['ok:commented_own_pr'], ops: [] }, 'own PR');
    },
  },
  {
    name: 'handlers/review: push recovery re-reads, schedules its next try once, and hands a spent chain to a person; a head that arrived meanwhile goes to the funnel',
    async run(host) {
      const s = await new Delivery(host, 88).open();
      applied(await s.submit({ type: 'AttemptEnded', actor: 'runner', workerId: 'wk', taskId: s.ownerTaskId, outcome: 'success', localHeadSha: 'L2', commitCount: 1, live: s.live('H1') }), 'AWAITING_PUSH', 'nothing on GitHub');
      // GitHub unreadable: nothing arrived that the kernel can see.
      const f = fakePorts(host);
      const h = kernelEffectHandlers(f.ports);
      const first = await direct(host, s, 'push_recovery');
      eq(await h.push_recovery!(first), { outcome: 'ok:retry_2' }, 'the next try is owed');
      eq(await h.push_recovery!(first), { outcome: 'skipped:retry_2_exists' }, 'a redelivery schedules nothing');
      eq(await s.count('push_recovery'), 2, 'one follow-up');
      eq(await h.push_recovery!({ ...first, payload: { ...first.payload, try: 3, maxTries: 3 } }), { outcome: 'ok:exhausted' }, 'the last try');
      ok((await s.d()).state !== 'AWAITING_PUSH', 'a person owns it now');

      const m = await new Delivery(host, 89).open();
      applied(await m.submit({ type: 'AttemptEnded', actor: 'runner', workerId: 'wk', taskId: m.ownerTaskId, outcome: 'success', localHeadSha: 'L2', commitCount: 1, live: m.live('H1') }), 'AWAITING_PUSH', 'm');
      const fm = fakePorts(host);
      fm.github.setPr(m.repo, m.prNumber, m.live('L2'));
      eq(await kernelEffectHandlers(fm.ports).push_recovery!(await direct(host, m, 'push_recovery')), { outcome: 'ok:head_observed' }, 'the head arrived');
      eq(fm.ingest.facts.map((x) => pick(x, ['kind', 'source'])), [{ kind: 'head_observed', source: 'effect:push_recovery' }], 'through the funnel');
    },
  },
  {
    name: 'handlers/notify: a pre-flight finding is announced only while the delivery is escalated at its head; a dead effect and an undeliverable fix tell the team in words',
    async run(host) {
      const s = await new Delivery(host, 90).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      const f = fakePorts(host);
      const h = kernelEffectHandlers(f.ports);
      eq(await h.notify!(await direct(host, s, 'notify', { event: 'policy_human', headSha: 'H1', reason: 'drops a column' })), { outcome: 'skipped:state_moved' }, 'not escalated: no notice');
      eq(await h.notify!(await direct(host, s, 'notify', { event: 'effect_dead', effectKind: 'merge_call' })), { outcome: 'ok' }, 'dead effect');
      eq(await h.notify!(await direct(host, s, 'notify', { event: 'push_undeliverable', localHeadSha: 'abcdef123' })), { outcome: 'ok' }, 'undeliverable');
      eq(await h.notify!(await direct(host, s, 'notify', { event: 'something_else' })), { outcome: 'skipped:no_channel' }, 'no channel');
      eq(f.notify.teams.map((t) => pick(t, ['kind', 'title', 'prNumber', 'urlTitle'])), [
        { kind: 'needsAttention', title: `PR #${s.prNumber} needs a person: the merge call kept failing`, prNumber: s.prNumber, urlTitle: 'View PR' },
        { kind: 'needsAttention', title: `PR #${s.prNumber}: a fix never reached GitHub`, prNumber: s.prNumber, urlTitle: 'View PR' },
      ], 'two notices');
      ok(f.notify.teams[1]!.body?.includes('its local commit was abcdef1'), 'naming the local commit');
    },
  },
  {
    name: 'handlers/conflict: a refused mechanical refresh allocates the agent attempt, filed under its row; up to date needs nothing; an operational dead end goes to a person',
    async run(host) {
      const conflicted = async (prNumber: number) => {
        const s = await new Delivery(host, prNumber).open();
        applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
        applied(await s.submit({ type: 'ConflictObserved', actor: 'webhook', headSha: 'H1', mergeable: 'dirty', maxAgentAttempts: 3 }), 'REPAIRING', 'conflict');
        return s;
      };
      const a = await conflicted(91);
      const fa = fakePorts(host);
      fa.github.setPr(a.repo, a.prNumber, a.live('H1', { mergeableState: 'dirty' }));
      fa.conflicts.refreshAnswer = { kind: 'refused', refusal: { reason: 'merge conflict in a.ts', mode: 'textual' } };
      await drainKernel(host, a, fa.ports);
      eq(await outcomesOf(host, a, 'refresh_branch'), ['ok:refused:merge conflict in a.ts'], 'refused to an agent');
      const agent = (await a.view()).attempts.find((x) => x.mode === 'agent')!;
      ok(agent, 'T12 allocated the agent attempt');
      eq(fa.work.filed.filter((w) => w.role === 'conflict_fix').map((w) => ({ taskId: w.taskId, refusal: (w.detail?.refusal as { mode?: string } | null)?.mode })), [{ taskId: agent.id, refusal: 'textual' }], 'the agent fix, under its row, with what was refused');
      eq((await a.view()).attempts.find((x) => x.id === agent.id)?.taskId, agent.id, 'bound');
      ok(fa.work.woken.some((w) => w.taskId === agent.id && w.reason === 'conflict.retry'), 'woken');

      const b = await conflicted(92);
      const fb = fakePorts(host);
      fb.github.setPr(b.repo, b.prNumber, b.live('H1', { mergeableState: 'dirty' }));
      fb.conflicts.refreshAnswer = { kind: 'up_to_date' };
      await drainKernel(host, b, fb.ports);
      eq(await outcomesOf(host, b, 'refresh_branch'), ['skipped:up_to_date'], 'nothing to merge in');
      ok((await b.d()).state !== 'REPAIRING', 'the repair was not needed');

      const c = await conflicted(93);
      const fc = fakePorts(host);
      fc.github.setPr(c.repo, c.prNumber, c.live('H1', { mergeableState: 'dirty' }));
      fc.conflicts.refreshAnswer = { kind: 'failed', reason: 'update-branch kept failing' };
      await drainKernel(host, c, fc.ports);
      eq(await outcomesOf(host, c, 'refresh_branch'), ['ok:escalated:update-branch kept failing'], 'a person lands it');
      eq((await c.d()).state, 'ESCALATED', 'escalated');
      eq(fc.notify.teams.map((t) => t.title), [`PR #${c.prNumber}: landing needs a person`], 'and the team is told');
      eq(fc.work.requested.filter((w) => w.role === 'conflict_fix').length, 0, 'no agent');
    },
  },
  {
    name: 'handlers/conflict: an agent fix filed by a run that crashed before binding its row is bound and woken by the next run',
    async run(host) {
      const s = await new Delivery(host, 100).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.submit({ type: 'ConflictObserved', actor: 'webhook', headSha: 'H1', mergeable: 'dirty', maxAgentAttempts: 3 }), 'REPAIRING', 'conflict');
      const f = fakePorts(host);
      f.github.setPr(s.repo, s.prNumber, s.live('H1', { mergeableState: 'dirty' }));
      f.conflicts.refreshAnswer = { kind: 'refused', refusal: { reason: 'merge conflict', mode: 'textual' } };
      eq(await kernelEffectHandlers(f.ports).refresh_branch!(await direct(host, s, 'refresh_branch')), { outcome: 'ok:refused:merge conflict' }, 'refused to an agent');
      const agent = (await s.view()).attempts.find((x) => x.mode === 'agent')!;
      await f.work.file({ role: 'conflict_fix', workspaceId: s.workspaceId, taskId: agent.id, target: { repoFullName: s.repo, prNumber: s.prNumber, headSha: 'H1' }, lineage: { deliveryId: s.deliveryId, attemptId: agent.id }, dedupeKey: `conflict_fix:${agent.id}` });
      await drainKernel(host, s, f.ports);
      eq(await outcomesOf(host, s, 'dispatch_conflict_fix'), ['ok:task_bound'], 'the next run binds it');
      eq((await s.view()).attempts.find((x) => x.id === agent.id)?.taskId, agent.id, 'bound');
      ok(f.work.woken.some((w) => w.taskId === agent.id && w.reason === 'conflict.retry'), 'and woken');
      eq(f.work.filed.filter((w) => w.role === 'conflict_fix').length, 1, 'nothing filed twice');
    },
  },
  {
    name: 'handlers/conflict: T26\'s plain refresh is pinned to the head it judged stale and never pushes to a dependency bot; a migration collision is renumbered mechanically',
    async run(host) {
      const s = await new Delivery(host, 94).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      const f = fakePorts(host);
      const h = kernelEffectHandlers(f.ports);
      eq(await h.refresh_branch!(await direct(host, s, 'refresh_branch', { headSha: 'H1' })), { outcome: 'ok:updated' }, 'updated at H1');
      eq(await h.refresh_branch!(await direct(host, s, 'refresh_branch', { headSha: 'H0' })), { outcome: 'skipped:head_moved' }, 'a stale head is not refreshed');
      f.conflicts.botOwnedAnswer = true;
      eq(await h.refresh_branch!(await direct(host, s, 'refresh_branch', { headSha: 'H1' })), { outcome: 'skipped:dependency_bot' }, 'a bot\'s branch is never pushed to');
      eq(f.conflicts.ops().filter((o) => o.startsWith('updateBranch')), ['updateBranch:H1'], 'one update, pinned');

      const m = await new Delivery(host, 95).open();
      applied(await m.ownerPushed('H1'), 'AWAITING_REVIEW', 'm pushed');
      applied(await m.submit({ type: 'ConflictObserved', actor: 'webhook', headSha: 'H1', mergeable: 'dirty', migrationCollision: true, maxAgentAttempts: 3 }), 'REPAIRING', 'collision');
      const fm = fakePorts(host);
      fm.github.setPr(m.repo, m.prNumber, m.live('H1'));
      await drainKernel(host, m, fm.ports);
      eq(await outcomesOf(host, m, 'renumber_migration'), ['ok:renumbered:0010_x.sql'], 'renumbered');
      eq(fm.ingest.facts.map((x) => pick(x, ['kind', 'source'])), [{ kind: 'head_observed', source: 'effect:renumber_migration' }], 'its new head goes to the funnel');
    },
  },
  {
    name: 'handlers/hand-off: a delivery the switch released before its first round gets legacy\'s first review once, only while the switch is off; a failed review gives the claim back',
    async run(host) {
      const released = async (prNumber: number, off: boolean) => {
        const s = await new Delivery(host, prNumber).open();
        if (off) await host.setKernelEnabled(s.workspaceId, false);
        ok(await host.store.releaseToLegacy(s.deliveryId), 'released');
        return s;
      };
      const a = await released(96, true);
      const f = fakePorts(host);
      f.github.setPr(a.repo, a.prNumber, a.live('H1'));
      eq(await handOffToLegacyOn(f.ports, a.deliveryId), 'review_queued', 'legacy\'s first review');
      eq(f.handOff.reviews.map((r) => pick(r, ['deliveryId', 'headSha'])), [{ deliveryId: a.deliveryId, headSha: 'H1' }], 'at the live head');
      eq(await handOffToLegacyOn(f.ports, a.deliveryId), 'already_handed_off', 'once per owner');
      await host.setKernelEnabled(a.workspaceId, true);

      const b = await released(97, false);
      eq(await handOffToLegacyOn(f.ports, b.deliveryId), 'switch_on', 'a release for any other reason was already answered');

      const c = await released(98, true);
      const fc = fakePorts(host);
      fc.github.setPr(c.repo, c.prNumber, c.live('H1'));
      fc.handOff.firstReviewFails = true;
      eq(await handOffToLegacyOn(fc.ports, c.deliveryId), 'error', 'the review failed');
      eq(fc.handOff.unclaimed, [c.ownerTaskId], 'the claim is given back');
      await host.setKernelEnabled(c.workspaceId, true);

      const k = await new Delivery(host, 99).open();
      eq(await handOffToLegacyOn(f.ports, k.deliveryId), 'not_released', 'the kernel\'s own delivery');
    },
  },
  {
    name: 'handlers/review: a closed PR sends no reviewer-escalation notice; a pre-flight finding is announced only for the head it escalated at',
    async run(host) {
      const s = await new Delivery(host, 101).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.submit({ type: 'PolicyEvidenceRecorded', actor: 'kernel', evidence: { headSha: 'H1', outcome: 'human', reason: 'drops a column', destructive: true } }), 'ESCALATED', 'a person must decide');
      const f = fakePorts(host);
      const h = kernelEffectHandlers(f.ports);
      // Past the drain, which never gates notify: the handler alone keeps an older finding quiet.
      eq(await h.notify!(await direct(host, s, 'notify', { event: 'policy_human', headSha: 'H0', reason: 'an older finding' })), { outcome: 'skipped:state_moved' }, 'a finding for an older head');
      eq(await h.notify!(await direct(host, s, 'notify')), { outcome: 'ok' }, 'the finding for the head it escalated at');
      eq(f.notify.teams.map((t) => t.body), ['drops a column'], 'one notice, for the current head');

      applied(await s.submit({ type: 'PrClosedUnmerged', actor: 'webhook', live: s.live('H1', { state: 'closed', updatedAt: '2026-01-01T05:00:00Z' }), closeCause: 'manual' }), 'CLOSED_UNMERGED', 'closed');
      // Every close owes a mission_note, and the drain never gates it.
      eq(await h.mission_note!(await direct(host, s, 'mission_note')), { outcome: 'skipped:legacy_owns' }, 'a close is not an escalation');
      eq(await h.mission_note!(await direct(host, s, 'mission_note', { reason: 'review_escalated', roundId: null })), { outcome: 'ok' }, 'a review escalation is');
      eq(f.reviews.ops().filter((o) => o.startsWith('escalated')), ['escalated'], 'one "escalated by reviewer" notice, for the escalation only');
    },
  },
  {
    name: 'handlers/review: a fix owed for a round the delivery moved on from (pushed, then approved) allocates nothing and files nothing',
    async run(host) {
      const s = await new Delivery(host, 102).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.verdict('request_changes'), 'CHANGES_REQUESTED', 'changes requested');
      const owed = await direct(host, s, 'dispatch_fix');
      const f = fakePorts(host);
      f.github.setPr(s.repo, s.prNumber, s.live('H2'));
      let reads = 0;
      const readPr = f.github.readPr.bind(f.github);
      f.github.readPr = async (repo, n) => { reads++; return readPr(repo, n); };
      const h = kernelEffectHandlers(f.ports);
      applied(await s.push('H2'), 'AWAITING_REVIEW', 'the owner pushed before the fix was filed');
      eq(await h.dispatch_fix!(owed), { outcome: 'skipped:state_moved' }, 'pushed');
      applied(await s.verdict('approve'), 'APPROVED', 'and the new head was approved');
      eq(await h.dispatch_fix!(owed), { outcome: 'skipped:state_moved' }, 'approved');
      eq({ asked: f.work.requested.length, rows: (await s.view()).attempts.filter((a) => a.family === 'review_fix').length, reads }, { asked: 0, rows: 0, reads: 0 }, 'no fix allocated (T8) or filed, decided without a live read');
    },
  },
  {
    name: 'handlers/review: a round that is no longer open (superseded, decided) gets no reviewer',
    async run(host) {
      const s = await new Delivery(host, 103).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      const r1 = await s.latestRound();
      applied(await s.push('H2'), 'AWAITING_REVIEW', 'a push supersedes round 1');
      const r2 = await s.latestRound();
      applied(await s.verdict('approve', r2.id), 'APPROVED', 'round 2 decided without its dispatch having run');
      const f = fakePorts(host);
      const h = kernelEffectHandlers(f.ports);
      eq(await h.dispatch_review!(await direct(host, s, 'dispatch_review', { roundId: r1.id })), { outcome: 'skipped:round_closed' }, 'a superseded round');
      eq(await h.dispatch_review!(await direct(host, s, 'dispatch_review', { roundId: r2.id })), { outcome: 'skipped:round_closed' }, 'a decided round');
      eq(f.work.requested.length, 0, 'no reviewer filed');
    },
  },
  {
    name: 'handlers/review: a composition\'s delta round is reviewed on its novel paths, never attested again, and carries no prior verdict for the head that verdict judged',
    async run(host) {
      const s = await new Delivery(host, 104).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      const r1 = await s.latestRound();
      applied(await s.verdict('request_changes'), 'CHANGES_REQUESTED', 'round 1 decided at H1');
      applied(await s.submit({ type: 'ReviewRequested', actor: 'human:u', headSha: 'H1', live: s.live('H1'), forced: true }), 'AWAITING_REVIEW', 'a person asks for another look at H1');
      const attestation: CompositionAttestation = {
        repoFullName: s.repo, prNumber: s.prNumber, baseSha: 'B0', aggregateHeadSha: 'H1', method: 'tree_equal', verifiedAt: MERGED_AT, verifier: 'kernel',
        constituents: [{ deliveryId: 'dx', roundId: 'rx', prNumber: 3, reviewedHeadSha: 'C1', equivalentHeadShas: [], mergedHeadSha: 'C1', landedSha: 'SQ1', landedPatchId: 'a'.repeat(64), reviewedPatchId: 'a'.repeat(64) }],
        novelDelta: { result: 'present', paths: ['src/new.ts'] },
      };
      const constituents: ConstituentEvidence[] = [{ roundId: 'rx', deliveryId: 'dx', prNumber: 3, repoFullName: s.repo, roundHeadSha: 'C1', roundStatus: 'decided', effectiveVerdict: 'approve', deliveryApprovedHeads: ['C1'] }];
      applied(await s.submit({ type: 'CompositionAttested', actor: 'kernel', attestation, constituents }), 'AWAITING_REVIEW', 'composed, with a novel delta');
      const delta = await s.latestRound();
      eq(pick(delta, ['headSha', 'kind']), { headSha: 'H1', kind: 'delta' }, 'the delta round, at the head round 1 judged');
      const f = fakePorts(host);
      f.reviews.outputs.set(r1.id, { verdict: 'request-changes', confidence: 0.9, summary: 's', feedback: 'check the caller' });
      f.reviews.attested.set(delta.id, 'ok:composition_attested');
      eq(await kernelEffectHandlers(f.ports).dispatch_review!(await direct(host, s, 'dispatch_review', { roundId: delta.id })), { outcome: 'ok' }, 'reviewed');
      eq(f.reviews.ops().filter((o) => o.startsWith('attestComposition')), [], 'the composition is not attested a second time');
      eq(f.work.filed.filter((w) => w.role === 'review').map((w) => ({ scope: w.detail?.compositionScope ?? null, prior: w.detail?.priorVerdict ?? null })),
        [{ scope: { novelDeltaPaths: ['src/new.ts'] }, prior: null }], 'scoped to the novel paths; no prior verdict at the head it judged');
    },
  },
  {
    name: 'handlers/review: push recovery owed while the fix was unpushed stops once the delivery left AWAITING_PUSH',
    async run(host) {
      const s = await new Delivery(host, 105).open();
      applied(await s.submit({ type: 'AttemptEnded', actor: 'runner', workerId: 'wk', taskId: s.ownerTaskId, outcome: 'success', localHeadSha: 'L2', commitCount: 1, live: s.live('H1') }), 'AWAITING_PUSH', 'nothing on GitHub');
      const owed = await direct(host, s, 'push_recovery');
      eq((await s.push('L2')).result, 'applied', 'the push arrived by webhook');
      ok((await s.d()).state !== 'AWAITING_PUSH', 'no longer waiting on the push');
      const f = fakePorts(host);
      f.github.setPr(s.repo, s.prNumber, s.live('L2'));
      eq(await kernelEffectHandlers(f.ports).push_recovery!(owed), { outcome: 'skipped:state_moved' }, 'nothing to recover');
      eq({ tries: await s.count('push_recovery'), facts: f.ingest.facts.length }, { tries: 1, facts: 0 }, 'no next try, no read');
    },
  },
  {
    name: 'handlers/conflict: an agent fix whose bound head moved files nothing; a bound row is never filed again, is woken again only while nobody claimed it',
    async run(host) {
      const s = await new Delivery(host, 107).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.submit({ type: 'ConflictObserved', actor: 'webhook', headSha: 'H1', mergeable: 'dirty', maxAgentAttempts: 3 }), 'REPAIRING', 'conflict');
      const f = fakePorts(host);
      const h = kernelEffectHandlers(f.ports);
      f.github.setPr(s.repo, s.prNumber, s.live('H1', { mergeableState: 'dirty' }));
      f.conflicts.refreshAnswer = { kind: 'refused', refusal: { reason: 'merge conflict', mode: 'textual' } };
      eq(await h.refresh_branch!(await direct(host, s, 'refresh_branch')), { outcome: 'ok:refused:merge conflict' }, 'refused to an agent');
      const agent = (await s.view()).attempts.find((x) => x.mode === 'agent')!;
      const fixes = () => f.work.requested.filter((w) => w.role === 'conflict_fix').length;
      const wakes = () => f.work.woken.filter((w) => w.taskId === agent.id).length;

      f.github.setPr(s.repo, s.prNumber, s.live('H2', { mergeableState: 'dirty' }));
      eq(await h.dispatch_conflict_fix!(await direct(host, s, 'dispatch_conflict_fix')), { outcome: 'skipped:head_moved' }, 'the live head is not the bound one');
      eq(f.ingest.facts.map((x) => pick(x, ['kind', 'source'])), [{ kind: 'head_observed', source: 'effect:dispatch_conflict_fix' }], 'the new head goes to the funnel');
      eq(fixes(), 0, 'no fix filed for a head that is gone');

      f.github.setPr(s.repo, s.prNumber, s.live('H1', { mergeableState: 'dirty' }));
      eq(await h.dispatch_conflict_fix!(await direct(host, s, 'dispatch_conflict_fix')), { outcome: 'ok' }, 'filed at the bound head');
      eq({ fixes: fixes(), wakes: wakes() }, { fixes: 1, wakes: 1 }, 'filed and woken');
      // A run that died between the bind and the wake: the next one wakes it (the wake coalesces), files nothing.
      eq(await h.dispatch_conflict_fix!(await direct(host, s, 'dispatch_conflict_fix')), { outcome: 'ok:task_rewoken' }, 'a redelivery while unclaimed');
      eq({ fixes: fixes(), wakes: wakes() }, { fixes: 1, wakes: 2 }, 'woken again, not filed again');
      eq((await s.submit({ type: 'FixClaimed', actor: 'runner', attemptId: agent.id, revalidation: { live: s.live('H1'), approved: false } })).result, 'applied', 'claimed');
      eq(await h.dispatch_conflict_fix!(await direct(host, s, 'dispatch_conflict_fix')), { outcome: 'ok:task_exists' }, 'a redelivery once claimed');
      eq({ fixes: fixes(), wakes: wakes() }, { fixes: 1, wakes: 2 }, 'does nothing');
    },
  },
  {
    name: 'handlers/ci: a fix bound by a run that died before waking it is woken by the next run, and never once it is claimed',
    async run(host) {
      const s = await new Delivery(host, 108).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.ciRed('H1'), 'REPAIRING', 'CI red');
      const attempt = (await s.view()).attempts.find((a) => a.family === 'ci')!;
      const f = fakePorts(host);
      f.github.setPr(s.repo, s.prNumber, s.live('H1'));
      // The earlier run: filed under the row's id and bound the row, then died before the wake.
      await f.work.file({ role: 'ci_fix', workspaceId: s.workspaceId, taskId: attempt.id, target: { repoFullName: s.repo, prNumber: s.prNumber, headSha: 'H1' }, lineage: { deliveryId: s.deliveryId, attemptId: attempt.id }, dedupeKey: `ci_fix:${attempt.id}` });
      await host.store.linkAttemptTask(attempt.id, attempt.id);
      await drainKernel(host, s, f.ports);
      eq(await outcomesOf(host, s, 'dispatch_ci_fix'), ['ok:task_rewoken'], 'the next run wakes it');
      eq({ woken: f.work.woken, asked: f.work.requested.length }, { woken: [{ taskId: attempt.id, reason: 'ci.retry' }], asked: 1 }, 'woken, not filed again');
      eq((await s.submit({ type: 'FixClaimed', actor: 'runner', attemptId: attempt.id, revalidation: { live: s.live('H1'), approved: false } })).result, 'applied', 'claimed');
      eq(await kernelEffectHandlers(f.ports).dispatch_ci_fix!(await direct(host, s, 'dispatch_ci_fix')), { outcome: 'ok:task_exists' }, 'a redelivery once claimed');
      eq(f.work.woken.length, 1, 'is not woken again');
    },
  },
  {
    name: 'handlers/review: a reviewer filed by a run that died before linking it is adopted and woken while nobody claimed it; a claimed one is adopted and left alone',
    async run(host) {
      const filedEarlier = async (s: Delivery, f: FakePorts): Promise<string> => {
        applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
        const round = await s.latestRound();
        // The earlier run: filed the round's reviewer, then died before linking or waking it.
        const filed = await f.work.file({ role: 'review', workspaceId: s.workspaceId, target: { repoFullName: s.repo, prNumber: s.prNumber, headSha: 'H1' }, lineage: { deliveryId: s.deliveryId, parentTaskId: s.ownerTaskId }, dedupeKey: `review:${round.id}` });
        return filed.taskId!;
      };

      const s = await new Delivery(host, 111).open();
      const f = fakePorts(host);
      const reviewer = await filedEarlier(s, f);
      await drainKernel(host, s, f.ports);
      eq(await outcomesOf(host, s, 'dispatch_review'), ['ok:task_rewoken'], 'the next run adopts it and wakes it');
      eq((await s.latestRound()).reviewerTaskId, reviewer, 'linked to its round');
      eq({ woken: f.work.woken, filed: f.work.filed.length }, { woken: [{ taskId: reviewer, reason: 'task.created' }], filed: 1 }, 'woken, not filed again');

      const b = await new Delivery(host, 112).open();
      const fb = fakePorts(host);
      const claimed = await filedEarlier(b, fb);
      fb.work.claimed.add(claimed);
      await drainKernel(host, b, fb.ports);
      eq(await outcomesOf(host, b, 'dispatch_review'), ['ok:adopted_live_reviewer'], 'a claimed reviewer is adopted');
      eq((await b.latestRound()).reviewerTaskId, claimed, 'linked to its round');
      eq({ woken: fb.work.woken, filed: fb.work.filed.length }, { woken: [], filed: 1 }, 'and not woken: someone has it');
    },
  },
  {
    name: 'handlers/ci: a run that dies at the wake has already owed the job log; the next run wakes the fix and owes nothing twice',
    async run(host) {
      const s = await new Delivery(host, 110).open();
      applied(await s.ownerPushed('H1'), 'AWAITING_REVIEW', 'owner pushed');
      applied(await s.ciRed('H1'), 'REPAIRING', 'CI red');
      const attempt = (await s.view()).attempts.find((a) => a.family === 'ci')!;
      const f = fakePorts(host, { work: { ci_fix: { evidence: { failedJobId: 9 } } } });
      f.github.setPr(s.repo, s.prNumber, s.live('H1'));
      const wake = f.work.wake.bind(f.work);
      let dies = true;
      f.work.wake = async (taskId, reason) => { if (dies) { dies = false; throw new Error('process died at the wake'); } return wake(taskId, reason); };
      const h = kernelEffectHandlers(f.ports);
      const owed = await direct(host, s, 'dispatch_ci_fix');
      let died = false;
      await h.dispatch_ci_fix!(owed).catch(() => { died = true; });
      ok(died, 'the first run died at the wake');
      eq((await s.view()).attempts.find((a) => a.id === attempt.id)?.taskId, attempt.id, 'after binding the row');
      eq(await s.count('capture_ci_evidence'), 1, 'the job log was already owed');
      eq(await h.dispatch_ci_fix!(owed), { outcome: 'ok:task_rewoken' }, 'the next run wakes it');
      eq({ woken: f.work.woken, evidence: await s.count('capture_ci_evidence'), asked: f.work.requested.length }, { woken: [{ taskId: attempt.id, reason: 'ci.retry' }], evidence: 1, asked: 1 }, 'woken once, owed once, filed once');
    },
  },
  {
    name: 'handlers/trunk: a trunk fix filed by a run that died before linking it is linked and woken by the next run',
    async run(host) {
      const trunk = new RecordingTrunk();
      const f = fakePorts(host, { trunk });
      const a = await new Delivery(host, 109).open();
      applied(await a.ownerPushed('H1'), 'AWAITING_REVIEW', 'a pushed');
      const i1 = host.newId();
      trunk.add({ id: i1, workspaceId: a.workspaceId, repoFullName: a.repo, baseRef: 'dev', signature: 'ci:unit', status: 'open', fixTaskId: null, affectedDeliveries: [a.deliveryId] });
      f.github.heads.set(`${a.repo}:dev`, 'B1');
      f.github.runs.set(`${a.repo}@B1`, { complete: true, failing: ['unit'] });
      applied(await a.trunkRed(i1, 'ci:unit'), 'BLOCKED_ON_TRUNK', 'a blocked');
      // The earlier run: filed the fix under the incident's id, then died before linking or waking it.
      await f.work.file({ role: 'trunk_fix', workspaceId: a.workspaceId, taskId: i1, target: { repoFullName: a.repo, baseRef: 'dev', headSha: 'B1' }, lineage: { deliveryId: a.deliveryId }, dedupeKey: `trunk_fix:${i1}` });
      await drainKernel(host, a, f.ports);
      eq(await outcomesOf(host, a, 'dispatch_trunk_fix'), ['ok:task_bound'], 'the next run binds it');
      eq({ links: trunk.links, woken: f.work.woken, filed: f.work.filed.length }, { links: [{ incidentId: i1, taskId: i1 }], woken: [{ taskId: i1, reason: 'task.created' }], filed: 1 }, 'linked and woken, filed once');
    },
  },
  {
    name: 'handlers: a port the host did not supply fails the effect loudly instead of acking it',
    async run(host) {
      const s = await new Delivery(host, 51).open();
      await s.ownerPushed('H1');
      applied(await s.submit({ type: 'PrClosedUnmerged', actor: 'webhook', live: s.live('H1', { state: 'closed', updatedAt: '2026-01-01T04:00:00Z' }), closeCause: 'manual' }), 'CLOSED_UNMERGED', 'closed');
      const f = fakePorts(host, { omit: ['lifecycle'] });
      await drainEffects(host.store, { policy: host.policy, handlers: { ...recordingHandlers([]), ...kernelEffectHandlers(f.ports) }, deliveryId: s.deliveryId, log: { log: () => {}, error: () => {} } });
      const row = (await host.effects(s.deliveryId)).find((e) => e.kind === 'scan_supersession')!;
      eq(pick(row, ['status', 'lastError']), { status: 'pending', lastError: 'scan_supersession: the host supplies no lifecycle port' }, 'backed off, naming the port');
    },
  },
  {
    name: 'decide: an unreadable recorded decision takes the default with the reason recorded, and replays the same',
    async run(host) {
      const s = await new Delivery(host).open();
      const subject = { workspaceId: s.workspaceId, deliveryId: s.deliveryId, source: 'conformance' };
      const key = decisionFactKey(s.deliveryId, 'visual_impact', 'H1');
      ok(await host.store.insertFact({ workspaceId: s.workspaceId, kind: 'decision', factKey: key, source: 'conformance', payload: { garbage: true } }), 'a malformed record');
      const first = await decideAndRecord(host.store, subject, VISUAL_IMPACT_POINT, { headSha: 'H1' }, { decide: neverAsked });
      eq(pick(first.fact, ['verdict', 'source', 'fallback', 'deciderId']), { verdict: 'review_required', source: 'default', fallback: 'invalid_record', deciderId: null }, 'the default, with why');
      eq(first.replayed, false, 'decided now');
      eq((await host.store.findFact(s.workspaceId, invalidRecordFactKey(key)))?.id, first.factId, 'recorded beside the unreadable one');
      const again = await decideAndRecord(host.store, subject, VISUAL_IMPACT_POINT, { headSha: 'H1' }, { decide: neverAsked });
      eq({ replayed: again.replayed, factId: again.factId, fallback: again.fact.fallback }, { replayed: true, factId: first.factId, fallback: 'invalid_record' }, 'a replay answers the same');
    },
  },
];

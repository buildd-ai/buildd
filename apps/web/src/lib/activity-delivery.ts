/**
 * Activity's two views over the shared delivery projection
 * (lib/delivery-projection.ts). Pure; the page loads rows and ActivityView
 * renders what this returns.
 *
 *   Now     — live deliveries grouped by mission, standalone last. A mission
 *             task's chip IS the `MissionDelivery` task projection Home and
 *             Missions read, so the three surfaces cannot disagree.
 *   History — one episode per delivery, newest first. Retries, review runs and
 *             repair workers fold into their deliverable's episode as steps;
 *             they never get rows of their own.
 *
 * Design: docs/prototypes/cross-surface-delivery (`#activity`, `#activity/history`).
 */
import {
  bindVerdict, projectMissionDelivery, DELIVERY_KIND,
  type BoundVerdict, type DeliveryKind, type DeliveryTone, type DeliveryWorker,
  type MissionDelivery, type MissionTaskRules, type ReviewEvidence, type TaskDelivery,
} from './delivery-projection';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';

// ── Input ───────────────────────────────────────────────────────────────────

export interface ActivityWorker extends DeliveryWorker {
  name?: string | null;
  prNumber?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string | null;
  /** The last commit this worker pushed: the PR head after its run. */
  lastCommitSha?: string | null;
}

/** A task row as Activity loads it: roots and their attempts alike. */
export interface ActivityTaskInput {
  id: string;
  title: string;
  status: string;
  mode?: string | null;
  taskClass?: string | null;
  parentTaskId?: string | null;
  missionId: string | null;
  missionTitle?: string | null;
  createdAt: string;
  updatedAt: string;
  workers: readonly ActivityWorker[];
  /** A reviewer run's verdict and the head it read (context.headSha). */
  review?: { verdict: ReviewEvidence['verdict']; headSha: string | null } | null;
  /** The open question, when an agent is waiting on a person. */
  waitingPrompt?: string | null;
}

// ── Shared shapes ───────────────────────────────────────────────────────────

export type RepairReason = 'ci' | 'conflict' | 'review';

export interface Gate {
  name: string;
  glyph: string;
  tone: DeliveryTone;
  result: string;
  /** Recorded but not counted: a superseded head or a stale verdict. */
  void: boolean;
  why: string | null;
}

export type EvidenceEntry =
  | { type: 'revision'; sha: string | null; current: boolean; round: number; gates: Gate[] }
  | { type: 'repair'; round: number; reason: RepairReason | null; status: 'running' | 'pushed' | 'failed' | 'queued'; sha: string | null };

export interface NowRow {
  id: string;
  title: string;
  href: string;
  delivery: TaskDelivery;
  live: boolean;
  runnerName: string | null;
  prNumber: number | null;
  /** One sentence: what is happening to it right now. */
  line: string;
  /** Epoch ms of its latest movement. */
  updatedAt: number;
  /** Revision cards and repairs, newest first. Empty when there is nothing to expand. */
  evidence: EvidenceEntry[];
}

export interface NowGroup {
  /** Mission id, or null for standalone work. */
  missionId: string | null;
  title: string;
  href: string | null;
  /** The mission's chip, landed n/m and next milestone, from `MissionDelivery`. */
  kind: DeliveryKind | null;
  landed: number;
  total: number;
  next: string | null;
  rows: NowRow[];
  /** Waiting rows past the cap, summarised as a count. */
  moreWaiting: number;
}

export interface ActivityNow {
  groups: NowGroup[];
  /** Deliveries past "waiting": building, in audit, repairing, landing, or stuck. */
  inMotion: number;
  liveAgents: number;
}

export interface EpisodeStep {
  at: number;
  text: string;
  tone: DeliveryTone;
  void: boolean;
}

export interface Episode {
  id: string;
  title: string;
  href: string;
  missionId: string | null;
  missionTitle: string | null;
  kind: DeliveryKind;
  repairRounds: number;
  /** Epoch ms of the newest step: the episode's place in the list. */
  at: number;
  /** Chronological, in the order they happened. Never re-sorted by kind. */
  steps: EpisodeStep[];
}

export interface LatestTask { id: string; title: string; href: string; at: number }

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const VERDICTS = new Set(['approve', 'request-changes', 'escalate']);

/**
 * A reviewer run's verdict and the head it read. Same fields
 * `derivePrReviewStatus` reads: the server's effective verdict wins over the
 * model's own, and the head is the one the round was dispatched against.
 */
export function reviewOf(result: unknown, context: unknown): { verdict: ReviewEvidence['verdict']; headSha: string | null } {
  const r = record(result);
  const raw = [r.effectiveVerdict, record(r.structuredOutput).verdict].find(v => typeof v === 'string' && v.length > 0) as string | undefined;
  const head = record(context).headSha;
  return {
    verdict: raw && VERDICTS.has(raw) ? (raw as ReviewEvidence['verdict']) : null,
    headSha: typeof head === 'string' && head.length > 0 ? head : null,
  };
}

// ── Classification ──────────────────────────────────────────────────────────

const LIVE: ReadonlySet<string> = new Set(LIVE_WORKER_STATUSES);
const ms = (v: string | null | undefined): number | null => (v ? new Date(v).getTime() : null);
const short = (sha: string | null | undefined) => (sha ? sha.trim().slice(0, 7) : null);
const taskHref = (id: string) => `/app/tasks/${id}`;

/** What a repair attempt was dispatched for, from its title (`[builder · after CI #1]`). */
export function repairReasonOf(title: string): RepairReason | null {
  if (/after\s+(?:ci\b|ci\s|check)/i.test(title) || /^\[ci retry/i.test(title)) return 'ci';
  if (/after\s+conflict|^\[conflict retry/i.test(title)) return 'conflict';
  if (/after\s+review|^\[reviewer\s+retry/i.test(title)) return 'review';
  return null;
}

const REPAIR_FOR: Record<RepairReason, string> = { ci: 'CI failed', conflict: 'conflict with base', review: 'review notes' };

interface Delivery {
  root: ActivityTaskInput;
  reviews: ActivityTaskInput[];
  repairs: ActivityTaskInput[];
  /** Root and every attempt's workers. */
  workers: ActivityWorker[];
}

/**
 * Fold attempts into the deliverable they belong to. An attempt whose parent
 * is not loaded stands as its own delivery rather than vanishing.
 */
function foldDeliveries(tasks: readonly ActivityTaskInput[], rules: MissionTaskRules): Delivery[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const kids = new Map<string, ActivityTaskInput[]>();
  const roots: ActivityTaskInput[] = [];
  for (const t of tasks) {
    if (rules.isAttempt(t) && t.parentTaskId && byId.has(t.parentTaskId)) kids.set(t.parentTaskId, [...(kids.get(t.parentTaskId) ?? []), t]);
    else roots.push(t);
  }
  const byCreated = (a: ActivityTaskInput, b: ActivityTaskInput) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  return roots.map(root => {
    const attempts = [...(kids.get(root.id) ?? [])].sort(byCreated);
    const isReview = (t: ActivityTaskInput) => {
      const type = rules.deriveTaskType(t);
      return type === 'review' || type === 'review-retry';
    };
    return {
      root,
      reviews: attempts.filter(isReview),
      repairs: attempts.filter(t => !isReview(t)),
      workers: [...root.workers, ...attempts.flatMap(a => a.workers)],
    };
  });
}

/**
 * A standalone delivery's projection, through the same per-task rules the
 * mission projection applies (attempt folding, repair count, best status):
 * a one-task mission. No second derivation exists to drift.
 */
function projectStandalone(d: Delivery, rules: MissionTaskRules): TaskDelivery {
  // The root stands as the deliverable even when it is an attempt whose parent is not loaded.
  const root = { ...d.root, parentTaskId: null, taskClass: 'work' };
  const rows = [root, ...d.reviews, ...d.repairs].map(t => ({ ...t, dependsOn: undefined, missionId: undefined }));
  const m = projectMissionDelivery({ id: d.root.id, title: d.root.title, status: 'active', href: '', tasks: rows }, rules);
  return m.tasks.find(t => t.id === d.root.id)!.delivery;
}

/** The PR a delivery is about, and the head it is on now. */
function prOf(d: Delivery) {
  const owner = d.workers.find(w => w.prUrl && (w.mergedAt || w.supersededByPrNumber)) ?? d.workers.find(w => w.prUrl) ?? null;
  // A repair's push moves the head past the owner's: the last repair that pushed wins.
  const head = [...d.repairs].reverse().map(pushedBy).find(Boolean) ?? pushedBy(d.root);
  return { owner, head };
}

function latestAt(d: Delivery): number {
  const times = [d.root, ...d.reviews, ...d.repairs].flatMap(t => [ms(t.updatedAt), ...t.workers.map(w => ms(w.updatedAt ?? w.completedAt ?? w.startedAt))]);
  return Math.max(0, ...times.filter((n): n is number => n != null));
}

// ── Evidence: revision cards and repairs ────────────────────────────────────

const VERDICT_GATE: Record<BoundVerdict, Omit<Gate, 'name' | 'why' | 'void'>> = {
  passed: { glyph: '✓', tone: 'success', result: 'passed' },
  changes_requested: { glyph: '✕', tone: 'error', result: 'changes requested' },
  escalated: { glyph: '!', tone: 'ink', result: 'asks a person' },
  stale: { glyph: '✓', tone: 'muted', result: 'approved' },
  unbound: { glyph: '?', tone: 'muted', result: 'verdict without a commit' },
  pending: { glyph: '◐', tone: 'info', result: 'reviewing' },
  unavailable: { glyph: '⊘', tone: 'warning', result: 'could not run' },
  none: { glyph: '–', tone: 'muted', result: 'not run' },
};

function ciGate(status: string | null | undefined): Gate | null {
  const g = (glyph: string, tone: DeliveryTone, result: string): Gate => ({ name: 'CI', glyph, tone, result, void: false, why: null });
  switch (status) {
    case 'ci_green': return g('✓', 'success', 'passed');
    case 'ci_failed': return g('✕', 'error', 'failed');
    case 'ci_running': case 'pr_open': return g('◐', 'info', 'running');
    case 'conflict': return g('✕', 'error', 'conflicts with its base');
    default: return null;
  }
}

function reviewState(r: ActivityTaskInput): ReviewEvidence {
  const settled = r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled';
  const state = r.status === 'pending' ? 'queued' : settled ? (r.review?.verdict ? null : 'review_failed') : 'reviewing';
  return { verdict: r.review?.verdict ?? null, headSha: r.review?.headSha ?? null, state };
}

const sameHead = (a: string | null | undefined, b: string | null | undefined) => {
  const x = a?.trim().toLowerCase();
  const y = b?.trim().toLowerCase();
  return !!x && !!y && x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

/** The last commit a task's workers pushed, newest run first. */
function pushedBy(t: ActivityTaskInput): string | null {
  return [...t.workers].sort((a, b) => (ms(b.startedAt) ?? 0) - (ms(a.startedAt) ?? 0)).find(w => w.lastCommitSha)?.lastCommitSha ?? null;
}

function reviewGate(r: ActivityTaskInput, name: string, current: boolean, currentSha: string | null): Gate {
  const bound = bindVerdict(reviewState(r), currentSha);
  const base = VERDICT_GATE[bound];
  if (current) {
    return {
      name, ...base, void: bound === 'stale',
      why: bound === 'stale' ? `Stale head: this verdict was for ${short(r.review?.headSha)}, the PR is now at ${short(currentSha)}. Recorded, not counted.`
        : bound === 'unbound' ? 'No commit recorded for this verdict, so it cannot count as passed.' : null,
    };
  }
  // An older head. Changes requested there is why a repair followed; anything
  // else on it no longer describes the code.
  if (r.review?.verdict === 'request-changes') return { name, ...VERDICT_GATE.changes_requested, void: false, why: 'A repair followed.' };
  if (r.review?.verdict === 'approve') return { name, ...VERDICT_GATE.stale, void: true, why: `Stale head: this verdict was for ${short(r.review.headSha)}, the PR is now at ${short(currentSha)}. Recorded, not counted.` };
  return { name, ...base, tone: 'muted', void: true, why: 'Superseded by a later head.' };
}

/**
 * Revision-scoped audit evidence: one card per head, newest first, so the
 * current head leads; the repair that moved the head sits between two cards.
 * A verdict on an older head is shown struck through and never counted.
 */
function buildEvidence(d: Delivery): EvidenceEntry[] {
  // Verdicts bind to the head a worker recorded pushing, never to the head a
  // review names about itself: an unknown head reads as unbound, not passed.
  const { owner, head: currentSha } = prOf(d);
  if (!owner && d.reviews.length === 0 && d.repairs.length === 0) return [];

  // Chronological: the owner's head, then each repair and the head it pushed.
  const firstHead = pushedBy(d.root) ?? d.reviews.find(r => r.review?.headSha)?.review?.headSha ?? null;
  type Slot = { type: 'head'; sha: string | null } | { type: 'repair'; task: ActivityTaskInput; index: number; sha: string | null };
  const slots: Slot[] = [{ type: 'head', sha: firstHead }];
  d.repairs.forEach((task, index) => {
    const sha = pushedBy(task);
    slots.push({ type: 'repair', task, index, sha });
    const lastHead = [...slots].reverse().find(s => s.type === 'head')!;
    if (sha && !sameHead(sha, lastHead.sha)) slots.push({ type: 'head', sha });
  });
  const headSlots = slots.filter((s): s is Extract<Slot, { type: 'head' }> => s.type === 'head');
  const placed = new Set<string>();
  const reviewsFor = (sha: string | null, current: boolean) => d.reviews.filter(r => {
    if (placed.has(r.id)) return false;
    // The current card also takes any verdict no recorded head matches.
    const hit = sameHead(sha, r.review?.headSha) || (current && !headSlots.some(h => sameHead(h.sha, r.review?.headSha)));
    if (hit) placed.add(r.id);
    return hit;
  });

  let round = 0;
  const out: EvidenceEntry[] = [];
  slots.forEach((s, i) => {
    if (s.type === 'repair') {
      const live = s.task.workers.some(w => LIVE.has(w.status));
      const status = live ? 'running' : s.sha ? 'pushed' : s.task.status === 'failed' || s.task.status === 'cancelled' ? 'failed' : 'queued';
      out.push({ type: 'repair', round: s.index + 1, reason: repairReasonOf(s.task.title), status, sha: short(s.sha) });
      return;
    }
    round += 1;
    const current = s === headSlots[headSlots.length - 1];
    const rs = reviewsFor(s.sha, current);
    const gates = rs.map((r, k) => reviewGate(r, rs.length > 1 ? `Code review ${k + 1}` : 'Code review', current, currentSha));
    if (current) {
      const ci = ciGate(owner?.prLifecycleStatus);
      if (ci) gates.push(ci);
      if (rs.length === 0) gates.unshift({ name: 'Code review', ...VERDICT_GATE.none, void: false, why: null });
    } else {
      // A CI repair after this head says CI failed on it; superseded now.
      const next = slots[i + 1];
      if (next?.type === 'repair' && repairReasonOf(next.task.title) === 'ci') {
        gates.push({ name: 'CI', glyph: '✕', tone: 'muted', result: 'failed', void: true, why: `Superseded: CI on ${short(s.sha) ?? 'this head'} does not count for a later head.` });
      }
    }
    out.push({ type: 'revision', sha: short(s.sha), current, round, gates });
  });
  return out.reverse();
}

// ── Now ─────────────────────────────────────────────────────────────────────

/** Attention order, the same one the mission projection uses to pick its chip. */
const ATTENTION: readonly DeliveryKind[] = ['needs', 'notlanded', 'unavailable', 'repair', 'audit', 'landing', 'build', 'waiting', 'held', 'planning', 'landed'];
const rank = (k: DeliveryKind | null) => (k ? ATTENTION.indexOf(k) : ATTENTION.length);
const IN_MOTION: ReadonlySet<DeliveryKind> = new Set(['build', 'audit', 'repair', 'landing', 'unavailable', 'needs', 'notlanded']);
/** A delivery that ended without landing stays in Now this long, then lives in History. */
export const NOT_LANDED_NOW_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Waiting rows shown per group before they fold into a count. */
export const WAITING_ROWS_PER_GROUP = 2;

function lineFor(d: Delivery, delivery: TaskDelivery, prNumber: number | null, runner: string | null): string {
  const pr = prNumber ? `PR #${prNumber}` : 'The PR';
  const rounds = delivery.repairRounds;
  switch (delivery.kind) {
    case 'build': return runner ? `An agent is building it on ${runner}.` : 'An agent is building it.';
    case 'audit': return delivery.verdict === 'stale' ? `${pr} is open. A verdict arrived for an older head; review runs again on the latest.` : `${pr} is open; review and CI have not both passed on its latest revision.`;
    case 'repair': {
      const why = delivery.repairReason ? { ci: 'CI failed', conflict: 'The branch conflicts with its base', review: 'Review asked for changes' }[delivery.repairReason] : 'An audit failed';
      return `${why}. An automatic fix ${d.workers.some(w => LIVE.has(w.status)) ? 'is running' : 'is queued'}${rounds > 0 ? ` (round ${rounds})` : ''}.`;
    }
    case 'landing': return 'Approved and green on its latest revision. Merging.';
    case 'unavailable': return 'The audit could not run. It retries on its own.';
    case 'needs': return d.root.waitingPrompt?.trim() || 'Waiting on a decision.';
    case 'notlanded': return prNumber ? `Finished, but ${pr} closed without merging.` : 'Stopped without landing.';
    case 'waiting': return delivery.waitingOn === 'dependency' ? 'Starts when the work it depends on lands.' : 'Starts when a slot frees up.';
    default: return DELIVERY_KIND[delivery.kind].label;
  }
}

function toRow(d: Delivery, delivery: TaskDelivery): NowRow {
  const { owner } = prOf(d);
  const liveWorker = d.workers.find(w => LIVE.has(w.status)) ?? null;
  const runnerName = liveWorker?.name ?? null;
  const prNumber = owner?.prNumber ?? null;
  return {
    id: d.root.id,
    title: d.root.title,
    href: taskHref(d.root.id),
    delivery,
    live: !!liveWorker,
    runnerName,
    prNumber,
    line: lineFor(d, delivery, prNumber, runnerName),
    updatedAt: latestAt(d),
    evidence: buildEvidence(d),
  };
}

export function buildActivityNow(input: {
  tasks: readonly ActivityTaskInput[];
  /** The projection Missions and Home read, for every mission in view. */
  missions: readonly MissionDelivery[];
  rules: MissionTaskRules;
  now: number;
}): ActivityNow {
  const missionById = new Map(input.missions.map(m => [m.id, m]));
  const groups = new Map<string | null, { rows: NowRow[]; title: string | null }>();
  let liveAgents = 0;

  for (const d of foldDeliveries(input.tasks, input.rules)) {
    liveAgents += d.workers.filter(w => LIVE.has(w.status)).length;
    if (d.root.status === 'cancelled') continue;
    const mission = d.root.missionId ? missionById.get(d.root.missionId) : undefined;
    // A mission task reads the mission's own task projection, never a second one.
    const delivery = mission?.tasks.find(t => t.id === d.root.id)?.delivery ?? projectStandalone(d, input.rules);
    if (!delivery.open || delivery.kind === 'landed') continue;
    if (delivery.kind === 'notlanded' && input.now - latestAt(d) > NOT_LANDED_NOW_WINDOW_MS) continue;
    const key = d.root.missionId;
    const g = groups.get(key) ?? { rows: [], title: d.root.missionTitle ?? null };
    g.rows.push(toRow(d, delivery));
    groups.set(key, g);
  }

  const byAttention = (a: NowRow, b: NowRow) => rank(a.delivery.kind) - rank(b.delivery.kind) || a.id.localeCompare(b.id);
  const out: NowGroup[] = [...groups.entries()].map(([missionId, g]) => {
    const m = missionId ? missionById.get(missionId) : undefined;
    const sorted = g.rows.sort(byAttention);
    const moving = sorted.filter(r => r.delivery.kind !== 'waiting');
    const waiting = sorted.filter(r => r.delivery.kind === 'waiting');
    return {
      missionId,
      title: missionId ? (m?.title ?? g.title ?? 'Untitled mission') : 'Standalone',
      href: missionId ? `/app/missions/${missionId}` : null,
      kind: m?.kind ?? null,
      landed: m?.landed ?? 0,
      total: m?.total ?? 0,
      next: m?.next ?? null,
      rows: [...moving, ...waiting.slice(0, WAITING_ROWS_PER_GROUP)],
      moreWaiting: Math.max(0, waiting.length - WAITING_ROWS_PER_GROUP),
    };
  });
  // Missions by their chip's attention, then id: an order that only changes when a state does.
  out.sort((a, b) => {
    if ((a.missionId == null) !== (b.missionId == null)) return a.missionId == null ? 1 : -1;
    const ka = a.kind ?? a.rows[0]?.delivery.kind ?? null;
    const kb = b.kind ?? b.rows[0]?.delivery.kind ?? null;
    return rank(ka) - rank(kb) || String(a.missionId).localeCompare(String(b.missionId));
  });

  const inMotion = out.reduce((n, g) => n + g.rows.filter(r => IN_MOTION.has(r.delivery.kind)).length, 0);
  return { groups: out, inMotion, liveAgents };
}

// ── History ─────────────────────────────────────────────────────────────────

function stepsFor(d: Delivery, delivery: TaskDelivery): EpisodeStep[] {
  const raw: Array<EpisodeStep & { seq: number }> = [];
  const add = (at: number | null, text: string, tone: DeliveryTone, isVoid = false) => {
    if (at != null) raw.push({ at, text, tone, void: isVoid, seq: raw.length });
  };
  const { owner, head } = prOf(d);
  const rootWorkers = [...d.root.workers].sort((a, b) => (ms(a.startedAt) ?? 0) - (ms(b.startedAt) ?? 0));
  const first = rootWorkers[0];
  if (first) add(ms(first.startedAt), 'Build started', 'ink');
  for (const w of rootWorkers) {
    if (w.prUrl) {
      add(ms(w.completedAt ?? w.updatedAt), `Built; PR${w.prNumber ? ` #${w.prNumber}` : ''} opened${w.lastCommitSha ? ` at ${short(w.lastCommitSha)}` : ''}`, 'ink');
      break;
    }
  }
  d.repairs.forEach((r, i) => {
    const reason = repairReasonOf(r.title);
    add(ms(r.createdAt), `Automatic repair ${i + 1}${reason ? `: ${REPAIR_FOR[reason]}` : ''}`, 'warning');
    const pushed = [...r.workers].reverse().find(w => w.lastCommitSha);
    if (pushed) add(ms(pushed.completedAt ?? pushed.updatedAt), `New head ${short(pushed.lastCommitSha)}; earlier verdicts superseded`, 'info');
    else if (r.status === 'failed') add(ms(r.updatedAt), `Repair ${i + 1} failed`, 'error');
  });
  for (const r of d.reviews) {
    const bound = bindVerdict(reviewState(r), head);
    const at = ms(r.workers[0]?.completedAt ?? r.updatedAt);
    const on = r.review?.headSha ? ` on ${short(r.review.headSha)}` : '';
    if (r.review?.verdict === 'approve') add(at, bound === 'stale' ? `Late approval${on}: stale head, not counted` : `Review approved${on}`, bound === 'stale' ? 'muted' : 'success', bound === 'stale');
    else if (r.review?.verdict === 'request-changes') add(at, `Review requested changes${on}`, 'error');
    else if (r.review?.verdict === 'escalate') add(at, 'Review asked a person to decide', 'ink');
    else if (r.status === 'completed' || r.status === 'failed') add(at, 'Review could not run', 'warning');
  }
  if (owner?.mergedAt) add(ms(owner.mergedAt as string), 'Landed', 'success');
  else if (owner?.supersededByPrNumber) add(ms(owner.updatedAt), `Landed via PR #${owner.supersededByPrNumber}`, 'success');
  else if (delivery.kind === 'notlanded') {
    add(ms(owner?.updatedAt ?? d.root.updatedAt), owner?.prUrl ? (owner.abandonedAt ? 'PR closed and set aside' : 'PR closed without merging') : 'Stopped without landing', 'error');
  } else if (!owner && d.root.status === 'completed') add(ms(d.root.updatedAt), 'Finished; nothing to merge', 'success');
  if (d.root.status === 'cancelled') add(ms(d.root.updatedAt), 'Cancelled', 'muted');
  if (raw.length === 0) add(ms(d.root.createdAt), 'Queued', 'muted');
  return raw.sort((a, b) => a.at - b.at || a.seq - b.seq).map(({ seq: _seq, ...s }) => s);
}

export function buildActivityHistory(input: {
  tasks: readonly ActivityTaskInput[];
  missions: readonly MissionDelivery[];
  rules: MissionTaskRules;
}): Episode[] {
  const missionById = new Map(input.missions.map(m => [m.id, m]));
  return foldDeliveries(input.tasks, input.rules)
    .map(d => {
      const mission = d.root.missionId ? missionById.get(d.root.missionId) : undefined;
      const delivery = mission?.tasks.find(t => t.id === d.root.id)?.delivery ?? projectStandalone(d, input.rules);
      const steps = stepsFor(d, delivery);
      return {
        id: d.root.id,
        title: d.root.title,
        href: taskHref(d.root.id),
        missionId: d.root.missionId,
        missionTitle: mission?.title ?? d.root.missionTitle ?? null,
        kind: d.root.status === 'cancelled' ? 'notlanded' as const : delivery.kind,
        repairRounds: delivery.repairRounds,
        at: steps[steps.length - 1]?.at ?? 0,
        steps,
      };
    })
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

/** The task touched most recently: one tap from the top of either view. */
export function latestTask(tasks: readonly ActivityTaskInput[], rules: MissionTaskRules): LatestTask | null {
  let best: LatestTask | null = null;
  for (const d of foldDeliveries(tasks, rules)) {
    const at = latestAt(d);
    if (!best || at > best.at || (at === best.at && d.root.id < best.id)) best = { id: d.root.id, title: d.root.title, href: taskHref(d.root.id), at };
  }
  return best;
}

// ── Filters (client) ────────────────────────────────────────────────────────

export type ActivityScope = 'all' | 'missions' | 'tasks';
export type ActivityOutcome = 'any' | 'landed' | 'retries' | 'exceptions';

const EXCEPTION: ReadonlySet<DeliveryKind> = new Set(['notlanded', 'unavailable', 'needs']);

const inScope = (missionId: string | null, scope: ActivityScope) =>
  scope === 'all' || (scope === 'missions' ? missionId != null : missionId == null);

export function filterNow(now: ActivityNow, f: { scope: ActivityScope; outcome: ActivityOutcome }): NowGroup[] {
  return now.groups
    .filter(g => inScope(g.missionId, f.scope))
    .map(g => {
      if (f.outcome === 'any') return g;
      const rows = g.rows.filter(r => (f.outcome === 'retries' ? r.delivery.repairRounds > 0 : f.outcome === 'exceptions' ? EXCEPTION.has(r.delivery.kind) : r.delivery.kind === 'landed'));
      return { ...g, rows, moreWaiting: 0 };
    })
    .filter(g => g.rows.length > 0);
}

export function filterEpisodes(episodes: readonly Episode[], f: { scope: ActivityScope; outcome: ActivityOutcome; missionId?: string | null }): Episode[] {
  return episodes.filter(e =>
    inScope(e.missionId, f.scope)
    && (!f.missionId || e.missionId === f.missionId)
    && (f.outcome === 'any'
      || (f.outcome === 'landed' && e.kind === 'landed')
      || (f.outcome === 'retries' && e.repairRounds > 0)
      || (f.outcome === 'exceptions' && EXCEPTION.has(e.kind))));
}

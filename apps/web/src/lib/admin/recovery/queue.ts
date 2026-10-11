/**
 * The platform recovery queue (operator-recovery spec §3, §5, §7.1, §10).
 *
 * `buildRecoveryPanel` turns rows the loader read in a handful of batched
 * queries (`loadRecoveryQueue` in ../data.ts) into the `recovery` panel:
 * incidents grouped into causes by cause key, each cause ranked, its impact
 * named, its blocked work deduplicated across causes, its evidence graded.
 * `buildRecoveryCauseDetail` is the drill-down over the same facts.
 *
 * State, owner and sentence come from the stored FIR assessment through
 * `projectIncident` (R5). Nothing here writes, and nothing reads the clock
 * except through `facts.now`.
 *
 * Pure.
 */
import type {
  FailureIncident,
  FailureIncidentSeverity,
  OperatorMeasured,
  OperatorNamedRef,
  OperatorRecoveryState,
  RecentlyRecoveredCause,
  RecoveryAttemptOutcome,
  RecoveryCauseDetail,
  RecoveryCauseRow,
  RecoveryEvidenceInput,
  RecoveryFilter,
  RecoveryPanel,
  RecoveryRate,
  RecoveryTelemetry,
} from '@buildd/shared';
import { createHash } from 'node:crypto';
import { effectiveCauseKey, causeCodeOf } from '@/lib/failure-incident-cause-key';
import type { RecoveryAttemptDetail, SentinelLastRun } from '@/lib/failure-incident-recovery-events';
import { computeBlockedWork, unblocksOf, type BlockEpisode, type CausePreference } from './blocked-work';
import { projectIncident, worstState, type IncidentProjection } from './projection';
import { componentsOf, compareBaseline, ORQ_RANK_VERSION, ORQ_RANK_WEIGHTS, rankCauses, scoreOf, tierOf, type Leverage, type RankInput } from './rank';

// ── Inputs ──────────────────────────────────────────────────────────────────

export type QueueIncident = FailureIncident & { version: number };

export interface QueueTask { id: string; title: string; status: string; workspaceId: string; missionId: string | null }
export interface QueueWorker { taskId: string; createdAt: string; status: string; costUsd: number | null; costBasis: string | null }
export interface QueueAttemptRow { occurredAt: string; outcome: string; detail: RecoveryAttemptDetail }

export interface QueueFacts {
  now: string;
  window: '24h' | '7d' | '30d';
  /** No team or workspace narrowing: platform-scoped incidents (no workspace) are included. */
  platformWide: boolean;
  incidents: QueueIncident[];
  workspaces: Map<string, { id: string; name: string; teamId: string | null }>;
  teams: Map<string, { id: string; name: string }>;
  /** Null: the task read failed. */
  tasks: Map<string, QueueTask> | null;
  missions: Map<string, { id: string; title: string; workspaceId: string | null }>;
  /** Workers of subject and fix tasks. Null: the read failed. */
  workers: QueueWorker[] | null;
  /** `${workspaceId}:${prNumber}` → the task that owns the PR. */
  prTasks: Map<string, string>;
  /** Fix task id → its newest PR. */
  fixPrs: Map<string, { number: number; url: string; state: string; workspaceId: string }>;
  /** gate `incident_recovery` rows. Null: the read failed. */
  attempts: QueueAttemptRow[] | null;
  lastRun: SentinelLastRun | null;
  /** Incident ids with a stored person verdict. Null: the read failed. */
  personVerdicts: Set<string> | null;
  automation: RecoveryPanel['automation'];
}

export const MAX_QUEUE_ROWS = 50;
export const MAX_TASK_SAMPLE = 10;
export const FRESH_MINUTES = 60;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW_MS = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY } as const;

const SEVERITY_RANK: Record<FailureIncidentSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
/** The sentinel's own health incident (failure-pattern-sweep `SELF_HEALTH_SIGNATURE`). */
export const SELF_HEALTH_SIGNATURE = 'repeated_failure|ws=none|sentinel_self_health_degraded';
/** Cause codes whose fix is code: no repair Buildd runs can clear them. */
const CODE_FIX_CAUSES = new Set(['path_overlap.subject_exempt_violated', 'path_overlap.spurious_overlap']);
const TERMINAL_TASK = new Set(['completed', 'failed', 'cancelled']);
const FAILED_WORKER = new Set(['failed', 'error']);

const ms = (iso: string) => Date.parse(iso);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Members and episodes ────────────────────────────────────────────────────

interface Member {
  incident: QueueIncident;
  projection: IncidentProjection;
  causeKey: string;
  grouping: { source: 'rule' | 'model' | 'operator'; decisionId: string | null; confidence: number | null };
  subjects: string[];
  episodeStart: string;
  open: boolean;
}

function subjectTaskIds(i: QueueIncident): string[] {
  const r = i.recovery;
  const fromRecovery = r?.subjects?.filter(s => s.kind === 'task').map(s => s.id) ?? [];
  return [...new Set(fromRecovery.length ? fromRecovery : i.affectedRefs.taskIds)];
}

function toMember(i: QueueIncident): Member {
  const g = effectiveCauseKey(i);
  return {
    incident: i,
    projection: projectIncident(i),
    causeKey: g.key,
    grouping: { source: g.source, decisionId: g.decisionId, confidence: g.confidence },
    subjects: subjectTaskIds(i),
    episodeStart: i.recovery?.firstSeenAt ?? i.firstSeenAt,
    open: i.status !== 'resolved',
  };
}

function workersByTask(facts: QueueFacts): Map<string, QueueWorker[]> {
  const out = new Map<string, QueueWorker[]>();
  for (const w of facts.workers ?? []) {
    const list = out.get(w.taskId) ?? [];
    list.push(w);
    out.set(w.taskId, list);
  }
  return out;
}

function blockerTaskOf(i: QueueIncident, facts: QueueFacts): string | null {
  for (const b of i.recovery?.blockers ?? []) {
    if (b.kind === 'task') return b.id;
    if (b.kind === 'pr' && i.workspaceId) {
      const t = facts.prTasks.get(`${i.workspaceId}:${b.id}`);
      if (t) return t;
    }
  }
  return null;
}

/** §5.3 step 1: one interval per (member, subject), ended by the episode's end or the subject's first progress. */
function episodesOf(members: Member[], facts: QueueFacts, byTask: Map<string, QueueWorker[]>): Array<BlockEpisode & { member: Member }> {
  const out: Array<BlockEpisode & { member: Member }> = [];
  for (const m of members) {
    const i = m.incident;
    const startMs = ms(m.episodeStart);
    const endedAt = !m.open ? (i.resolvedAt ?? i.recovery?.observation.observedAt ?? null) : null;
    const blockerTaskId = blockerTaskOf(i, facts);
    for (const taskId of m.subjects) {
      const progress = (byTask.get(taskId) ?? []).map(w => ms(w.createdAt)).filter(t => t > startMs).sort((a, b) => a - b)[0];
      const ends = [endedAt ? ms(endedAt) : null, progress ?? null].filter((x): x is number => x !== null);
      out.push({
        member: m,
        causeKey: m.causeKey,
        subjectTaskId: taskId,
        blockerTaskId: blockerTaskId === taskId ? null : blockerTaskId,
        startMs,
        endMs: ends.length ? Math.min(...ends) : null,
        cycle: causeCodeOf(i) === 'path_overlap.cycle',
      });
    }
  }
  return out;
}

// ── Per-cause facts ─────────────────────────────────────────────────────────

interface Cause {
  key: string;
  members: Member[];
  lead: Member;
  open: boolean;
}

function leadOf(members: Member[]): Member {
  const pool = members.some(m => m.open) ? members.filter(m => m.open) : members;
  return [...pool].sort((a, b) =>
    SEVERITY_RANK[b.incident.severity] - SEVERITY_RANK[a.incident.severity]
    || (a.incident.firstSeenAt < b.incident.firstSeenAt ? -1 : a.incident.firstSeenAt > b.incident.firstSeenAt ? 1 : 0)
    || (a.incident.id < b.incident.id ? -1 : 1))[0];
}

function groupCauses(members: Member[]): Cause[] {
  const byKey = new Map<string, Member[]>();
  for (const m of members) byKey.set(m.causeKey, [...(byKey.get(m.causeKey) ?? []), m]);
  return [...byKey.entries()].map(([key, ms_]) => ({ key, members: ms_, lead: leadOf(ms_), open: ms_.some(m => m.open) }));
}

export function causeRevision(members: ReadonlyArray<{ incident: { id: string; version: number } }>): string {
  const pairs = members.map(m => `${m.incident.id}:${m.incident.version}`).sort().join(',');
  return createHash('sha256').update(pairs).digest('hex').slice(0, 16);
}

interface AttemptTally { total: number; succeeded: number; failed: number; noEffect: number; inFlight: number }

export function attemptOutcome(a: QueueAttemptRow): RecoveryAttemptOutcome {
  if (a.outcome === 'rejected') return 'failed';
  if (a.outcome === 'shadow') return 'refused';
  const passed = a.detail.verify?.passed;
  return passed === true ? 'progressed' : passed === false ? 'no_effect' : 'in_flight';
}

function tallyAttempts(rows: QueueAttemptRow[]): AttemptTally {
  const t: AttemptTally = { total: 0, succeeded: 0, failed: 0, noEffect: 0, inFlight: 0 };
  for (const r of rows) {
    t.total++;
    const o = attemptOutcome(r);
    if (o === 'progressed') t.succeeded++;
    else if (o === 'failed') t.failed++;
    else if (o === 'no_effect') t.noEffect++;
    else if (o === 'in_flight') t.inFlight++;
  }
  return t;
}

function measuredUsd(workers: QueueWorker[], sinceMs: number): OperatorMeasured {
  let sum = 0;
  let partial = false;
  for (const w of workers) {
    if (ms(w.createdAt) < sinceMs || !FAILED_WORKER.has(w.status)) continue;
    // §6.3: only `real` is measured. `mixed` has no stored real share, so it
    // makes the sum a lower bound; `virtual` and `unknown` are never summed.
    if (w.costBasis === 'real' && w.costUsd !== null) sum += w.costUsd;
    else if (w.costBasis === 'mixed') partial = true;
  }
  return { value: round2(sum), basis: 'measured', ...(partial ? { atLeast: true } : {}) };
}

function evidenceOf(c: Cause, facts: QueueFacts, byTask: Map<string, QueueWorker[]>, sweepFresh: boolean): {
  completeness: number; missing: RecoveryCauseRow['telemetry']['missing']; freshness: RecoveryCauseRow['telemetry']['freshness'];
} {
  const nowMs = ms(facts.now);
  const missing: RecoveryEvidenceInput[] = [];
  let applicable = 0;
  const check = (key: RecoveryEvidenceInput, ok: boolean) => { applicable++; if (!ok) missing.push(key); };

  const open = c.members.filter(m => m.open);
  check('assessment', open.every(m => !!m.incident.recovery && nowMs - ms(m.incident.recovery.observation.observedAt) <= FRESH_MINUTES * 60_000));
  check('attempt_events', facts.attempts !== null);
  const subjects = [...new Set(c.members.flatMap(m => m.subjects))];
  check('subject_tasks', facts.tasks !== null && subjects.every(id => facts.tasks!.has(id)));
  check('cost_rows', facts.workers !== null && subjects.every(id => (byTask.get(id) ?? []).every(w => w.costUsd !== null && w.costBasis !== null && w.costBasis !== 'unknown')));
  const prBlockers = open.flatMap(m => (m.incident.recovery?.blockers ?? []).filter(b => b.kind === 'pr'));
  if (prBlockers.length > 0) check('pr_projection', prBlockers.every(b => nowMs - ms(b.observedAt) <= FRESH_MINUTES * 60_000));

  const observed = open.map(m => m.incident.recovery?.observation.observedAt ?? null);
  const observedAt = observed.length === 0
    ? (c.lead.incident.recovery?.observation.observedAt ?? null)
    : observed.some(o => o === null) ? null : observed.reduce((a, b) => (a! < b! ? a : b));
  const lagSeconds = observedAt ? Math.max(0, Math.round((nowMs - ms(observedAt)) / 1000)) : null;
  let state: 'fresh' | 'stale' | 'unknown' = observedAt === null ? 'unknown' : lagSeconds! > FRESH_MINUTES * 60 ? 'stale' : 'fresh';
  const allMissing: RecoveryCauseRow['telemetry']['missing'] = [...missing];
  // §10.4: a sweep more than an hour behind makes every open cause stale, and
  // counts as one more input that was not fresh.
  if (!sweepFresh && c.open) {
    if (state === 'fresh') state = 'stale';
    allMissing.push('sweep_last_run');
    applicable++;
  }
  const completeness = applicable === 0 ? 1 : round2((applicable - allMissing.length) / applicable);
  return { completeness, missing: allMissing, freshness: { observedAt, lagSeconds, state } };
}

function named(ids: Iterable<string>, lookup: (id: string) => OperatorNamedRef | null): OperatorNamedRef[] {
  const out: OperatorNamedRef[] = [];
  for (const id of new Set(ids)) { const r = lookup(id); if (r) out.push(r); }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ── The panel ───────────────────────────────────────────────────────────────

interface Built {
  rows: RecoveryCauseRow[];
  causes: Map<string, Cause>;
  episodes: Array<BlockEpisode & { member: Member }>;
  attributedTo: Map<BlockEpisode, string>;
  recentlyRecovered: RecentlyRecoveredCause[];
  telemetry: RecoveryTelemetry;
  totals: RecoveryPanel['totals'];
  truncatedCount: number;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return round1(s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]);
}

export function rate(numerator: number | null, denominator: number | null): RecoveryRate {
  return { numerator, denominator, value: numerator !== null && denominator ? round2(numerator / denominator) : null };
}

/** A person (owner or customer) touched it: dismissed, or chose a decision option. */
function humanTouched(m: Member): boolean {
  return !!m.incident.acknowledgedAt || !!m.incident.recovery?.decision?.chosen;
}

function build(facts: QueueFacts): Built {
  const nowMs = ms(facts.now);
  const members = facts.incidents
    .filter(i => facts.platformWide || i.workspaceId !== null)
    .map(toMember);
  const causes = groupCauses(members);
  const causeMap = new Map(causes.map(c => [c.key, c]));
  const byTask = workersByTask(facts);
  const episodes = episodesOf(members, facts, byTask);
  const attemptsByIncident = new Map<string, QueueAttemptRow[]>();
  for (const a of facts.attempts ?? []) {
    const list = attemptsByIncident.get(a.detail.incidentId) ?? [];
    list.push(a);
    attemptsByIncident.set(a.detail.incidentId, list);
  }
  const sweepFresh = !!facts.lastRun && nowMs - ms(facts.lastRun.finishedAt) <= FRESH_MINUTES * 60_000;
  const taskOf = (id: string) => facts.tasks?.get(id) ?? null;
  const wsRef = (id: string): OperatorNamedRef | null => {
    const w = facts.workspaces.get(id);
    return w ? { id: w.id, name: w.name, teamId: w.teamId } : null;
  };
  const teamRef = (id: string): OperatorNamedRef | null => {
    const t = facts.teams.get(id);
    return t ? { id: t.id, name: t.name, teamId: t.id } : null;
  };
  const teamOfWs = (wsId: string | null) => (wsId ? facts.workspaces.get(wsId)?.teamId ?? null : null);

  // Everything rank needs except blocked work, per cause.
  const pre = new Map<string, Omit<RankInput, 'blockedTaskHours24h'> & { evidence: ReturnType<typeof evidenceOf> }>();
  for (const c of causes) {
    const open = c.members.filter(m => m.open);
    const subjects = [...new Set(c.members.flatMap(m => m.subjects))];
    const wsIds = new Set(c.members.map(m => m.incident.workspaceId).filter((x): x is string => !!x));
    const teamIds = new Set([...wsIds].map(teamOfWs).filter((x): x is string => !!x));
    const missionIds = new Set(subjects.map(id => taskOf(id)?.missionId).filter((x): x is string => !!x));
    const evidence = evidenceOf(c, facts, byTask, sweepFresh);
    const starts = (open.length ? open : c.members).map(m => m.episodeStart).sort();
    const fixTaskIds = c.members.map(m => m.incident.linkedFixTaskId).filter((x): x is string => !!x);
    const fixLive = fixTaskIds.some(id => { const t = taskOf(id); return !t || !TERMINAL_TASK.has(t.status); });
    const states = open.map(m => m.projection.state);
    const needsPerson = states.includes('needs_decision') || states.includes('needs_operator');
    const codeFix = c.members.some(m => CODE_FIX_CAUSES.has(causeCodeOf(m.incident)) || m.incident.recovery?.cause.ownership === 'infrastructure');
    const leverage: Leverage | null = open.some(m => !m.incident.recovery) && !needsPerson ? null
      : needsPerson ? 'decision_or_repair'
        : codeFix && fixTaskIds.length === 0 ? 'code_fix_needed'
          : fixLive ? 'fix_in_flight'
            : states.includes('recovering') ? 'recovering' : 'none';
    const subjectWorkers = subjects.flatMap(id => byTask.get(id) ?? []);
    const waste = facts.workers === null ? { value: 0, atLeast: true } : (() => {
      const m = measuredUsd(subjectWorkers, nowMs - 7 * DAY);
      return { value: m.value ?? 0, atLeast: !!m.atLeast };
    })();
    const in24 = c.members.filter(m => nowMs - ms(m.episodeStart) <= DAY).length;
    const prior = c.members.filter(m => { const age = nowMs - ms(m.episodeStart); return age > DAY && age <= 7 * DAY; }).length;
    pre.set(c.key, {
      causeKey: c.key,
      family: c.lead.incident.rule,
      causeCode: causeCodeOf(c.lead.incident),
      anyCritical: open.some(m => m.incident.severity === 'critical'),
      selfHealthOpen: open.some(m => m.incident.signature === SELF_HEALTH_SIGNATURE),
      needsPerson,
      budgetExhausted: open.some(m => !!m.incident.recovery && m.incident.recovery.budget.spent >= m.incident.recovery.budget.limit),
      unknown: states.includes('inconclusive') || evidence.completeness < 1 || evidence.freshness.state !== 'fresh',
      blockedNow: 0,
      teams: teamIds.size,
      workspaces: wsIds.size,
      missions: missionIds.size,
      oldestOpenAgeH: open.length ? round1((nowMs - ms(starts[0])) / HOUR) : 0,
      oldestFirstSeenAt: starts[0] ?? c.lead.incident.firstSeenAt,
      episodes24h: in24,
      prior6dMeanDaily: round2(prior / 6),
      reopens7d: c.members.filter(m => nowMs - ms(m.incident.lastSeenAt) <= 7 * DAY).reduce((s, m) => s + m.incident.recurrenceCount, 0),
      leverage,
      wasteUsd7d: waste,
      override: null,
      evidence,
    });
  }

  // §5.3: two roots on one task go to the one ranked higher by the other components.
  const prelim = [...pre.values()].map(p => {
    const input: RankInput = { ...p, blockedTaskHours24h: { value: 0, atLeast: false } };
    const comps = componentsOf(input, { skip: ['blockedWork'] });
    return { input, tier: tierOf(input).tier, score: scoreOf(comps) };
  }).sort(compareBaseline);
  const prelimPos = new Map(prelim.map((p, idx) => [p.input.causeKey, idx]));
  const prefer: CausePreference = (a, b) => (prelimPos.get(a) ?? 1e9) - (prelimPos.get(b) ?? 1e9);

  const work = (windowMs: number) => computeBlockedWork({ episodes, windowStartMs: nowMs - windowMs, nowMs, prefer });
  const w24 = work(DAY);
  const w7 = work(7 * DAY);
  const wReq = facts.window === '24h' ? w24 : facts.window === '7d' ? w7 : work(WINDOW_MS[facts.window]);
  const partialHours = facts.workers === null || facts.tasks === null;

  // Root per open episode, for the drill-down.
  const attributedTo = new Map<BlockEpisode, string>();
  for (const e of episodes) {
    const entry = w7.perCause.get(e.causeKey);
    let root = e.causeKey;
    for (const [r, tasks] of entry?.waitsBehind ?? []) if (tasks.has(e.subjectTaskId)) root = r;
    attributedTo.set(e, root);
  }

  const openCauses = causes.filter(c => c.open);
  const rankInputs: RankInput[] = openCauses.map(c => {
    const p = pre.get(c.key)!;
    const own = w24.perCause.get(c.key);
    return { ...p, blockedNow: own?.blockedNow.size ?? 0, blockedTaskHours24h: { value: round1(own?.hours ?? 0), atLeast: partialHours } };
  });
  const ranked = rankCauses(rankInputs, facts.now);
  const rankOf = new Map(ranked.map(r => [r.causeKey, r]));

  const hours = (h: number | undefined): OperatorMeasured => ({ value: round1(h ?? 0), basis: 'measured', ...(partialHours ? { atLeast: true } : {}) });

  const rowFor = (c: Cause): RecoveryCauseRow => {
    const p = pre.get(c.key)!;
    const r = rankOf.get(c.key);
    const open = c.members.filter(m => m.open);
    const worst = worstState((open.length ? open : c.members).map(m => m.projection.state));
    const ownerFrom = (open.length ? open : c.members).find(m => m.projection.state === worst) ?? c.lead;
    const subjects = [...new Set(c.members.flatMap(m => m.subjects))];
    const wsIds = c.members.map(m => m.incident.workspaceId).filter((x): x is string => !!x);
    const missionIds = subjects.map(id => taskOf(id)?.missionId).filter((x): x is string => !!x);
    const unblocked = unblocksOf(c.key, episodes);
    const unblockTasks = [...unblocked].map(taskOf).filter((t): t is QueueTask => !!t);
    const waits = [...(w24.perCause.get(c.key)?.waitsBehind ?? new Map()).entries()]
      .sort((a, b) => b[1].size - a[1].size)[0];
    const attempts = c.members.flatMap(m => attemptsByIncident.get(m.incident.id) ?? []);
    const tally = facts.attempts === null
      ? { total: c.members.reduce((s, m) => s + (m.incident.recovery?.attempts.length ?? 0), 0), succeeded: 0, failed: 0, noEffect: 0, inFlight: 0 }
      : tallyAttempts(attempts);
    const budgets = open.map(m => m.incident.recovery?.budget).filter(b => !!b);
    const topBudget = budgets.sort((a, b) => b!.spent - a!.spent)[0];
    const fixTaskId = c.members.map(m => m.incident.linkedFixTaskId).find(x => !!x) ?? null;
    const fixTask = fixTaskId ? taskOf(fixTaskId) : null;
    const subjectWorkers = subjects.flatMap(id => byTask.get(id) ?? []);
    const waste: OperatorMeasured = facts.workers === null ? { value: null, basis: 'unknown' } : measuredUsd(subjectWorkers, ms(facts.now) - 7 * DAY);
    const recoveredSubjects = new Set(episodes.filter(e => e.causeKey === c.key && e.endMs !== null).map(e => e.subjectTaskId)).size;
    const recs = c.members.map(m => m.incident.recovery).filter((x): x is NonNullable<typeof x> => !!x);
    const progress = recs.map(x => x.lastProgressAt).filter((x): x is string => !!x).sort();
    const checks = recs.filter(x => x.state !== 'recovered').map(x => x.nextCheckAt).filter((x): x is string => !!x).sort();
    const own24 = w24.perCause.get(c.key);
    const diff = p.episodes24h - p.prior6dMeanDaily;
    const band = Math.max(1, 0.5 * p.prior6dMeanDaily);
    return {
      causeKey: c.key,
      revision: causeRevision(c.members),
      title: c.lead.incident.title,
      sentence: c.lead.projection.sentence,
      family: c.lead.incident.rule,
      causeCode: causeCodeOf(c.lead.incident),
      grouping: { ...c.lead.grouping },
      state: worst,
      owner: ownerFrom.projection.owner,
      rank: r
        ? { position: r.position, tier: r.tier, tierReason: r.tierReason, score: r.score, why: r.why, components: r.components, override: null, advice: null }
        : { position: 0, tier: 3, tierReason: 'Recovered', score: 0, why: 'Recovered.', components: [], override: null, advice: null },
      impact: {
        teams: named([...wsIds.map(teamOfWs), ...unblockTasks.map(t => teamOfWs(t.workspaceId))].filter((x): x is string => !!x), teamRef),
        workspaces: named(wsIds, wsRef),
        missions: named(missionIds, id => {
          const m = facts.missions.get(id);
          return m ? { id: m.id, name: m.title, teamId: teamOfWs(m.workspaceId) } : null;
        }),
        tasks: {
          count: subjects.length,
          sample: subjects.slice(0, MAX_TASK_SAMPLE).map(id => {
            const t = taskOf(id);
            return { id, name: t?.title ?? `Task ${id.slice(0, 8)}`, teamId: teamOfWs(t?.workspaceId ?? null) };
          }),
        },
        blockedNow: own24?.blockedNow.size ?? 0,
        blockedTaskHours24h: hours(own24?.hours),
        blockedTaskHours7d: hours(w7.perCause.get(c.key)?.hours),
        unblocks: {
          tasks: unblocked.size,
          missions: new Set(unblockTasks.map(t => t.missionId).filter(Boolean)).size,
          teams: new Set(unblockTasks.map(t => teamOfWs(t.workspaceId)).filter(Boolean)).size,
        },
        waitsBehind: waits ? { causeKey: waits[0], tasks: waits[1].size } : null,
      },
      timing: {
        firstSeenAt: p.oldestFirstSeenAt,
        lastProgressAt: progress[progress.length - 1] ?? null,
        lastObservedAt: p.evidence.freshness.observedAt,
        nextCheckAt: checks[0] ?? null,
        oldestOpenAgeH: p.oldestOpenAgeH,
      },
      trend: {
        episodes24h: p.episodes24h,
        prior6dMeanDaily: p.prior6dMeanDaily,
        reopens7d: p.reopens7d,
        direction: diff >= band ? 'growing' : diff <= -band ? 'shrinking' : 'steady',
      },
      repair: {
        attempts: tally,
        budget: topBudget
          ? { spent: topBudget.spent, limit: topBudget.limit, exhausted: open.some(m => !!m.incident.recovery && m.incident.recovery.budget.spent >= m.incident.recovery.budget.limit) }
          : { spent: 0, limit: 0, exhausted: false },
        fixTask: fixTaskId ? { id: fixTaskId, name: fixTask?.title ?? `Task ${fixTaskId.slice(0, 8)}`, teamId: teamOfWs(fixTask?.workspaceId ?? null), status: fixTask?.status ?? 'unknown' } : null,
        fixPr: fixTaskId ? facts.fixPrs.get(fixTaskId) ?? null : null,
        wasteUsd7d: waste,
        // No operator-recovery decision kind runs yet (B3 ships them in shadow).
        modelUsd7d: { value: 0, basis: 'measured' },
        costPerRecoveredSubjectUsd: waste.value === null || recoveredSubjects === 0
          ? { value: null, basis: 'unknown' }
          : { value: round2(waste.value / recoveredSubjects), basis: 'measured', ...(waste.atLeast ? { atLeast: true } : {}) },
      },
      episodes: {
        open: episodes.filter(e => e.causeKey === c.key && e.endMs === null).length,
        total7d: episodes.filter(e => e.causeKey === c.key && nowMs - e.startMs <= 7 * DAY).length,
      },
      telemetry: p.evidence,
      // Owner capabilities are computed by the action service (B2).
      actions: [],
    };
  };

  const openRows = openCauses.map(rowFor).sort((a, b) => a.rank.position - b.rank.position);
  const recoveredCauses = causes.filter(c => !c.open);
  const recoveredAt = (c: Cause) => c.members.map(m => m.incident.resolvedAt).filter((x): x is string => !!x).sort().pop() ?? null;
  const detectMin = (c: Cause) => {
    const at = recoveredAt(c);
    const start = c.members.map(m => m.episodeStart).sort()[0];
    return at ? Math.max(0, Math.round((ms(at) - ms(start)) / 60_000)) : null;
  };
  const recoveredRows = recoveredCauses.map(rowFor);
  const recentlyRecovered: RecentlyRecoveredCause[] = recoveredCauses
    .filter(c => { const at = recoveredAt(c); return at !== null && nowMs - ms(at) <= 7 * DAY; })
    .map(c => {
      const row = recoveredRows.find(r => r.causeKey === c.key)!;
      return { causeKey: c.key, title: row.title, impact: row.impact, recoveredAt: recoveredAt(c)!, detectionToRecoveryMin: detectMin(c)! };
    })
    .sort((a, b) => (a.recoveredAt < b.recoveredAt ? 1 : -1));

  // ── Telemetry (§10.2) over the request window ─────────────────────────────
  const winMs = WINDOW_MS[facts.window];
  const recoveredInWindow = recoveredCauses.filter(c => { const at = recoveredAt(c); return at !== null && nowMs - ms(at) <= winMs; });
  const decisionCauses = openCauses.filter(c => c.members.some(m => m.open && (m.projection.state === 'needs_decision' || m.projection.state === 'needs_operator')));
  const terminal = recoveredInWindow.length + decisionCauses.length;
  const auto = recoveredInWindow.filter(c => !c.members.some(humanTouched)).length;
  const exhausted = decisionCauses.filter(c => c.members.some(m => {
    const r = m.incident.recovery;
    return !!r && (r.budget.spent >= r.budget.limit || facts.now >= r.budget.deadlineAt);
  })).length;
  const reopened = openCauses.filter(c => c.members.some(m => m.incident.recurrenceCount > 0 && nowMs - ms(m.incident.lastSeenAt) <= winMs)).length;
  const oldEnough = recoveredInWindow.filter(c => nowMs - ms(recoveredAt(c)!) >= 7 * DAY).length;
  const verdictIds = facts.personVerdicts;
  const escalated = verdictIds ? members.filter(m => verdictIds.has(m.incident.id)) : [];
  const unnecessary = escalated.filter(m => !m.open && !humanTouched(m)).length;
  const attemptsInWindow = (facts.attempts ?? []).filter(a => nowMs - ms(a.occurredAt) <= winMs);
  const byCapability = new Map<string, QueueAttemptRow[]>();
  for (const a of attemptsInWindow) byCapability.set(a.detail.capability, [...(byCapability.get(a.detail.capability) ?? []), a]);
  const effectiveness: Record<string, RecoveryRate> = {};
  for (const [cap, rows] of byCapability) {
    const executed = rows.filter(r => r.outcome !== 'shadow');
    effectiveness[cap] = rate(executed.filter(r => attemptOutcome(r) === 'progressed').length, executed.length);
  }
  const recoveredSubjectsAll = new Set(episodes.filter(e => e.endMs !== null && nowMs - e.endMs <= winMs).map(e => e.subjectTaskId));
  const allWorkers = facts.workers ?? [];
  const recoveredSubjectWaste = measuredUsd(allWorkers.filter(w => recoveredSubjectsAll.has(w.taskId)), nowMs - winMs);
  const activeAges = openRows.filter(r => r.rank.tier <= 2).map(r => r.timing.oldestOpenAgeH);
  const missingMetrics = ['stale_prompts'];
  if (facts.attempts === null) missingMetrics.push('repair_effectiveness');
  if (facts.personVerdicts === null) missingMetrics.push('unnecessary_escalations');
  if (facts.workers === null) missingMetrics.push('cost_per_recovered_subject');
  if (!facts.lastRun) missingMetrics.push('telemetry_lag');
  const lagSeconds = facts.lastRun ? Math.max(0, Math.round((nowMs - ms(facts.lastRun.finishedAt)) / 1000)) : null;
  const telemetry: RecoveryTelemetry = {
    window: facts.window,
    detectionToRecoveryMin: {
      p50: percentile(recoveredInWindow.map(detectMin).filter((x): x is number => x !== null), 0.5),
      p90: percentile(recoveredInWindow.map(detectMin).filter((x): x is number => x !== null), 0.9),
      n: recoveredInWindow.length,
    },
    autoRecoverySuccess: rate(auto, terminal),
    autoRecoveryFailure: rate(exhausted, terminal),
    reopenRate: { ...rate(reopened, reopened + oldEnough), tooRecent: reopened + oldEnough === 0 },
    timeBlockedTaskHours: hours(wReq.totalHours),
    unnecessaryEscalations: verdictIds ? rate(unnecessary, escalated.length) : rate(null, null),
    stalePrompts: rate(null, null),
    repairEffectiveness: effectiveness,
    costPerRecoveredSubjectUsd: facts.workers === null || recoveredSubjectsAll.size === 0
      ? { value: null, basis: 'unknown' }
      : { value: round2((recoveredSubjectWaste.value ?? 0) / recoveredSubjectsAll.size), basis: 'measured', ...(recoveredSubjectWaste.atLeast ? { atLeast: true } : {}) },
    queueAgeH: { p50: percentile(activeAges, 0.5), max: activeAges.length ? Math.max(...activeAges) : null, n: activeAges.length },
    telemetryLag: { seconds: lagSeconds, lastRunAt: facts.lastRun?.finishedAt ?? null, state: lagSeconds === null ? 'unknown' : sweepFresh ? 'fresh' : 'stale' },
    missing: missingMetrics,
  };

  const totals: RecoveryPanel['totals'] = {
    causes: openRows.length,
    needsDecision: openRows.filter(r => r.state === 'needs_decision' || r.state === 'needs_operator').length,
    blockedNow: new Set(episodes.filter(e => e.endMs === null).map(e => e.subjectTaskId)).size,
    blockedTaskHours24h: hours(w24.totalHours),
    evidenceMissing: openRows.filter(r => r.telemetry.completeness < 1 || r.telemetry.freshness.state !== 'fresh').length,
  };

  return {
    rows: [...openRows, ...recoveredRows],
    causes: causeMap,
    episodes,
    attributedTo,
    recentlyRecovered,
    telemetry,
    totals,
    truncatedCount: Math.max(0, openRows.length - MAX_QUEUE_ROWS),
  };
}

/** §10.3: which causes a telemetry metric drills into. */
export function matchesFilter(row: RecoveryCauseRow, filter: RecoveryFilter, ctx: { recoveredKeys: Set<string>; escalatedKeys: Set<string>; humanKeys: Set<string> }): boolean {
  switch (filter) {
    case 'detection_to_recovery': return ctx.recoveredKeys.has(row.causeKey);
    case 'auto_recovered': return ctx.recoveredKeys.has(row.causeKey) && !ctx.humanKeys.has(row.causeKey);
    case 'failed_auto_recovery': return (row.state === 'needs_decision' || row.state === 'needs_operator') && row.repair.budget.exhausted;
    case 'reopened': return row.trend.reopens7d > 0;
    case 'time_blocked': return (row.impact.blockedTaskHours7d.value ?? 0) > 0;
    case 'unnecessary_escalation': return ctx.escalatedKeys.has(row.causeKey) && ctx.recoveredKeys.has(row.causeKey) && !ctx.humanKeys.has(row.causeKey);
    case 'stale_prompt': return false;
    case 'repair_effectiveness': return row.repair.attempts.total > 0;
    case 'cost_per_recovered_subject': return (row.repair.wasteUsd7d.value ?? 0) > 0;
    case 'queue_age': return row.state !== 'recovered' && row.rank.tier <= 2;
    case 'telemetry_lag': return row.telemetry.freshness.state !== 'fresh';
  }
}

export function buildRecoveryPanel(facts: QueueFacts, opts: { includeRecovered?: boolean; filter?: RecoveryFilter } = {}): RecoveryPanel {
  const b = build(facts);
  // Ranked rows are the open causes; recovered ones only come back through a filter.
  let rows = b.rows.filter(r => r.rank.position > 0);
  if (opts.filter) {
    const recoveredKeys = new Set(b.rows.filter(r => r.rank.position === 0).map(r => r.causeKey));
    const humanKeys = new Set([...b.causes.values()].filter(c => c.members.some(humanTouched)).map(c => c.key));
    const escalatedKeys = new Set([...b.causes.values()].filter(c => c.members.some(m => facts.personVerdicts?.has(m.incident.id))).map(c => c.key));
    const filter = opts.filter;
    rows = b.rows.filter(r => matchesFilter(r, filter, { recoveredKeys, escalatedKeys, humanKeys }));
  }
  return {
    v: 1,
    generatedAt: facts.now,
    rankingPolicy: { version: ORQ_RANK_VERSION, weights: { ...ORQ_RANK_WEIGHTS } },
    automation: facts.automation,
    totals: b.totals,
    causes: rows.slice(0, MAX_QUEUE_ROWS),
    ...(opts.includeRecovered ? { recentlyRecovered: b.recentlyRecovered } : {}),
    telemetry: b.telemetry,
    ...(opts.filter ? { filter: opts.filter } : {}),
    truncated: rows.length > MAX_QUEUE_ROWS,
  };
}

export interface CauseDetailExtras {
  decisions: RecoveryCauseDetail['decisions'];
  audit: RecoveryCauseDetail['audit'];
  notifications: RecoveryCauseDetail['notifications'];
  verdicts: Map<string, { owner: 'buildd' | 'person' }>;
}

/** The drill-down for one cause, or null when no scoped incident groups under the key. */
export function buildRecoveryCauseDetail(facts: QueueFacts, causeKey: string, extras: CauseDetailExtras): RecoveryCauseDetail | null {
  const b = build(facts);
  const cause = b.causes.get(causeKey);
  const row = b.rows.find(r => r.causeKey === causeKey);
  if (!cause || !row) return null;
  const nowMs = ms(facts.now);
  const memberIds = new Set(cause.members.map(m => m.incident.id));
  const teamOf = (wsId: string | null): OperatorNamedRef => {
    const ws = wsId ? facts.workspaces.get(wsId) : undefined;
    const t = ws?.teamId ? facts.teams.get(ws.teamId) : undefined;
    return t ? { id: t.id, name: t.name, teamId: t.id } : { id: '', name: 'Platform', teamId: null };
  };
  return {
    cause: row,
    incidents: cause.members.map(m => {
      const ws = m.incident.workspaceId ? facts.workspaces.get(m.incident.workspaceId) : undefined;
      const v = extras.verdicts.get(m.incident.id);
      return {
        incidentId: m.incident.id,
        workspace: ws ? { id: ws.id, name: ws.name, teamId: ws.teamId } : { id: '', name: 'Platform', teamId: null },
        team: teamOf(m.incident.workspaceId),
        status: m.incident.status,
        version: m.incident.version,
        recovery: m.incident.recovery ?? null,
        // Stored verdicts carry no generation; FIR (b) puts it in the fingerprint read.
        verdict: v ? { owner: v.owner, generation: null } : null,
      };
    }),
    episodes: b.episodes.filter(e => memberIds.has(e.member.incident.id)).map(e => {
      const r = e.member.incident.recovery;
      const blocker = r?.blockers[0] ?? null;
      const end = e.endMs ?? nowMs;
      return {
        incidentId: e.member.incident.id,
        generation: r?.generation ?? 0,
        subject: { kind: 'task', id: e.subjectTaskId, name: facts.tasks?.get(e.subjectTaskId)?.title ?? `Task ${e.subjectTaskId.slice(0, 8)}` },
        blocker: blocker ? { kind: blocker.kind, id: blocker.id, state: blocker.state } : null,
        state: e.member.projection.state as OperatorRecoveryState,
        firstSeenAt: new Date(e.startMs).toISOString(),
        endedAt: e.endMs === null ? null : new Date(e.endMs).toISOString(),
        blockedHours: round1(Math.max(0, end - e.startMs) / HOUR),
        attributedTo: b.attributedTo.get(e) ?? e.causeKey,
      };
    }),
    attempts: (facts.attempts ?? []).filter(a => memberIds.has(a.detail.incidentId))
      .sort((x, y) => (x.occurredAt < y.occurredAt ? 1 : -1))
      .map(a => ({
        actionKey: a.detail.actionKey,
        capability: a.detail.capability,
        actor: a.detail.actor,
        startedAt: a.occurredAt,
        endedAt: a.detail.verify?.passed === null ? null : a.occurredAt,
        outcome: attemptOutcome(a),
        verify: a.detail.verify,
        costUsd: a.detail.costUsd,
      })),
    evidence: cause.members.flatMap(m => m.incident.evidenceRefs.map(r => ({
      ref: `${r.kind}:${r.id}`,
      kind: r.kind,
      label: r.kind === 'pr' ? `PR #${r.id}` : `${r.kind.replace('_', ' ')} ${r.id.slice(0, 8)}`,
      observedAt: r.at,
    }))).slice(0, 50),
    decisions: extras.decisions,
    audit: extras.audit,
    notifications: extras.notifications,
  };
}

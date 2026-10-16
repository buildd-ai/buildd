/**
 * Baseline ranking `orq-rank-v1` (operator-recovery spec §5.2, §5.4).
 *
 * Deterministic: tier first (lowest on top), then a 0–100 score inside the
 * tier, then the tie-breakers, ending on `causeKey` so the order is total.
 * Every weight, cap and tier list lives here; any change is a version bump,
 * echoed in the response as `rankingPolicy.version`.
 *
 * Unknown inputs never score 0 silently: a component whose input is unknown or
 * partial scores at its observed lower bound and carries `atLeast: true`, and
 * an incomplete cause can never sink below tier 2 (R1: unknown is never
 * healthy).
 *
 * Pure.
 */
import type { RecoveryRankComponent } from '@buildd/shared';

export const ORQ_RANK_VERSION = 'orq-rank-v1' as const;

export const ORQ_RANK_WEIGHTS = {
  blockedWork: 35,
  blastRadius: 20,
  duration: 15,
  growth: 15,
  leverage: 10,
  waste: 5,
} as const;

export const ORQ_RANK_CAPS = {
  blockedTaskHours: 200,
  teams: 5,
  workspaces: 10,
  missions: 10,
  durationHours: 72,
  reopens: 5,
  wasteUsd: 50,
} as const;

/**
 * Families (rule or cause-code prefix) that always rank in tier 0: tenant
 * isolation, auth, data immutability or integrity, secret exposure. No sentinel
 * rule raises these today; a family that does joins the list with a version bump.
 */
export const SAFETY_FAMILIES = ['tenant_isolation', 'auth', 'data_immutability', 'data_integrity', 'secret_exposure'] as const;

export const LEVERAGE_VALUE = {
  decision_or_repair: 1,
  code_fix_needed: 0.5,
  fix_in_flight: 0.2,
  recovering: 0,
  none: 0,
} as const;
export type Leverage = keyof typeof LEVERAGE_VALUE;

export interface RankInput {
  causeKey: string;
  family: string;
  causeCode: string;
  anyCritical: boolean;
  selfHealthOpen: boolean;
  /** Any member `needs_decision` or `needs_operator`. */
  needsPerson: boolean;
  /** Any member's repair budget spent (FIR I-5). */
  budgetExhausted: boolean;
  /** Any member `inconclusive`, completeness < 1 or stale (R1). */
  unknown: boolean;
  blockedNow: number;
  /** Attributed, deduplicated hours (§5.3). `atLeast` when some input was unreadable. */
  blockedTaskHours24h: { value: number; atLeast: boolean };
  teams: number;
  workspaces: number;
  missions: number;
  oldestOpenAgeH: number;
  oldestFirstSeenAt: string;
  episodes24h: number;
  prior6dMeanDaily: number;
  reopens7d: number;
  /** Null when it could not be decided: scored at 0 with `atLeast`. */
  leverage: Leverage | null;
  wasteUsd7d: { value: number; atLeast: boolean };
  /** An unexpired owner override (§5.6), when stored. */
  override?: { mode: 'pin_top' | 'demote' | 'snooze'; until: string } | null;
}

export interface RankResult {
  causeKey: string;
  position: number;
  baselinePosition: number;
  tier: 0 | 1 | 2 | 3;
  tierReason: string;
  score: number;
  why: string;
  components: RecoveryRankComponent[];
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

function isSafetyFamily(family: string, causeCode: string): boolean {
  const prefix = causeCode.split('.')[0];
  return SAFETY_FAMILIES.some(f => family === f || prefix === f);
}

export function tierOf(i: RankInput): { tier: 0 | 1 | 2 | 3; reason: string } {
  if (i.anyCritical) return { tier: 0, reason: 'Critical' };
  if (isSafetyFamily(i.family, i.causeCode)) return { tier: 0, reason: 'Safety problem' };
  if (i.selfHealthOpen) return { tier: 0, reason: 'The failure sentinel itself is degraded' };
  if (i.needsPerson) return { tier: 1, reason: 'Needs a person: a decision is waiting' };
  if (i.budgetExhausted) return { tier: 1, reason: 'Needs a person: every repair Buildd may try is used' };
  if (i.blockedNow > 0) return { tier: 2, reason: `Active: ${i.blockedNow} ${i.blockedNow === 1 ? 'task is' : 'tasks are'} blocked now` };
  if (i.unknown) return { tier: 2, reason: "Active: Buildd can't confirm the facts" };
  return { tier: 3, reason: 'Watching' };
}

/**
 * The six weighted components. `skip` leaves a component out (value null, no
 * contribution): §5.3 picks between two root causes "by the other components".
 */
export function componentsOf(i: RankInput, opts: { skip?: ReadonlyArray<keyof typeof ORQ_RANK_WEIGHTS> } = {}): RecoveryRankComponent[] {
  const c = ORQ_RANK_CAPS;
  const m = i.prior6dMeanDaily;
  const raw: Array<{ key: keyof typeof ORQ_RANK_WEIGHTS; value: number; atLeast?: boolean }> = [
    { key: 'blockedWork', value: Math.min(1, Math.log2(1 + Math.max(0, i.blockedTaskHours24h.value)) / Math.log2(1 + c.blockedTaskHours)), atLeast: i.blockedTaskHours24h.atLeast },
    { key: 'blastRadius', value: 0.5 * Math.min(1, i.teams / c.teams) + 0.3 * Math.min(1, i.workspaces / c.workspaces) + 0.2 * Math.min(1, i.missions / c.missions) },
    { key: 'duration', value: Math.min(1, Math.max(0, i.oldestOpenAgeH) / c.durationHours) },
    { key: 'growth', value: 0.6 * clamp01((i.episodes24h - m) / Math.max(1, m)) + 0.4 * Math.min(1, i.reopens7d / c.reopens) },
    { key: 'leverage', value: i.leverage === null ? 0 : LEVERAGE_VALUE[i.leverage], atLeast: i.leverage === null },
    { key: 'waste', value: Math.min(1, Math.max(0, i.wasteUsd7d.value) / c.wasteUsd), atLeast: i.wasteUsd7d.atLeast },
  ];
  return raw.map(r => {
    const weight = ORQ_RANK_WEIGHTS[r.key];
    if (opts.skip?.includes(r.key)) return { key: r.key, value: null, weight, contribution: 0 };
    const value = Math.round(r.value * 1000) / 1000;
    return { key: r.key, value, weight, contribution: round1(value * weight), ...(r.atLeast ? { atLeast: true } : {}) };
  });
}

export function scoreOf(components: RecoveryRankComponent[]): number {
  return round1(components.reduce((s, x) => s + x.contribution, 0));
}

function phrase(key: string, i: RankInput): string | null {
  switch (key) {
    case 'blockedWork': {
      const h = Math.round(i.blockedTaskHours24h.value * 10) / 10;
      return `Blocks ${i.blockedTaskHours24h.atLeast ? 'at least ' : ''}${h} task-hours today`;
    }
    case 'blastRadius':
      return i.teams > 1 ? `affects ${i.teams} teams` : i.workspaces > 1 ? `affects ${i.workspaces} workspaces` : null;
    case 'duration': return `open for ${Math.round(i.oldestOpenAgeH)} h`;
    case 'growth': return i.reopens7d > 0 ? `back ${i.reopens7d} ${i.reopens7d === 1 ? 'time' : 'times'} this week` : 'growing';
    case 'leverage': return i.leverage === 'code_fix_needed' ? 'needs a code fix nobody is working on' : i.leverage === 'decision_or_repair' ? 'one decision clears it' : null;
    case 'waste': return `$${i.wasteUsd7d.value.toFixed(2)} spent on runs that failed`;
    default: return null;
  }
}

/** §5.4: the tier reason plus the two largest contributions, in one line. */
export function whyLine(i: RankInput, tierReason: string, components: RecoveryRankComponent[]): string {
  const top = [...components]
    .filter(c => c.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution || (a.key < b.key ? -1 : 1))
    .map(c => phrase(c.key, i))
    .filter((p): p is string => !!p)
    .slice(0, 2);
  if (top.length === 0) return `${tierReason}.`;
  const rest = top.join(', ');
  return `${tierReason}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}.`;
}

/** Baseline order: tier, score, then the §5.2 step-3 tie-breakers. */
export function compareBaseline(
  a: { tier: number; score: number; input: RankInput },
  b: { tier: number; score: number; input: RankInput },
): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.score !== b.score) return b.score - a.score;
  if (a.input.oldestFirstSeenAt !== b.input.oldestFirstSeenAt) return a.input.oldestFirstSeenAt < b.input.oldestFirstSeenAt ? -1 : 1;
  if (a.input.blockedNow !== b.input.blockedNow) return b.input.blockedNow - a.input.blockedNow;
  if (a.input.teams !== b.input.teams) return b.input.teams - a.input.teams;
  return a.input.causeKey < b.input.causeKey ? -1 : a.input.causeKey > b.input.causeKey ? 1 : 0;
}

/**
 * Rank every cause. An unexpired override moves a row within its tier only:
 * `pin_top` to the top of the tier, `demote` and `snooze` to the bottom. It
 * never changes the tier, the state or the owner.
 */
export function rankCauses(inputs: ReadonlyArray<RankInput>, now: string): RankResult[] {
  const scored = inputs.map(input => {
    const { tier, reason } = tierOf(input);
    const components = componentsOf(input);
    return { input, tier, tierReason: reason, components, score: scoreOf(components) };
  });
  const baseline = [...scored].sort(compareBaseline);
  const basePos = new Map(baseline.map((s, idx) => [s.input.causeKey, idx + 1]));
  const live = (s: (typeof scored)[number]) => (s.input.override && s.input.override.until > now ? s.input.override.mode : null);
  const bucket = (s: (typeof scored)[number]) => (live(s) === 'pin_top' ? 0 : live(s) ? 2 : 1);
  const final = [...baseline].sort((a, b) => a.tier - b.tier || bucket(a) - bucket(b) || basePos.get(a.input.causeKey)! - basePos.get(b.input.causeKey)!);
  return final.map((s, idx) => ({
    causeKey: s.input.causeKey,
    position: idx + 1,
    baselinePosition: basePos.get(s.input.causeKey)!,
    tier: s.tier,
    tierReason: s.tierReason,
    score: s.score,
    why: whyLine(s.input, s.tierReason, s.components),
    components: s.components,
  }));
}

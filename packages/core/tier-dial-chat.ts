/**
 * Chat cells on the dial — the pure half.
 *
 * A chat cell runs the same loop as a coding cell (`./tier-dial.ts`
 * `decideDialCell`: shadow, threshold, non-inferiority promotion, auto-revert)
 * on the chat surface's own signals, mapped onto the loop's three slots:
 *
 *   merged     ← satisfied  the chat retro's verdict on a session window
 *                           (`yes` is a success; `partly` and `no` are misses)
 *   reviewOk   ← thumbs up  a person's thumbs on an assistant turn ("too slow"
 *                           is not a wrong answer: `chatTurnSeverity`)
 *   reworkFree ← no re-ask  no turn in the window was labelled re_asked or
 *                           wrong_tier, stopped, or hit a routing error
 *
 * A window is graded once the retro judged it. Thumbs are sparse and precise;
 * retro verdicts are dense and model-judged.
 *
 * **Attribution.** A thumb belongs to the model that served its turn
 * (`conversation_messages.model`). A retro verdict is about a whole window,
 * so it is credited only when every assistant turn in the window was served
 * by one model at one tier. Mixed windows are dropped, not down-weighted:
 * when a session moved between the primary and an alternate, a verdict says
 * nothing about which of them earned it, and any weight on it would credit
 * one model with the other's turns. Chains keep a session on one arm
 * (`continuesChain`), so few windows are mixed.
 *
 * **Higher bar than coding, derived.** A model judge misreads some sessions.
 * If it misreads a fraction ε, at random, an observed rate difference is the
 * true one times (1 − 2ε), so holding the dial's tolerance on the true scale
 * means testing a margin of m · (1 − 2ε) on the observed one — and, by the
 * threshold formula n ∝ 1/m², needing 1/(1 − 2ε)² times the evidence. ε is
 * measured where both signals exist: a thumb on a turn inside a judged window
 * that contradicts the verdict (up / `no`, a real down / `yes`). With a prior
 * of one disagreement in four pairs, a team with no overlap yet needs four
 * times coding's runs; agreement brings it down, never to coding's. A judge
 * that disagrees with people past `JUDGE_MAX_ERROR` is not a signal.
 *
 * **Judge independence.** The judging model must be from a different family
 * (vendor) than both the primary and every alternate in the cell. If the
 * configured retro model is not, the cell stays in shadow and says why; a
 * verdict whose recorded judge is not independent is never evidence.
 *
 * **Retros are optional.** Chat retro is an opt-in, removable experiment.
 * This file never imports it: verdicts arrive through `ChatQualitySource`,
 * which the experiment implements. With retros off (or removed) a chat cell
 * still serves a fixed split; a dial cell reads "no quality signal" and never
 * shifts. Thumbs still revert a shifted cell: people said so.
 *
 * Only labels, ids and timestamps cross this boundary; no conversation
 * content is read or sent anywhere.
 *
 * No db, no clock, no env.
 */
import { vendorOf } from './model-catalog';
import { chatTurnSeverity, type PoolArmRef } from './tier-pool';
import {
  DIAL_SETTINGS, MIN_METRIC_N, decideDialCell, keep, learningProgress, sameModel,
  type Dial, type DialCellInput, type DialDecision, type DialStateRecord, type ModelEvidence,
  type OutcomeRates, type OutcomeSignal, type Rate,
} from './tier-dial';

/** Chat retro lessons are kept 90 days; the dial reads no further back. */
export const CHAT_EVIDENCE_DAYS = 90;
export const CHAT_PACE_DAYS = 28;
/** Prior on the judge's error rate: one disagreement in four pairs. */
export const JUDGE_ERROR_PRIOR = { disagree: 1, pairs: 4 } as const;
/** Past this error rate the judge's verdicts carry too little signal to learn from. */
export const JUDGE_MAX_ERROR = 0.4;
/** Downs on the alternate since the shift before a thumbs trend can revert it. */
export const THUMBS_TREND_MIN_DOWNS = 3;

const DAY_MS = 86_400_000;

export const CHAT_SIGNAL_LABELS: Record<OutcomeSignal, string> = {
  merged: 'satisfied',
  reviewOk: 'thumbs up',
  reworkFree: 'no re-ask',
};

export const NO_QUALITY_SIGNAL = 'No quality signal: chat retros are off for this team, so the cell can run a fixed split but the dial cannot move traffic.';

// ── The source (implemented by the chat retro experiment) ──────────────────

/** One judged chat retro window. Labels only. */
export interface ChatSessionVerdict {
  conversationId: string;
  /** The window's first and last message times. */
  fromAt: Date;
  at: Date;
  satisfied: 'yes' | 'partly' | 'no' | null;
  /** No turn was labelled re_asked / wrong_tier, stopped, or hit a routing error. */
  clean: boolean;
  /** The model that judged the window (as recorded on the lesson). */
  judgeModel: string | null;
  /** Who served each assistant turn in the window. */
  served: Array<{ model: string | null; tier: string | null }>;
}

export interface ChatQualityStatus {
  /** Retros are on for this team (its effective setting and the global switch). */
  enabled: boolean;
  /** The model the retro is configured to judge with. */
  judgeModel: string | null;
}

/**
 * Where chat verdicts come from. The chat retro experiment provides one
 * (apps/web/src/lib/chat-retro/policy-signal.ts); with none, every chat cell
 * reads "no quality signal".
 */
export interface ChatQualitySource {
  status(teamId: string): Promise<ChatQualityStatus>;
  verdicts(teamId: string, since: Date): Promise<ChatSessionVerdict[]>;
}

/** A thumb on an assistant turn (`user_feedback`), with who served the turn. */
export interface ChatThumb {
  messageId: string;
  conversationId: string;
  at: Date;
  tier: string | null;
  model: string | null;
  signal: 'up' | 'down';
  reason: string | null;
}

// ── Attribution and evidence ────────────────────────────────────────────────

/** The model and tier a window's verdict belongs to, or null (mixed, unknown, empty). */
export function attributeVerdict(v: ChatSessionVerdict): { model: string; tier: string | null } | null {
  if (v.served.length === 0) return null;
  const first = v.served[0];
  if (!first.model) return null;
  for (const t of v.served) {
    if (!sameModel(t.model, first.model) || t.tier !== first.tier) return null;
  }
  return { model: first.model, tier: first.tier };
}

/** A judge is independent of a cell when its vendor is known and is no arm's vendor. */
export function judgeIndependence(judge: string | null | undefined, armModels: readonly string[]): { ok: true } | { ok: false; reason: string } {
  if (!judge) return { ok: false, reason: 'The chat retro judge model is unknown, so its verdicts cannot be checked for independence; the cell stays in shadow.' };
  const jv = vendorOf(judge);
  if (jv === 'other') return { ok: false, reason: `The chat retro judge (${judge}) is from an unknown family; the cell stays in shadow until the retro uses a model from a known family other than the cell's.` };
  for (const m of armModels) {
    const v = vendorOf(m);
    if (v === 'other') return { ok: false, reason: `${m} is from an unknown family, so the chat retro judge cannot be shown independent of it; the cell stays in shadow.` };
    if (v === jv) return { ok: false, reason: `The chat retro judge (${judge}) is from the same family as ${m}; the cell stays in shadow until the retro uses a model from another family.` };
  }
  return { ok: true };
}

/** A thumb's grade: true = fine, false = a real down. */
function thumbOk(t: ChatThumb): boolean {
  return chatTurnSeverity(t.signal, t.reason) === 'none';
}

/**
 * One model's chat evidence. Verdicts are attributed (mixed windows dropped)
 * and kept only when judged by a model independent of `armModels`.
 */
export function chatEvidence(
  verdicts: readonly ChatSessionVerdict[],
  thumbs: readonly ChatThumb[],
  model: string,
  opts: { armModels: readonly string[]; tier?: string; sinceMs?: number },
): ModelEvidence {
  const rates: OutcomeRates = { merged: { n: 0, k: 0 }, reviewOk: { n: 0, k: 0 }, reworkFree: { n: 0, k: 0 } };
  const since = opts.sinceMs ?? -Infinity;
  for (const v of verdicts) {
    if (v.at.getTime() < since) continue;
    const a = attributeVerdict(v);
    if (!a || !sameModel(a.model, model)) continue;
    if (opts.tier !== undefined && a.tier !== opts.tier) continue;
    if (!judgeIndependence(v.judgeModel, opts.armModels).ok) continue;
    if (v.satisfied) {
      rates.merged.n += 1;
      if (v.satisfied === 'yes') rates.merged.k += 1;
    }
    rates.reworkFree.n += 1;
    if (v.clean) rates.reworkFree.k += 1;
  }
  for (const t of thumbs) {
    if (t.at.getTime() < since || !sameModel(t.model, model)) continue;
    if (opts.tier !== undefined && t.tier !== opts.tier) continue;
    rates.reviewOk.n += 1;
    if (thumbOk(t)) rates.reviewOk.k += 1;
  }
  return { rates, costPerRunUsd: null };
}

/** Thumbs inside judged windows, and how many contradict the verdict. */
export function judgeAgreement(verdicts: readonly ChatSessionVerdict[], thumbs: readonly ChatThumb[]): { both: number; disagree: number } {
  const byConv = new Map<string, ChatThumb[]>();
  for (const t of thumbs) {
    const l = byConv.get(t.conversationId) ?? [];
    l.push(t);
    byConv.set(t.conversationId, l);
  }
  let both = 0;
  let disagree = 0;
  for (const v of verdicts) {
    if (!v.satisfied) continue;
    for (const t of byConv.get(v.conversationId) ?? []) {
      const at = t.at.getTime();
      if (at < v.fromAt.getTime() || at > v.at.getTime()) continue;
      both += 1;
      const ok = thumbOk(t);
      if ((ok && v.satisfied === 'no') || (!ok && v.satisfied === 'yes')) disagree += 1;
    }
  }
  return { both, disagree };
}

/** The margin scale for the judge's measured error, and whether it is too noisy to use. */
export function chatMarginScale(agreement: { both: number; disagree: number }): { scale: number; judgeError: number; unreliable: boolean } {
  const e = (agreement.disagree + JUDGE_ERROR_PRIOR.disagree) / (agreement.both + JUDGE_ERROR_PRIOR.pairs);
  const unreliable = e >= JUDGE_MAX_ERROR;
  return { scale: unreliable ? 1 - 2 * JUDGE_MAX_ERROR : 1 - 2 * e, judgeError: e, unreliable };
}

/**
 * A thumbs-down trend on the alternate since the shift: at least
 * `THUMBS_TREND_MIN_DOWNS` real downs, and a down rate more than the dial's
 * margin above the primary's. `Rate` here is n = rated turns, k = downs.
 */
export function thumbsDownTrend(alt: Rate, primary: Rate, margin: number): string | null {
  if (alt.k < THUMBS_TREND_MIN_DOWNS || alt.n === 0) return null;
  const ra = alt.k / alt.n;
  const rp = primary.n > 0 ? primary.k / primary.n : 0;
  if (ra - rp <= margin) return null;
  return `thumbs-down on ${alt.k} of ${alt.n} rated turns since the shift (${Math.round(ra * 100)}%) vs primary ${Math.round(rp * 100)}% (tolerance ${Math.round(margin * 100)} points)`;
}

function downs(r: Rate): Rate {
  return { n: r.n, k: r.n - r.k };
}

// ── One cell ────────────────────────────────────────────────────────────────

export interface ChatCellPool {
  tier: string;
  dial: Dial;
  dialState: DialStateRecord | null;
  arms: Array<PoolArmRef & { model: string }>;
}

export interface ChatCellInput {
  /** The loop's input on chat signals, margin scaled and labels set. */
  base: DialCellInput;
  retro: ChatQualityStatus;
  armModels: string[];
  judge: ReturnType<typeof chatMarginScale>;
  /** Shifted only: thumbs (n rated, k downs) since the shift. */
  thumbsSinceShift: { alternate: Rate; primary: Rate } | null;
}

/** A chat cell's inputs from the team's verdicts and thumbs. Pure; null without a primary. */
export function chatDialInputFor(
  pool: ChatCellPool,
  verdicts: readonly ChatSessionVerdict[],
  thumbs: readonly ChatThumb[],
  retro: ChatQualityStatus,
  now: Date,
): ChatCellInput | null {
  const live = pool.arms.filter(a => a.status === 'active');
  const incumbent = live.find(a => a.role === 'incumbent');
  if (!incumbent) return null;
  const alts = live.filter(a => a.role === 'challenger');
  const armModels = [incumbent.model, ...alts.map(a => a.model)];
  const prior = pool.dialState;
  // With retros off, verdicts already stored are not read either.
  const vs = retro.enabled ? verdicts : [];
  const sinceMs = prior?.evidenceSince ? Date.parse(prior.evidenceSince) : now.getTime() - CHAT_EVIDENCE_DAYS * DAY_MS;
  const shiftMs = prior?.state === 'shifted' ? Date.parse(prior.since) : now.getTime();
  const paceMs = now.getTime() - CHAT_PACE_DAYS * DAY_MS;
  const judge = chatMarginScale(judgeAgreement(vs, thumbs));
  const ev = (model: string, o: { tier?: string; sinceMs: number }) => chatEvidence(vs, thumbs, model, { armModels, ...o });

  const primaryInCellSinceShift = ev(incumbent.model, { tier: pool.tier, sinceMs: shiftMs });
  const graded = vs.filter(v => {
    if (v.at.getTime() < paceMs || !v.satisfied) return false;
    const a = attributeVerdict(v);
    return !!a && a.tier === pool.tier && judgeIndependence(v.judgeModel, armModels).ok;
  }).length;

  const base: DialCellInput = {
    dial: pool.dial,
    prior,
    now,
    primary: { armId: incumbent.id, evidence: ev(incumbent.model, { tier: pool.tier, sinceMs }) },
    alternates: alts.map(a => ({
      armId: a.id,
      model: a.model,
      // The team's chat on this model anywhere (observational).
      evidence: ev(a.model, { sinceMs }),
      // This cell's turns it served since the shift (the revert evidence).
      inCell: ev(a.model, { tier: pool.tier, sinceMs: shiftMs }),
    })),
    primaryInCellSinceShift,
    gradedPerDay: graded / CHAT_PACE_DAYS,
    // Only the judged signals carry the judge's noise; thumbs are people's.
    marginScale: { merged: judge.scale, reworkFree: judge.scale },
    signalLabels: CHAT_SIGNAL_LABELS,
  };

  let thumbsSinceShift: ChatCellInput['thumbsSinceShift'] = null;
  if (prior?.state === 'shifted') {
    const alt = base.alternates.find(a => a.armId === prior.alternateArmId);
    const p = primaryInCellSinceShift.rates.reviewOk.n >= MIN_METRIC_N
      ? primaryInCellSinceShift.rates.reviewOk
      : base.primary.evidence.rates.reviewOk;
    if (alt) thumbsSinceShift = { alternate: downs(alt.inCell.rates.reviewOk), primary: downs(p) };
  }
  return { base, retro, armModels, judge, thumbsSinceShift };
}

export interface ChatDialDecision extends DialDecision {
  /** What the cell learns from: `none` = retros are off. */
  quality: 'chat-retro' | 'none';
  /** Why the cell cannot promote now, in plain words. */
  held?: string;
}

/** Why a chat cell may not promote, or null when it may. */
export function chatHoldReason(input: Pick<ChatCellInput, 'retro' | 'armModels' | 'judge'>): string | null {
  if (!input.retro.enabled) return NO_QUALITY_SIGNAL;
  const ind = judgeIndependence(input.retro.judgeModel, input.armModels);
  if (!ind.ok) return ind.reason;
  if (input.judge.unreliable) {
    return `The chat retro's verdicts disagree with people's thumbs on ${Math.round(input.judge.judgeError * 100)}% of rated turns, too often to learn from; the cell stays in shadow.`;
  }
  return null;
}

/**
 * One evaluation of a chat cell: the coding loop, plus three chat rules.
 * A thumbs-down trend on a shifted alternate reverts it before anything else.
 * A cell that may not learn (`chatHoldReason`) never promotes, and a shifted
 * one goes back to the primary, recorded. Otherwise `decideDialCell` decides.
 */
export function decideChatCell(input: ChatCellInput): ChatDialDecision {
  const { base } = input;
  const quality: ChatDialDecision['quality'] = input.retro.enabled ? 'chat-retro' : 'none';
  const held = chatHoldReason(input) ?? undefined;
  const withQuality = (d: DialDecision): ChatDialDecision => ({ ...d, quality, ...(held ? { held } : {}) });
  const prior = base.prior;
  const nowIso = base.now.toISOString();

  if (base.dial === 1 || base.alternates.length === 0) return withQuality(decideDialCell(base));

  if (prior?.state === 'shifted' && input.thumbsSinceShift) {
    const alt = base.alternates.find(a => a.armId === prior.alternateArmId)!;
    const reason = thumbsDownTrend(input.thumbsSinceShift.alternate, input.thumbsSinceShift.primary, DIAL_SETTINGS[base.dial].margin);
    if (reason) {
      return withQuality({
        record: { state: 'reverted', since: nowIso, alternateArmId: null, revertReason: reason, revertedAt: nowIso, evidenceSince: nowIso },
        share: 0,
        alternateArmId: null,
        event: {
          kind: 'revert',
          reason,
          evidence: { signal: 'thumbs', alternateArmId: alt.armId, model: alt.model, dial: base.dial, alternate: input.thumbsSinceShift.alternate, primary: input.thumbsSinceShift.primary },
        },
      });
    }
  }

  if (held && prior?.state === 'shifted') {
    return withQuality({
      record: { ...keep(prior), state: 'learning', since: nowIso, alternateArmId: null },
      share: 0,
      alternateArmId: null,
      progress: { ...learningProgress(base), note: held },
      event: { kind: 'dial', reason: held, evidence: { from: 'shifted', alternateArmId: prior.alternateArmId ?? null, quality } },
    });
  }

  const d = decideDialCell(base);
  if (!held) return withQuality(d);
  if (d.event?.kind === 'promotion') {
    // The loop would promote; the guard keeps the cell in shadow.
    return withQuality({ record: prior!, share: 0, alternateArmId: null, progress: { ...learningProgress(base), note: held } });
  }
  return withQuality(d.progress ? { ...d, progress: { ...d.progress, note: held } } : d);
}

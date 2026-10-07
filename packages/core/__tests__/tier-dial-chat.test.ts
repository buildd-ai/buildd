import { describe, it, expect } from 'bun:test';
import {
  CHAT_SIGNAL_LABELS, attributeVerdict, chatDialInputFor, chatEvidence, chatMarginScale, decideChatCell,
  judgeIndependence, judgeAgreement, thumbsDownTrend, type ChatCellPool, type ChatSessionVerdict, type ChatThumb,
} from '../tier-dial-chat';
import { DIAL_SETTINGS, dialThreshold, type DialStateRecord } from '../tier-dial';

const NOW = new Date('2026-10-06T12:00:00Z');
const DAY = 86_400_000;
const INC = 'inc-arm';
const ALT = 'alt-arm';
const PRIMARY = 'claude-sonnet-5';
const CHEAP = 'openai/gpt-6-mini';
const JUDGE = 'typesafe/jev-1.13';

function pool(over: Partial<ChatCellPool> = {}): ChatCellPool {
  return {
    tier: 'standard',
    dial: 3,
    dialState: { state: 'learning', since: new Date(NOW.getTime() - 40 * DAY).toISOString() },
    arms: [
      { id: INC, model: PRIMARY, role: 'incumbent', status: 'active' },
      { id: ALT, model: CHEAP, role: 'challenger', status: 'active' },
    ],
    ...over,
  };
}

let seq = 0;
/** `n` judged windows served entirely by `model`, `yesShare` satisfied. */
function verdicts(model: string, n: number, yesShare: number, opts: { tier?: string; daysAgo?: number; judge?: string | null; clean?: boolean } = {}): ChatSessionVerdict[] {
  const tier = opts.tier ?? 'standard';
  return Array.from({ length: n }, (_, i) => {
    const at = new Date(NOW.getTime() - (opts.daysAgo ?? 20) * DAY + i * 60_000);
    return {
      conversationId: `conv-${model}-${seq++}`,
      at,
      fromAt: new Date(at.getTime() - 60_000),
      satisfied: i < Math.round(n * yesShare) ? 'yes' : 'no',
      clean: opts.clean ?? true,
      judgeModel: opts.judge === undefined ? JUDGE : opts.judge,
      served: [{ model, tier }, { model, tier }],
    };
  });
}

function thumbs(model: string, ups: number, downs: number, daysAgo = 1, reason: string | null = 'wrong_answer'): ChatThumb[] {
  return Array.from({ length: ups + downs }, (_, i) => ({
    messageId: `m-${model}-${seq++}`,
    conversationId: `conv-t-${seq}`,
    at: new Date(NOW.getTime() - daysAgo * DAY + i * 1000),
    tier: 'standard',
    model,
    signal: i < ups ? 'up' as const : 'down' as const,
    reason: i < ups ? null : reason,
  }));
}

const retroOn = { enabled: true, judgeModel: JUDGE };

describe('attributeVerdict', () => {
  it('credits a window to the one model that served every turn, across dated spellings', () => {
    const v = verdicts(PRIMARY, 1, 1)[0];
    v.served = [{ model: PRIMARY, tier: 'standard' }, { model: `${PRIMARY}-20260601`, tier: 'standard' }];
    expect(attributeVerdict(v)).toEqual({ model: PRIMARY, tier: 'standard' });
  });

  it('drops a mixed-model window: neither model can be credited with the verdict', () => {
    const v = verdicts(PRIMARY, 1, 1)[0];
    v.served = [{ model: PRIMARY, tier: 'standard' }, { model: CHEAP, tier: 'standard' }];
    expect(attributeVerdict(v)).toBeNull();
  });

  it('drops a window across tiers, with an unknown model, or with no assistant turn', () => {
    const v = verdicts(PRIMARY, 1, 1)[0];
    expect(attributeVerdict({ ...v, served: [{ model: PRIMARY, tier: 'standard' }, { model: PRIMARY, tier: 'premium' }] })).toBeNull();
    expect(attributeVerdict({ ...v, served: [{ model: PRIMARY, tier: 'standard' }, { model: null, tier: 'standard' }] })).toBeNull();
    expect(attributeVerdict({ ...v, served: [] })).toBeNull();
  });

  it('a verdict counts only for the model that served it', () => {
    const units = [...verdicts(PRIMARY, 10, 1), ...verdicts(CHEAP, 10, 0)];
    const primary = chatEvidence(units, [], PRIMARY, { armModels: [PRIMARY, CHEAP] });
    const cheap = chatEvidence(units, [], CHEAP, { armModels: [PRIMARY, CHEAP] });
    expect(primary.rates.merged).toEqual({ n: 10, k: 10 });
    expect(cheap.rates.merged).toEqual({ n: 10, k: 0 });
  });

  it('thumbs count per turn, for the model that served that turn, even in a mixed session', () => {
    const t = [...thumbs(PRIMARY, 3, 1), ...thumbs(CHEAP, 1, 2)];
    expect(chatEvidence([], t, PRIMARY, { armModels: [PRIMARY, CHEAP] }).rates.reviewOk).toEqual({ n: 4, k: 3 });
    expect(chatEvidence([], t, CHEAP, { armModels: [PRIMARY, CHEAP] }).rates.reviewOk).toEqual({ n: 3, k: 1 });
  });

  it('"too slow" is not a wrong answer; a window with a re-ask is not clean', () => {
    const t = thumbs(PRIMARY, 0, 2, 1, 'too_slow');
    expect(chatEvidence([], t, PRIMARY, { armModels: [PRIMARY] }).rates.reviewOk).toEqual({ n: 2, k: 2 });
    const v = verdicts(PRIMARY, 4, 1, { clean: false });
    expect(chatEvidence(v, [], PRIMARY, { armModels: [PRIMARY] }).rates.reworkFree).toEqual({ n: 4, k: 0 });
  });
});

describe('judge independence', () => {
  it('a judge from another family is independent', () => {
    expect(judgeIndependence(JUDGE, [PRIMARY, CHEAP])).toEqual({ ok: true });
  });

  it('a judge from either arm\'s family is not, and says why', () => {
    const r = judgeIndependence('anthropic/claude-haiku-5', [PRIMARY, CHEAP]);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('same family');
    expect(judgeIndependence('gpt-6', [PRIMARY, CHEAP]).ok).toBe(false);
  });

  it('an unknown judge or an arm of unknown family fails closed', () => {
    expect(judgeIndependence(null, [PRIMARY, CHEAP]).ok).toBe(false);
    expect(judgeIndependence(JUDGE, [PRIMARY, 'mystery-model']).ok).toBe(false);
  });

  it('verdicts judged by a model of an arm\'s family are not evidence', () => {
    const units = [...verdicts(CHEAP, 10, 1, { judge: 'openai/gpt-6' }), ...verdicts(CHEAP, 10, 1)];
    expect(chatEvidence(units, [], CHEAP, { armModels: [PRIMARY, CHEAP] }).rates.merged.n).toBe(10);
  });
});

describe('threshold', () => {
  it('is higher than coding\'s for the same dial and primary, and derived from judge agreement', () => {
    const primary = chatEvidence(verdicts(PRIMARY, 100, 0.8), [], PRIMARY, { armModels: [PRIMARY, CHEAP] }).rates;
    const coding = dialThreshold({ dial: 3, primary, gradedPerDay: 0 }).threshold;
    const scaleNoData = chatMarginScale({ both: 0, disagree: 0 });
    const chatNoData = dialThreshold({ dial: 3, primary, gradedPerDay: 0, marginScale: scaleNoData.scale }).threshold;
    expect(chatNoData).toBeGreaterThan(coding);
    // Thumbs and verdicts that agree bring it down, never to coding's.
    const scaleAgreeing = chatMarginScale({ both: 200, disagree: 0 });
    const chatAgreeing = dialThreshold({ dial: 3, primary, gradedPerDay: 0, marginScale: scaleAgreeing.scale }).threshold;
    expect(chatAgreeing).toBeLessThan(chatNoData);
    expect(chatAgreeing).toBeGreaterThan(coding);
  });

  it('a judge that disagrees with people too often is not a signal', () => {
    expect(chatMarginScale({ both: 100, disagree: 50 }).unreliable).toBe(true);
  });

  it('agreement pairs a verdict with thumbs on turns inside its window', () => {
    const [v] = verdicts(PRIMARY, 1, 1);
    const inWindow: ChatThumb = { messageId: 'x', conversationId: v.conversationId, at: v.at, tier: 'standard', model: PRIMARY, signal: 'down', reason: 'made_up' };
    const elsewhere: ChatThumb = { ...inWindow, messageId: 'y', conversationId: 'other' };
    expect(judgeAgreement([v], [inWindow, elsewhere])).toEqual({ both: 1, disagree: 1 });
  });
});

describe('decideChatCell', () => {
  /** Enough agreeing, equal-quality evidence on both sides to promote at dial 5. */
  function promotable() {
    const v = [...verdicts(PRIMARY, 600, 0.8, { daysAgo: 60 }), ...verdicts(CHEAP, 600, 0.8, { daysAgo: 60 })];
    const t = [...v.slice(0, 300), ...v.slice(600, 900)].map(x => ({
      messageId: `t-${x.conversationId}`, conversationId: x.conversationId, at: x.at, tier: 'standard',
      model: x.served[0].model, signal: x.satisfied === 'yes' ? 'up' as const : 'down' as const, reason: x.satisfied === 'yes' ? null : 'wrong_answer',
    }));
    return { v, t };
  }

  it('with retros on, an independent judge and enough evidence, the cell shifts', () => {
    const { v, t } = promotable();
    const d = decideChatCell(chatDialInputFor(pool({ dial: 5 }), v, t, retroOn, NOW)!);
    expect(d.record.state).toBe('shifted');
    expect(d.event?.kind).toBe('promotion');
    expect(d.event?.reason).toContain('satisfied');
    expect(d.quality).toBe('chat-retro');
  });

  it('a retro judge from an arm\'s family keeps the cell in shadow and says why', () => {
    const { v, t } = promotable();
    const d = decideChatCell(chatDialInputFor(pool({ dial: 5 }), v, t, { enabled: true, judgeModel: 'anthropic/claude-haiku-5' }, NOW)!);
    expect(d.record.state).toBe('learning');
    expect(d.share).toBe(0);
    expect(d.event).toBeUndefined();
    expect(d.held).toContain('same family');
    expect(d.progress?.note).toBe(d.held);
  });

  it('a shifted cell whose judge stops being independent goes back to the primary, recorded', () => {
    const shifted: DialStateRecord = { state: 'shifted', since: new Date(NOW.getTime() - 5 * DAY).toISOString(), alternateArmId: ALT };
    const d = decideChatCell(chatDialInputFor(pool({ dial: 5, dialState: shifted }), [], [], { enabled: true, judgeModel: 'gpt-6' }, NOW)!);
    expect(d.record.state).toBe('learning');
    expect(d.share).toBe(0);
    expect(d.event).toMatchObject({ kind: 'dial' });
    expect(d.event!.reason).toContain('same family');
  });

  it('retros off: "no quality signal", no shifting however good the thumbs look', () => {
    const { v, t } = promotable();
    const d = decideChatCell(chatDialInputFor(pool({ dial: 5 }), v, t, { enabled: false, judgeModel: JUDGE }, NOW)!);
    expect(d.quality).toBe('none');
    expect(d.record.state).toBe('learning');
    expect(d.share).toBe(0);
    expect(d.held).toMatch(/no quality signal/i);
  });

  it('retros off on a shifted cell: traffic returns to the primary, recorded', () => {
    const shifted: DialStateRecord = { state: 'shifted', since: new Date(NOW.getTime() - 5 * DAY).toISOString(), alternateArmId: ALT };
    const d = decideChatCell(chatDialInputFor(pool({ dial: 3, dialState: shifted }), [], [], { enabled: false, judgeModel: null }, NOW)!);
    expect(d.record.state).toBe('learning');
    expect(d.event?.reason).toMatch(/no quality signal/i);
  });

  it('a thumbs-down trend on the shifted alternate reverts at once, with the reason', () => {
    const shifted: DialStateRecord = { state: 'shifted', since: new Date(NOW.getTime() - 2 * DAY).toISOString(), alternateArmId: ALT };
    // Far below the generic revert minimum: a handful of rated turns.
    const t = [...thumbs(CHEAP, 2, 3, 1), ...thumbs(PRIMARY, 10, 0, 1)];
    const d = decideChatCell(chatDialInputFor(pool({ dial: 3, dialState: shifted }), [], t, retroOn, NOW)!);
    expect(d.record.state).toBe('reverted');
    expect(d.share).toBe(0);
    expect(d.event?.kind).toBe('revert');
    expect(d.record.revertReason).toContain('thumbs-down');
    expect(d.event!.evidence).toMatchObject({ signal: 'thumbs', alternateArmId: ALT });
  });

  it('the thumbs trend reverts even with retros off (people said so)', () => {
    const shifted: DialStateRecord = { state: 'shifted', since: new Date(NOW.getTime() - 2 * DAY).toISOString(), alternateArmId: ALT };
    const t = thumbs(CHEAP, 0, 3, 1);
    expect(decideChatCell(chatDialInputFor(pool({ dial: 3, dialState: shifted }), [], t, { enabled: false, judgeModel: null }, NOW)!).record.state).toBe('reverted');
  });

  it('thumbs from before the shift, or one stray down, do not revert', () => {
    const shifted: DialStateRecord = { state: 'shifted', since: new Date(NOW.getTime() - 2 * DAY).toISOString(), alternateArmId: ALT };
    const before = thumbs(CHEAP, 0, 5, 10);
    expect(decideChatCell(chatDialInputFor(pool({ dial: 3, dialState: shifted }), [], before, retroOn, NOW)!).record.state).toBe('shifted');
    const one = [...thumbs(CHEAP, 20, 1, 1), ...thumbs(PRIMARY, 20, 0, 1)];
    expect(decideChatCell(chatDialInputFor(pool({ dial: 3, dialState: shifted }), [], one, retroOn, NOW)!).record.state).toBe('shifted');
  });

  it('dial 1 is always the primary, whatever the signal', () => {
    const d = decideChatCell(chatDialInputFor(pool({ dial: 1 }), [], [], { enabled: false, judgeModel: null }, NOW)!);
    expect(d.record.state).toBe('always');
    expect(d.share).toBe(0);
  });

  it('reasons speak chat, not coding', () => {
    expect(Object.values(CHAT_SIGNAL_LABELS)).not.toContain('merged');
  });
});

describe('thumbsDownTrend', () => {
  it('needs a few downs and a rate past the margin over the primary\'s', () => {
    const m = DIAL_SETTINGS[3].margin;
    expect(thumbsDownTrend({ n: 5, k: 3 }, { n: 20, k: 1 }, m)).not.toBeNull();
    expect(thumbsDownTrend({ n: 5, k: 2 }, { n: 20, k: 0 }, m)).toBeNull();
    expect(thumbsDownTrend({ n: 100, k: 5 }, { n: 100, k: 4 }, m)).toBeNull();
  });
});

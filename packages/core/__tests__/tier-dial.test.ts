import { describe, it, expect } from 'bun:test';
import {
  DIAL_SETTINGS,
  applyDialChange,
  MIN_THRESHOLD,
  REVERT_COOLDOWN_DAYS,
  Z_FLOOR,
  decideDialCell,
  decideDialArm,
  dialAllocation,
  dialThreshold,
  withinTolerance,
  type DialCellInput,
  type DialStateRecord,
  type ModelEvidence,
} from '../tier-dial';

const NOW = new Date('2026-10-06T12:00:00Z');
const DAY = 86_400_000;

/** Evidence with `n` graded runs at the given rates (review signals on every run). */
function ev(n: number, merged: number, reviewOk = merged, reworkFree = merged, cost: number | null = 1): ModelEvidence {
  const k = (r: number) => Math.round(n * r);
  return {
    rates: {
      merged: { n, k: k(merged) },
      reviewOk: { n, k: k(reviewOk) },
      reworkFree: { n, k: k(reworkFree) },
    },
    costPerRunUsd: cost,
  };
}

function input(over: Partial<DialCellInput> = {}): DialCellInput {
  return {
    dial: 3,
    prior: { state: 'learning', since: new Date(NOW.getTime() - 30 * DAY).toISOString() },
    now: NOW,
    primary: { armId: 'inc', evidence: ev(400, 0.7) },
    alternates: [{ armId: 'alt', model: 'cheap-model', evidence: ev(400, 0.7, 0.7, 0.7, 0.2), inCell: ev(0, 0) }],
    primaryInCellSinceShift: ev(0, 0),
    gradedPerDay: 20,
    ...over,
  };
}

describe('dialThreshold', () => {
  it('comes from a statistical bound, not a fixed 50', () => {
    const fast = dialThreshold({ dial: 3, primary: ev(200, 0.7).rates, gradedPerDay: 100 });
    // 2·z²·p(1−p)/m² with z=1.645, p≈0.7, m=0.08 is well above 50.
    expect(fast.threshold).toBeGreaterThan(100);
    expect(fast.z).toBeCloseTo(DIAL_SETTINGS[3].z, 5);
    expect(fast.basis).toBe('bound');
  });

  it('a slow cell trades confidence for a threshold it can reach, never below the floor', () => {
    const slow = dialThreshold({ dial: 3, primary: ev(200, 0.7).rates, gradedPerDay: 2 });
    const fast = dialThreshold({ dial: 3, primary: ev(200, 0.7).rates, gradedPerDay: 100 });
    expect(slow.threshold).toBeLessThan(fast.threshold);
    expect(slow.z).toBeLessThan(fast.z);
    expect(slow.z).toBeGreaterThanOrEqual(Z_FLOOR);
    expect(slow.basis).toBe('pace');
    expect(slow.threshold).toBeGreaterThanOrEqual(MIN_THRESHOLD);
  });

  it('a looser dial needs fewer runs', () => {
    const t2 = dialThreshold({ dial: 2, primary: ev(200, 0.7).rates, gradedPerDay: 1000 }).threshold;
    const t5 = dialThreshold({ dial: 5, primary: ev(200, 0.7).rates, gradedPerDay: 1000 }).threshold;
    expect(t5).toBeLessThan(t2);
  });

  it('an unknown pace keeps the bound and reports no eta', () => {
    const t = dialThreshold({ dial: 3, primary: ev(0, 0).rates, gradedPerDay: 0 });
    expect(t.etaDays).toBeNull();
    expect(t.basis).toBe('bound');
  });
});

describe('withinTolerance', () => {
  it('passes equal rates with enough runs', () => {
    expect(withinTolerance(ev(400, 0.7).rates, ev(400, 0.7).rates, 0.08, 1.645).ok).toBe(true);
  });
  it('fails a clearly worse merged rate and names it', () => {
    const r = withinTolerance(ev(400, 0.5).rates, ev(400, 0.7).rates, 0.08, 1.645);
    expect(r.ok).toBe(false);
    expect(r.failing).toContain('merged');
  });
  it('fails a worse review rate even when merges match', () => {
    const r = withinTolerance(ev(400, 0.7, 0.4).rates, ev(400, 0.7).rates, 0.08, 1.645);
    expect(r.ok).toBe(false);
    expect(r.failing).toContain('reviewOk');
  });
});

describe('decideDialCell', () => {
  it('dial 1 is always the primary, even with a good alternate', () => {
    const d = decideDialCell(input({ dial: 1 }));
    expect(d.record.state).toBe('always');
    expect(d.share).toBe(0);
    expect(d.alternateArmId).toBeNull();
  });

  it('no alternates means always', () => {
    const d = decideDialCell(input({ alternates: [] }));
    expect(d.record.state).toBe('always');
  });

  it('turning the dial to 1 while shifted is recorded, never silent', () => {
    const prior: DialStateRecord = { state: 'shifted', since: NOW.toISOString(), alternateArmId: 'alt' };
    const d = decideDialCell(input({ dial: 1, prior }));
    expect(d.record.state).toBe('always');
    expect(d.event?.kind).toBe('dial');
  });

  it('starts learning when alternates appear, and says so', () => {
    const d = decideDialCell(input({ prior: null, alternates: [{ armId: 'alt', model: 'm', evidence: ev(0, 0), inCell: ev(0, 0) }] }));
    expect(d.record.state).toBe('learning');
    expect(d.event?.kind).toBe('dial');
  });

  it('does not promote below the threshold, however good the alternate looks', () => {
    const d = decideDialCell(input({
      alternates: [{ armId: 'alt', model: 'm', evidence: ev(MIN_THRESHOLD - 1, 1, 1, 1, 0.1), inCell: ev(0, 0) }],
    }));
    expect(d.record.state).toBe('learning');
    expect(d.share).toBe(0);
    expect(d.progress?.graded).toBe(MIN_THRESHOLD - 1);
    expect(d.progress!.threshold).toBeGreaterThan(MIN_THRESHOLD - 1);
    expect(d.progress?.candidate).toBe('alt');
  });

  it('does not promote above the threshold when outside the margin', () => {
    const d = decideDialCell(input({
      alternates: [{ armId: 'alt', model: 'm', evidence: ev(400, 0.5, 0.5, 0.5, 0.1), inCell: ev(0, 0) }],
    }));
    expect(d.record.state).toBe('learning');
    expect(d.progress?.note).toBeTruthy();
  });

  it('promotes above the threshold within the margin, at the dial share, with an event', () => {
    const d = decideDialCell(input());
    expect(d.record.state).toBe('shifted');
    expect(d.alternateArmId).toBe('alt');
    expect(d.share).toBe(DIAL_SETTINGS[3].maxShare);
    expect(d.event?.kind).toBe('promotion');
  });

  it('the primary needs the threshold too', () => {
    const d = decideDialCell(input({ primary: { armId: 'inc', evidence: ev(10, 0.7) } }));
    expect(d.record.state).toBe('learning');
  });

  it('picks the cheapest passing alternate', () => {
    const d = decideDialCell(input({
      alternates: [
        { armId: 'mid', model: 'mid', evidence: ev(400, 0.7, 0.7, 0.7, 0.5), inCell: ev(0, 0) },
        { armId: 'low', model: 'low', evidence: ev(400, 0.7, 0.7, 0.7, 0.1), inCell: ev(0, 0) },
      ],
    }));
    expect(d.alternateArmId).toBe('low');
  });

  it('dial position sets the share', () => {
    const prior: DialStateRecord = { state: 'shifted', since: NOW.toISOString(), alternateArmId: 'alt' };
    expect(decideDialCell(input({ dial: 2, prior })).share).toBe(DIAL_SETTINGS[2].maxShare);
    expect(decideDialCell(input({ dial: 5, prior })).share).toBe(DIAL_SETTINGS[5].maxShare);
    expect(DIAL_SETTINGS[2].maxShare).toBeLessThan(DIAL_SETTINGS[5].maxShare);
  });

  it('auto-reverts on regression in the cell, with a reason', () => {
    const prior: DialStateRecord = { state: 'shifted', since: NOW.toISOString(), alternateArmId: 'alt' };
    const d = decideDialCell(input({
      prior,
      alternates: [{ armId: 'alt', model: 'cheap-model', evidence: ev(400, 0.7), inCell: ev(30, 0.4) }],
      primaryInCellSinceShift: ev(30, 0.75),
    }));
    expect(d.record.state).toBe('reverted');
    expect(d.share).toBe(0);
    expect(d.alternateArmId).toBeNull();
    expect(d.event?.kind).toBe('revert');
    expect(d.record.revertReason).toMatch(/merged/);
  });

  it('stays shifted while the alternate keeps up', () => {
    const prior: DialStateRecord = { state: 'shifted', since: NOW.toISOString(), alternateArmId: 'alt' };
    const d = decideDialCell(input({
      prior,
      alternates: [{ armId: 'alt', model: 'cheap-model', evidence: ev(400, 0.7), inCell: ev(30, 0.7) }],
      primaryInCellSinceShift: ev(30, 0.7),
    }));
    expect(d.record.state).toBe('shifted');
    expect(d.event).toBeUndefined();
  });

  it('a revert holds for the cooldown, then learning restarts on fresh evidence', () => {
    const revertedAt = new Date(NOW.getTime() - 2 * DAY).toISOString();
    const prior: DialStateRecord = { state: 'reverted', since: revertedAt, revertedAt, revertReason: 'x' };
    expect(decideDialCell(input({ prior })).record.state).toBe('reverted');
    const old = new Date(NOW.getTime() - (REVERT_COOLDOWN_DAYS + 1) * DAY).toISOString();
    const later = decideDialCell(input({ prior: { state: 'reverted', since: old, revertedAt: old, revertReason: 'x' } }));
    expect(later.record.state).toBe('learning');
    expect(later.record.evidenceSince).toBe(old);
  });

  it('a removed shifted alternate falls back to learning, recorded', () => {
    const prior: DialStateRecord = { state: 'shifted', since: NOW.toISOString(), alternateArmId: 'gone' };
    const d = decideDialCell(input({ prior }));
    expect(d.record.state).not.toBe('shifted');
    expect(d.event).toBeTruthy();
  });
});

describe('dialAllocation / decideDialArm', () => {
  const arms = [
    { id: 'inc', role: 'incumbent' as const, status: 'active' as const },
    { id: 'alt', role: 'challenger' as const, status: 'active' as const },
  ];

  it('learning allocates everything to the primary', () => {
    expect(dialAllocation(arms, { state: 'learning', since: '' }, 3)).toEqual({ inc: 1, alt: 0 });
  });

  it('shifted splits by the dial share', () => {
    const a = dialAllocation(arms, { state: 'shifted', since: '', alternateArmId: 'alt' }, 3);
    expect(a.alt).toBe(DIAL_SETTINGS[3].maxShare);
    expect(a.inc + a.alt).toBeCloseTo(1, 6);
  });

  it('dial 1 allocates everything to the primary even when shifted', () => {
    expect(dialAllocation(arms, { state: 'shifted', since: '', alternateArmId: 'alt' }, 1)).toEqual({ inc: 1, alt: 0 });
  });

  it('shadow never changes the served model, whatever the draw or prior said', () => {
    for (const state of ['learning', 'reverted', 'always'] as const) {
      const pick = decideDialArm({ record: { state, since: '' }, incumbentId: 'inc', drawnArmId: 'alt', shadowArmId: 'alt' });
      expect(pick.armId).toBe('inc');
      expect(pick.shadowArmId).toBe(state === 'learning' ? 'alt' : null);
    }
  });

  it('shifted serves the draw, but only onto the shifted alternate', () => {
    const rec: DialStateRecord = { state: 'shifted', since: '', alternateArmId: 'alt' };
    expect(decideDialArm({ record: rec, incumbentId: 'inc', drawnArmId: 'alt', shadowArmId: null }).armId).toBe('alt');
    expect(decideDialArm({ record: rec, incumbentId: 'inc', drawnArmId: 'other', shadowArmId: null }).armId).toBe('inc');
  });
});

describe('applyDialChange', () => {
  it('dial 1 stops a shift immediately, with an event', () => {
    const r = applyDialChange({ prior: { state: 'shifted', since: '', alternateArmId: 'alt' }, dial: 1, alternates: 1, now: NOW });
    expect(r.record.state).toBe('always');
    expect(r.event?.kind).toBe('dial');
  });

  it('turning up from always starts learning (shadow first, never straight to shifted)', () => {
    const r = applyDialChange({ prior: { state: 'always', since: '' }, dial: 5, alternates: 2, now: NOW });
    expect(r.record.state).toBe('learning');
    expect(r.event).toBeTruthy();
  });

  it('moving the dial on a shifted cell keeps the state (the share follows the dial)', () => {
    const prior: DialStateRecord = { state: 'shifted', since: 'x', alternateArmId: 'alt' };
    const r = applyDialChange({ prior, dial: 4, alternates: 1, now: NOW });
    expect(r.record).toEqual(prior);
    expect(r.event).toBeUndefined();
  });
});

import { describe, expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import { groupByStage } from '@/components/ui/Pipeline';
import { buildActivityNow, type ActivityNow, type NowRow } from '@/lib/activity-delivery';
import type { DeliveryKind } from '@/lib/delivery-projection';
import { activityFixture } from '../../dev/fixtures/activity-delivery-fixtures';
import { MISSION_STRIP_CAP, failingCheckOf, meterOf, missionsInMotion, nowDeliveries, waitingOnYou } from './now-board';

const reading = (kind: DeliveryKind, over: { repairRounds?: number; reconciling?: boolean } = {}) =>
  meterOf({ kind, repairRounds: over.repairRounds ?? 0, reconciling: over.reconciling ?? false });

describe('meterOf: the StageMeter reading of each delivery kind', () => {
  it('reads every kind onto Build / Verify / Deliver, with not-started work queued', () => {
    expect(reading('build')).toEqual({ state: 'build' });
    expect(reading('audit')).toEqual({ state: 'verify' });
    expect(reading('repair', { repairRounds: 3 })).toEqual({ state: 'fixing-in-verify', fixRounds: 3 });
    expect(reading('unavailable')).toEqual({ state: 'check-cant-run', stage: 'verify' });
    expect(reading('needs')).toEqual({ state: 'waiting-on-you', stage: 'verify' });
    expect(reading('landing')).toEqual({ state: 'deliver' });
    for (const k of ['waiting', 'held', 'planning'] as const) expect(reading(k)).toEqual({ state: 'queued' });
  });

  it('a PR closed unmerged waits on a person unless the platform is still reconciling it', () => {
    expect(reading('notlanded')).toEqual({ state: 'waiting-on-you', stage: 'deliver' });
    expect(reading('notlanded', { reconciling: true })).toEqual({ state: 'check-cant-run', stage: 'deliver' });
  });
});

describe('failingCheckOf', () => {
  const row = (evidence: NowRow['evidence'], repairReason: NowRow['delivery']['repairReason'] = null) =>
    ({ evidence, delivery: { repairReason } }) as unknown as NowRow;
  const gate = (name: string, tone: 'error' | 'success', result: string, isVoid = false) => ({ name, glyph: '', tone, result, void: isVoid, why: null });

  it('names the current head\'s failing gate', () => {
    expect(failingCheckOf(row([{ type: 'revision', sha: null, current: true, round: null, gates: [gate('Review', 'success', 'passed'), gate('CI', 'error', 'failed')] }]))).toBe('CI failed');
  });

  it('ignores an older head and a void gate, then falls back to why the repair started', () => {
    expect(failingCheckOf(row([
      { type: 'revision', sha: null, current: true, round: null, gates: [gate('Review', 'error', 'changes requested', true)] },
      { type: 'revision', sha: null, current: false, round: null, gates: [gate('CI', 'error', 'failed')] },
    ], 'conflict'))).toBe('branch conflict');
    expect(failingCheckOf(row([]))).toBeNull();
  });
});

describe('nowDeliveries: one list for the Pipeline, the rows and the cards', () => {
  it('holds each delivery once, folded waiting rows included', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00Z');
    const iso = new Date(nowMs).toISOString();
    const tasks = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, title: `Waiting ${i}`, status: 'pending', missionId: null, createdAt: iso, updatedAt: iso, workers: [] }));
    const now = buildActivityNow({ tasks, missions: [], rules, now: nowMs });
    expect(now.groups[0].hiddenWaitingRows.length).toBeGreaterThan(0);
    const doubled: ActivityNow = { ...now, groups: [...now.groups, { ...now.groups[0], missionId: 'other' }] };
    const list = nowDeliveries(doubled);
    expect(list.map(d => d.id).sort()).toEqual(tasks.map(t => t.id).sort());
    expect(groupByStage(list).queued).toHaveLength(6);
  });

  it('tags mission work with its mission, and only a delivery being fixed carries a failing check', () => {
    const list = nowDeliveries(activityFixture(3).now);
    for (const d of list) {
      if (d.state === 'fixing-in-verify') continue;
      expect(d.failingCheck).toBeNull();
    }
    const t34 = list.find(d => d.id === 'fx-t34')!;
    expect(t34.missionTitle).toBe('Billing exports: CSV and scheduled email');
    expect(t34.title).not.toMatch(/^feat:/);
  });
});

describe('waitingOnYou', () => {
  it('lists exactly the deliveries whose meter reads waiting on you', () => {
    const list = nowDeliveries(activityFixture(4).now);
    const waiting = waitingOnYou(list);
    expect(waiting.map(w => w.id)).toEqual(list.filter(d => d.state === 'waiting-on-you').map(d => d.id));
    expect(waiting.length).toBeGreaterThan(0);
    for (const w of waiting) expect(w.reason).toMatch(/^(Review|Closed unmerged)( · \d+ retr(y|ies))?$/);
  });
});

describe('missionsInMotion', () => {
  it('draws open work first when a mission has more tasks than the strip holds', () => {
    const now = activityFixture(4).now;
    const list = nowDeliveries(now);
    const missions = missionsInMotion(now, list);
    expect(missions.length).toBeGreaterThan(0);
    for (const m of missions) {
      expect(m.segments.length).toBeLessThanOrEqual(MISSION_STRIP_CAP);
      const group = now.groups.find(g => g.missionId === m.id)!;
      const open = [...group.rows, ...group.hiddenWaitingRows].length;
      // Every open delivery is drawn, however many merged before it.
      expect(m.segments.filter(s => s !== 'merged').length).toBeGreaterThanOrEqual(Math.min(open, MISSION_STRIP_CAP));
    }
    const billing = missions.find(m => m.title.startsWith('Billing'))!;
    expect(billing.landed).toBeGreaterThan(MISSION_STRIP_CAP);
    expect(billing.segments.filter(s => s !== 'merged').length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'bun:test';
import type { CatalogEntry } from '../model-catalog';
import type { ArmEvidence } from '../tier-explore';
import { planPoolDay, type DailyPool, type DailyPoolArm } from '../tier-pool-daily';

const NOW = new Date('2026-09-27T06:00:00Z');
const nowS = NOW.getTime() / 1000;
const DAY = 86_400;

function entry(id: string, over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id, canonicalId: null, openRouterId: `anthropic/${id}`, permaslug: `anthropic/${id}`, provider: 'anthropic',
    displayName: id, contextLength: 400_000, created: nowS - 300 * DAY, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75,
    ...over,
  };
}

function armRow(id: string, model: string, over: Partial<DailyPoolArm> = {}): DailyPoolArm {
  return {
    id, route: 'runner:claude', model, role: 'challenger', status: 'active', source: 'admin',
    addedAt: new Date(NOW.getTime() - 60 * DAY * 1000), stats: {}, ...over,
  };
}

function pool(over: Partial<DailyPool> = {}): DailyPool {
  return {
    id: 'pool-1', teamId: 'team-1', tier: 'standard', surface: 'agent', mode: 'explore', policyVersion: 1,
    allocation: { inc: 0.9, ch: 0.1 }, allocationVersion: 7, autoChallenger: false,
    arms: [
      armRow('inc', 'claude-sonnet-5', { role: 'incumbent', source: 'registry' }),
      armRow('ch', 'qwen-coder-x', { route: 'runner:claude' }),
    ],
    ...over,
  };
}

const quiet: ArmEvidence = { graded: 0, successes: 0, failures: 0, earlyCritical: 0, spread: { units: 0, conversations: 0, users: 0 } };
const evidence = (ids: string[], e: ArmEvidence = quiet) => new Map(ids.map(id => [id, e]));

const catalog = [entry('claude-sonnet-5'), entry('claude-sonnet-5-1', { created: nowS - 20 * DAY })];

describe('planPoolDay — succession', () => {
  it('split: a successor is a suggestion row; traffic is untouched', () => {
    const plan = planPoolDay({ pool: pool({ mode: 'split', allocation: { inc: 0.9, ch: 0.1 } }), evidence: evidence(['inc', 'ch']), catalog, rankings: {}, now: NOW });
    expect(plan.actions).toEqual([{
      type: 'suggest', key: 'succession:inc:claude-sonnet-5-1', actorSystem: 'system:succession',
      evidence: { signal: 'succession', armId: 'inc', model: 'claude-sonnet-5', successor: 'claude-sonnet-5-1', route: 'runner:claude', action: 'add' },
    }]);
  });

  it('explore + auto-challenger with room: proposes the successor as a new arm', () => {
    const plan = planPoolDay({ pool: pool({ autoChallenger: true }), evidence: evidence(['inc', 'ch']), catalog, rankings: {}, now: NOW });
    expect(plan.actions.find(a => a.type === 'add_challenger')).toMatchObject({ route: 'runner:claude', model: 'claude-sonnet-5-1' });
    expect(plan.actions.some(a => a.type === 'suggest')).toBe(false);
  });

  it('explore without auto-challenger: a suggestion instead', () => {
    const plan = planPoolDay({ pool: pool(), evidence: evidence(['inc', 'ch']), catalog, rankings: {}, now: NOW });
    expect(plan.actions.some(a => a.type === 'add_challenger')).toBe(false);
    expect(plan.actions.find(a => a.type === 'suggest')).toMatchObject({ key: 'succession:inc:claude-sonnet-5-1' });
  });

  it('explore with the successor in the pool: the old arm\'s cap decays from the day it joined', () => {
    const p = pool({
      allocation: { inc: 0.9, succ: 0.1 },
      arms: [
        armRow('inc', 'claude-sonnet-5', { role: 'incumbent', source: 'registry' }),
        armRow('succ', 'claude-sonnet-5-1', { addedAt: new Date(NOW.getTime() - 28 * DAY * 1000) }),
      ],
    });
    const plan = planPoolDay({ pool: p, evidence: evidence(['inc', 'succ']), catalog, rankings: {}, now: NOW });
    const signal = plan.step!.evidence.signals.find(s => s.kind === 'succession');
    expect(signal).toMatchObject({ armId: 'inc', successorArmId: 'succ', multiplier: 0.25 });
    // Incumbent cap: 0.2 + 0.8 · 0.25.
    expect(plan.step!.evidence.arms.inc.capAfter).toBe(0.4);
  });

  it('a held decay stays at its frozen multiplier', () => {
    const p = pool({
      allocation: { inc: 0.9, succ: 0.1 },
      arms: [
        armRow('inc', 'claude-sonnet-5', { role: 'incumbent', source: 'registry', stats: { successionHold: { successorArmId: 'succ', multiplier: 0.8 } } }),
        armRow('succ', 'claude-sonnet-5-1', { addedAt: new Date(NOW.getTime() - 28 * DAY * 1000) }),
      ],
    });
    const plan = planPoolDay({ pool: p, evidence: evidence(['inc', 'succ']), catalog, rankings: {}, now: NOW });
    expect(plan.step!.evidence.signals.find(s => s.kind === 'succession')).toMatchObject({ multiplier: 0.8 });
  });
});

describe('planPoolDay — popularity and expiry', () => {
  const noSucc = [entry('claude-sonnet-5'), entry('qwen-coder-x', { provider: 'anthropic' })];

  it('explore: records each arm\'s popularity prior (view, asOf, m) in the evidence', () => {
    const rankings = {
      tool_calling: { asOf: '2026-09-26T02:00:00Z', startDate: null, endDate: null, scores: { 'claude-sonnet-5': 1 } },
      programming: { asOf: '2026-09-26T02:00:00Z', startDate: null, endDate: null, scores: { 'claude-sonnet-5': 1 } },
    };
    const plan = planPoolDay({ pool: pool(), evidence: evidence(['inc', 'ch']), catalog: noSucc, rankings, now: NOW });
    expect(plan.step!.evidence.arms.inc.prior).toEqual({ signal: 'popularity', views: ['tool_calling', 'programming'], asOf: '2026-09-26T02:00:00Z', m: 0.55 });
    expect(plan.step!.evidence.arms.ch.prior?.m).toBe(0.45);
    // A learning challenger at 10% with nothing else going on: no write.
    expect(plan.actions).toEqual([]);
  });

  it('split: popularity is never read', () => {
    const rankings = { text: { asOf: '2026-09-26T02:00:00Z', startDate: null, endDate: null, scores: { 'claude-sonnet-5': 1 } } };
    const plan = planPoolDay({ pool: pool({ mode: 'split', surface: 'chat' }), evidence: evidence(['inc', 'ch']), catalog: noSucc, rankings, now: NOW });
    expect(plan.step).toBeNull();
    expect(plan.actions).toEqual([]);
  });

  it('split: an expired model goes to 0 as system:expiry', () => {
    const cat = [entry('claude-sonnet-5'), entry('qwen-coder-x', { provider: 'anthropic', expiresAt: nowS - DAY })];
    const plan = planPoolDay({ pool: pool({ mode: 'split', allocation: { inc: 0.7, ch: 0.3 } }), evidence: evidence(['inc', 'ch']), catalog: cat, rankings: {}, now: NOW });
    expect(plan.actions).toEqual([expect.objectContaining({ type: 'allocate', allocation: { inc: 1, ch: 0 }, actorSystem: 'system:expiry' })]);
  });

  it('explore: an arm expiring within 14 days is capped to 0 through the steps', () => {
    const cat = [entry('claude-sonnet-5'), entry('qwen-coder-x', { provider: 'anthropic', expiresAt: nowS + 5 * DAY })];
    const plan = planPoolDay({ pool: pool(), evidence: evidence(['inc', 'ch']), catalog: cat, rankings: {}, now: NOW });
    expect(plan.actions).toEqual([expect.objectContaining({ type: 'allocate', allocation: { inc: 1, ch: 0 }, actorSystem: 'system:expiry' })]);
  });
});

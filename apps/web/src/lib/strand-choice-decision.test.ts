import { describe, expect, it } from 'bun:test';
import {
  STRAND_CHOICE_LABELS,
  STRAND_CHOICE_MIN_CONFIDENCE,
  adviseStrandChoice,
  buildStrandChoiceState,
  strandButtonOrder,
  strandChoiceFacts,
  strandLabelLine,
  type StrandChoiceFacts,
} from './strand-choice-decision';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const ago = (m: number) => new Date(NOW - m * 60_000);

const facts: StrandChoiceFacts = {
  missionId: '11111111-2222-4333-8444-555555555555',
  teamId: 'team-1',
  workspaceId: 'ws-1',
  executor: 'local',
  quietMinutes: 130,
  lastSessionMinutesAgo: 180,
  claimableTasks: 1,
  claimableRoles: ['builder'],
  needsBrowser: false,
  depBlockedTasks: 0,
  openPrs: { checksRunning: 0, green: 1, red: 0, conflict: 0, underReview: 1 },
  flipRefused: false,
};

const okDecide = (choice: string, confidence: number) => async () => ({
  ok: true as const,
  answers: { pick: { choice, confidence } },
  model: 'typesafe/jev-1.13',
  latencyMs: 12,
  usage: { inputTokens: 100, outputTokens: 0, costUsd: 0.00001 },
});
const allowed = async () => ({ ok: true as const, apiKey: 'k', model: 'typesafe/jev-1.13' });

describe('strand choice: structured facts only', () => {
  it('state carries numbers, slugs and flags — never a title, description or diff', () => {
    const state = buildStrandChoiceState(facts);
    const json = JSON.stringify(state);
    expect(Object.keys(state.mission).sort()).toEqual([
      'claimableRoles', 'claimableTasks', 'depBlockedTasks', 'executor', 'flipRefused',
      'lastSessionMinutesAgo', 'needsBrowser', 'openPrs', 'sessionQuietMinutes',
    ]);
    expect(json).not.toContain(facts.missionId);
  });

  it('facts from rows: quiet time, claimable roles, browser need, PR states', () => {
    const f = strandChoiceFacts({
      missionId: 'm', teamId: 't', workspaceId: 'w', executor: 'local',
      strand: { stranded: true, quietMs: 90 * 60_000, claimableTaskIds: ['audit'], lastSessionAt: ago(200).toISOString(), flipBlockedReason: null },
      tasks: [
        { id: 'audit', status: 'pending', roleSlug: 'visual-auditor', workers: [] },
        { id: 'blocked', status: 'pending', dependsOn: ['done'], workers: [] },
        { id: 'done', status: 'completed', workers: [{ status: 'completed', prNumber: 4, prUrl: 'https://x/4', prLifecycleStatus: 'ci_running' }] },
      ],
      now: NOW,
    });
    expect(f).toMatchObject({
      quietMinutes: 90, lastSessionMinutesAgo: 200, claimableTasks: 1, claimableRoles: ['visual-auditor'],
      needsBrowser: true, depBlockedTasks: 1, flipRefused: false,
    });
    expect(f.openPrs.checksRunning).toBe(1);
  });

  it('labels are the three the task names', () => {
    expect([...STRAND_CHOICE_LABELS]).toEqual(['continue-on-runner', 'wait-for-local', 'blocked-on-deps']);
  });
});

describe('adviseStrandChoice — shadow, fail open', () => {
  it('disabled capability: no call, null (today’s behaviour)', async () => {
    let called = false;
    const r = await adviseStrandChoice(facts, {
      resolveAccess: async () => ({ ok: false as const, error: { kind: 'capability_disabled' as const, capability: 'mission_strand_choice' as const } }),
      decide: (async () => { called = true; return okDecide('wait-for-local', 0.99)(); }) as any,
      cache: new Map(), log: () => {},
    });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  it('a sensitive workspace never sends anything out', async () => {
    let called = false;
    const r = await adviseStrandChoice({ ...facts, dataClass: 'sensitive' }, {
      resolveAccess: allowed as any, decide: (async () => { called = true; return okDecide('wait-for-local', 0.99)(); }) as any,
      cache: new Map(), log: () => {},
    });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  it('an error logs a [decision-shadow] line with the kind and returns null', async () => {
    const lines: string[] = [];
    const r = await adviseStrandChoice(facts, {
      resolveAccess: allowed as any,
      decide: (async () => ({ ok: false, error: { kind: 'timeout' }, latencyMs: 4000 })) as any,
      cache: new Map(), log: l => lines.push(l),
    });
    expect(r).toBeNull();
    expect(lines[0]).toStartWith('[decision-shadow] ');
    expect(JSON.parse(lines[0].slice('[decision-shadow] '.length))).toMatchObject({ site: 'mission_strand', error: 'timeout' });
  });

  it('a throw is swallowed', async () => {
    const r = await adviseStrandChoice(facts, {
      resolveAccess: allowed as any, decide: (async () => { throw new Error('boom'); }) as any, cache: new Map(), log: () => {},
    });
    expect(r).toBeNull();
  });

  it('logs id, label and confidence only, and caches by mission + facts', async () => {
    const lines: string[] = [];
    let calls = 0;
    const cache = new Map();
    const deps = {
      resolveAccess: allowed as any,
      decide: (async () => { calls++; return okDecide('wait-for-local', 0.91)(); }) as any,
      cache, log: (l: string) => lines.push(l),
    };
    const r = await adviseStrandChoice(facts, deps);
    expect(r).toEqual({ pick: 'wait-for-local', confidence: 0.91 });
    const rec = JSON.parse(lines[0].slice('[decision-shadow] '.length));
    expect(rec).toMatchObject({ site: 'mission_strand', mission: '11111111', pick: 'wait-for-local', confidence: 0.91 });
    expect(Object.keys(rec)).not.toContain('title');
    await adviseStrandChoice(facts, deps);
    expect(calls).toBe(1);
  });
});

describe('strandButtonOrder — the pick only orders the buttons', () => {
  it('shadow: always today’s order, whatever the pick', () => {
    expect(strandButtonOrder({ pick: 'wait-for-local', confidence: 0.99 }, 'shadow')).toBe('runner-first');
  });
  it('no pick (fail open): today’s order', () => {
    expect(strandButtonOrder(null, 'gated')).toBe('runner-first');
  });
  it('gated: a confident wait-for-local puts Keep local first', () => {
    expect(strandButtonOrder({ pick: 'wait-for-local', confidence: STRAND_CHOICE_MIN_CONFIDENCE }, 'gated')).toBe('local-first');
  });
  it('gated: below the gate, today’s order', () => {
    expect(strandButtonOrder({ pick: 'wait-for-local', confidence: STRAND_CHOICE_MIN_CONFIDENCE - 0.01 }, 'gated')).toBe('runner-first');
  });
  it('gated: continue-on-runner and blocked-on-deps keep today’s order', () => {
    expect(strandButtonOrder({ pick: 'continue-on-runner', confidence: 0.99 }, 'gated')).toBe('runner-first');
    expect(strandButtonOrder({ pick: 'blocked-on-deps', confidence: 0.99 }, 'gated')).toBe('runner-first');
  });
});

describe('the owner’s tap is recorded as a label', () => {
  it('content-free [decision-label] line', () => {
    const line = strandLabelLine({ missionId: facts.missionId, label: 'continue-on-runner', order: 'runner-first', quietMs: 130 * 60_000 });
    expect(line).toStartWith('[decision-label] ');
    expect(JSON.parse(line.slice('[decision-label] '.length))).toEqual({
      site: 'mission_strand', mission: '11111111', label: 'continue-on-runner', order: 'runner-first', quietMinutes: 130,
    });
  });
});

describe('decision ledger recording', () => {
  for (const [choice, confidence, applied] of [
    ['wait-for-local', 0.92, true],
    ['wait-for-local', 0.85, true],
    ['wait-for-local', 0.80, false],
    ['continue-on-runner', 0.99, false],
  ] as const) {
    it(`records ${choice} at ${confidence}`, async () => {
      const rows: any[] = [];
      await adviseStrandChoice(facts, {
        resolveAccess: allowed as any, decide: okDecide(choice, confidence) as any,
        cache: new Map(), log: () => {},
        recordDecision: async row => { rows.push(row); return null; },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        capability: 'mission_strand_choice', missionId: facts.missionId,
        promptVersion: 'ms1', confidence, ruleAnswer: 'runner-first',
        applied, status: applied ? 'applied' : 'suggested',
      });
    });
  }
  for (const reason of ['missing_key', 'timeout', 'sensitive', 'non_jev', 'throw']) {
    it(`records fallback for ${reason}`, async () => {
      const rows: any[] = [];
      const result = await adviseStrandChoice({ ...facts, dataClass: reason === 'sensitive' ? 'sensitive' : null }, {
        resolveAccess: (async () => reason === 'missing_key'
          ? { ok: false, error: { kind: 'missing_key' } } : await allowed()) as any,
        decide: (async () => {
          if (reason === 'throw') throw new Error('test failure');
          return reason === 'timeout' ? { ok: false, error: { kind: 'timeout' }, latencyMs: 3000 }
            : { ...await okDecide('wait-for-local', 0.99)(), model: reason === 'non_jev' ? 'other-model' : 'typesafe/jev-1.13' };
        }) as any,
        cache: new Map(), log: () => {},
        recordDecision: async row => { rows.push(row); return null; },
      });
      expect(result).toBeNull();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        promptVersion: 'ms1', ruleAnswer: 'runner-first', appliedAnswer: 'runner-first',
        applied: false, status: 'fallback',
      });
    });
  }
});

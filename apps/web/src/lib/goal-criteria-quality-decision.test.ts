import { describe, expect, it } from 'bun:test';
import type { GoalCriterion } from '@buildd/shared';
import { criterionFingerprint } from '@buildd/core/mission-helpers';
import {
  GOAL_QUALITY_CAPABILITY,
  GOAL_QUALITY_MIN_CONFIDENCE,
  GOAL_QUALITY_MODE,
  GOAL_QUALITY_PROMPT_VERSION,
  GOAL_QUALITY_REWRITES,
  adviseGoalQuality,
  buildGoalQualityQuestions,
  buildGoalQualityState,
  goalQualityWarnings,
  gradedCriteria,
  type GoalQualityFacts,
} from './goal-criteria-quality-decision';

const MISSION_ID = '11111111-2222-4333-8444-555555555555';
const SECRET_COMMAND = 'bun run scripts/check-secret-thing.ts --flag';

const outcome: GoalCriterion = { type: 'command', command: SECRET_COMMAND, label: 'A visitor can sign up from the landing page' };
const weakCommand: GoalCriterion = { type: 'command', command: 'bun run test', label: 'tests pass' };
const prose: GoalCriterion = {
  type: 'description',
  description: 'The settings page feels faster',
  notMechanizableReason: 'perceived speed has no single script',
};
const prs: GoalCriterion = { type: 'all_prs_merged' };
const open: GoalCriterion = { type: 'no_open_tasks' };

function facts(criteria: GoalCriterion[], over: Partial<GoalQualityFacts> = {}): GoalQualityFacts {
  return { missionId: MISSION_ID, teamId: 'team-1', workspaceId: 'ws-1', criteria, ...over };
}

const allowed = async () => ({ ok: true as const, apiKey: 'k', model: 'jev-test' });

/** A decide stub answering every question it is asked with `pick`. */
function answering(pick: (name: string) => [string, number]) {
  const calls: any[] = [];
  const decide = async (req: any) => {
    calls.push(req);
    const answers: Record<string, unknown> = {};
    for (const name of Object.keys(req.questions)) {
      const [choice, confidence] = pick(name);
      answers[name] = { type: 'choice', choice, confidence, probabilities: {} };
    }
    return { ok: true as const, answers, model: 'jev-test', latencyMs: 9, usage: { inputTokens: 80, outputTokens: 0, costUsd: 0.00001 } };
  };
  return { decide: decide as any, calls };
}

describe('buildGoalQualityState: what the call may see', () => {
  it('sends type, label and (for prose) the description — never a command, id or mission field', () => {
    const state = buildGoalQualityState([outcome, prose]);
    expect(state).toEqual({
      criteria: [
        { type: 'command', label: 'A visitor can sign up from the landing page' },
        { type: 'description', description: 'The settings page feels faster' },
      ],
    });
    const json = JSON.stringify(state);
    expect(json).not.toContain(SECRET_COMMAND);
    expect(json).not.toContain('notMechanizableReason');
    expect(json).not.toContain('perceived speed');
  });

  it('artifact keys are not sent either', () => {
    const state = buildGoalQualityState([{ type: 'artifact_exists', key: 'private-key-name', label: 'Launch report' }]);
    expect(JSON.stringify(state)).not.toContain('private-key-name');
  });
});

describe('gradedCriteria: what gets graded', () => {
  it('bookkeeping is never sent', () => {
    expect(gradedCriteria([prs, outcome, open]).map(g => g.index)).toEqual([1]);
  });

  it('on PATCH, criteria byte-identical to a stored one are not re-graded', () => {
    expect(gradedCriteria([outcome, weakCommand], [outcome]).map(g => g.index)).toEqual([1]);
    expect(gradedCriteria([outcome], [outcome])).toEqual([]);
  });
});

describe('the question', () => {
  it('asks noticeable of every graded criterion, checkable only of prose, and one rewrite', () => {
    const q = buildGoalQualityQuestions([
      { index: 0, criterion: outcome },
      { index: 3, criterion: prose },
    ]);
    expect(Object.keys(q).sort()).toEqual(['c0_noticeable', 'c1_checkable', 'c1_noticeable', 'rewrite']);
    expect(Object.keys(q.c0_noticeable.criteria).sort()).toEqual(['bookkeeping', 'no', 'yes']);
    expect(Object.keys(q.c1_checkable!.criteria).sort()).toEqual(['no', 'yes']);
    expect(Object.keys(q.rewrite.criteria).sort()).toEqual(['artifact-proof', 'command-proof', 'none', 'state-outcome']);
  });

  it('each label is defined contrastively', () => {
    const q = buildGoalQualityQuestions([{ index: 0, criterion: prose }]);
    for (const def of [...Object.values(q.c0_noticeable.criteria), ...Object.values(q.c0_checkable!.criteria)]) {
      expect(def).toMatchObject({ what: expect.any(String), not_for: expect.any(String) });
    }
  });

  it('the rubric names bookkeeping and judges a command by the outcome it asserts', () => {
    const json = JSON.stringify(buildGoalQualityQuestions([{ index: 0, criterion: outcome }]));
    expect(json).toContain('all PRs merged');
    expect(json).toContain('no open tasks');
    expect(json).toMatch(/command.*user/i);
  });

  it('rendered suggestions are code-owned, one per rewrite label', () => {
    expect(GOAL_QUALITY_REWRITES.none).toBeNull();
    expect(GOAL_QUALITY_REWRITES['command-proof']).toContain('exits 0');
    expect(GOAL_QUALITY_REWRITES['artifact-proof']).toContain('artifact_exists');
  });

  it('ships shadow, versioned, on its own opt-in capability', () => {
    expect(GOAL_QUALITY_MODE).toBe('shadow');
    expect(GOAL_QUALITY_CAPABILITY).toBe('mission_goal_quality');
    expect(GOAL_QUALITY_PROMPT_VERSION).toBeTruthy();
  });
});

describe('adviseGoalQuality — fail open', () => {
  it('capability disabled: no call, null', async () => {
    const { decide, calls } = answering(() => ['no', 0.99]);
    const r = await adviseGoalQuality(facts([weakCommand]), {
      resolveAccess: async () => ({ ok: false as const, error: { kind: 'capability_disabled' as const, capability: 'mission_goal_quality' as const } }),
      decide, cache: new Map(), log: () => {},
    });
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('no decision key: null', async () => {
    const { decide, calls } = answering(() => ['no', 0.99]);
    const r = await adviseGoalQuality(facts([weakCommand]), {
      resolveAccess: async () => ({ ok: false as const, error: { kind: 'missing_key' as const } }),
      decide, cache: new Map(), log: () => {},
    });
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a sensitive workspace sends nothing — access is not even resolved', async () => {
    let resolved = false;
    const { decide, calls } = answering(() => ['no', 0.99]);
    const r = await adviseGoalQuality(facts([weakCommand], { dataClass: 'sensitive' }), {
      resolveAccess: (async () => { resolved = true; return allowed(); }) as any,
      decide, cache: new Map(), log: () => {},
    });
    expect(r).toBeNull();
    expect(resolved).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('nothing to grade (bookkeeping only): no call, null', async () => {
    const { decide, calls } = answering(() => ['no', 0.99]);
    const r = await adviseGoalQuality(facts([prs, open]), { resolveAccess: allowed as any, decide, cache: new Map(), log: () => {} });
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('timeout: logs the error kind, returns null', async () => {
    const lines: string[] = [];
    const r = await adviseGoalQuality(facts([weakCommand]), {
      resolveAccess: allowed as any,
      decide: (async () => ({ ok: false, error: { kind: 'timeout' }, latencyMs: 3000 })) as any,
      cache: new Map(), log: l => lines.push(l),
    });
    expect(r).toBeNull();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0].slice('[decision-shadow] '.length))).toMatchObject({ site: 'goal_criteria_quality', error: 'timeout', mission: '11111111' });
  });

  it('a throw from decide or from resolveAccess is swallowed', async () => {
    const quiet = { cache: new Map(), log: () => {} };
    expect(await adviseGoalQuality(facts([weakCommand]), {
      ...quiet, resolveAccess: allowed as any, decide: (async () => { throw new Error('boom'); }) as any,
    })).toBeNull();
    expect(await adviseGoalQuality(facts([weakCommand]), {
      ...quiet, resolveAccess: (async () => { throw new Error('db down'); }) as any, decide: answering(() => ['no', 1]).decide,
    })).toBeNull();
  });

  it('a label outside the set is treated as no answer', async () => {
    const { decide } = answering(() => ['maybe', 0.99]);
    const r = await adviseGoalQuality(facts([weakCommand]), { resolveAccess: allowed as any, decide, cache: new Map(), log: () => {} });
    expect(r).toBeNull();
  });
});

describe('adviseGoalQuality — the verdict', () => {
  it('grades a bookkeeping-style command weak, an outcome command not, and keeps bookkeeping out of it', async () => {
    const { decide, calls } = answering(name => {
      if (name === 'c0_noticeable') return ['yes', 0.95]; // the outcome command
      if (name === 'c1_noticeable') return ['no', 0.9]; // "tests pass"
      return ['command-proof', 0.7];
    });
    const r = await adviseGoalQuality(facts([outcome, weakCommand, prs, open]), {
      resolveAccess: allowed as any, decide, cache: new Map(), log: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].capability).toBe('mission_goal_quality');
    expect(JSON.stringify(calls[0].state)).not.toContain(SECRET_COMMAND);
    expect(r).not.toBeNull();
    expect(r!.criteria.map(c => [c.index, c.noticeable, c.weak])).toEqual([
      [0, 'yes', false],
      [1, 'no', true],
      [2, 'bookkeeping', false],
      [3, 'bookkeeping', false],
    ]);
    expect(r!.criteria[1]).toMatchObject({ weakOn: ['noticeable'], fingerprint: criterionFingerprint(weakCommand), checkable: 'yes' });
    expect(r!.weakCount).toBe(1);
    expect(r!.rewrite).toBe('command-proof');
    expect(r!.suggestion).toBe(GOAL_QUALITY_REWRITES['command-proof']);
  });

  it('a weak label below the confidence floor is not weak', async () => {
    const { decide } = answering(name => (name === 'rewrite' ? ['none', 0.9] : ['no', GOAL_QUALITY_MIN_CONFIDENCE - 0.01]));
    const r = await adviseGoalQuality(facts([weakCommand]), { resolveAccess: allowed as any, decide, cache: new Map(), log: () => {} });
    expect(r!.weakCount).toBe(0);
    expect(r!.suggestion).toBeNull();
  });

  it('prose that cannot be checked is weak on checkable', async () => {
    const { decide } = answering(name => (name.endsWith('_checkable') ? ['no', 0.92] : name === 'rewrite' ? ['state-outcome', 0.8] : ['yes', 0.9]));
    const r = await adviseGoalQuality(facts([prose]), { resolveAccess: allowed as any, decide, cache: new Map(), log: () => {} });
    expect(r!.criteria[0]).toMatchObject({ checkable: 'no', weak: true, weakOn: ['checkable'] });
  });

  it('logs one [decision-shadow] line of labels and numbers — no criterion text, short mission id', async () => {
    const lines: string[] = [];
    const { decide } = answering(name => (name === 'rewrite' ? ['command-proof', 0.8] : ['no', 0.9]));
    await adviseGoalQuality(facts([outcome, prose, prs]), { resolveAccess: allowed as any, decide, cache: new Map(), log: l => lines.push(l) });
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toStartWith('[decision-shadow] ');
    for (const text of [SECRET_COMMAND, outcome.label!, 'The settings page feels faster', 'perceived speed', MISSION_ID]) {
      expect(line).not.toContain(text);
    }
    const rec = JSON.parse(line.slice('[decision-shadow] '.length));
    expect(rec).toMatchObject({
      site: 'goal_criteria_quality',
      v: `${GOAL_QUALITY_PROMPT_VERSION}|jev-test`,
      mission: '11111111',
      mode: 'shadow',
      graded: 2,
      weak: 2,
      rewrite: 'command-proof',
    });
    expect(rec.criteria[0]).toMatchObject({ i: 0, type: 'command', fp: criterionFingerprint(outcome), noticeable: 'no', weak: true });
  });

  it('a cache hit does not spend', async () => {
    const { decide, calls } = answering(name => (name === 'rewrite' ? ['none', 0.9] : ['yes', 0.9]));
    const deps = { resolveAccess: allowed as any, decide, cache: new Map(), log: () => {} };
    const first = await adviseGoalQuality(facts([outcome]), deps);
    const second = await adviseGoalQuality(facts([outcome], { missionId: 'other-mission' }), deps);
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('the cache is bounded', async () => {
    const { decide } = answering(name => (name === 'rewrite' ? ['none', 0.9] : ['yes', 0.9]));
    const cache = new Map();
    for (let i = 0; i < 260; i++) {
      await adviseGoalQuality(facts([{ type: 'command', command: 'x', label: `outcome ${i}` }]), {
        resolveAccess: allowed as any, decide, cache, log: () => {},
      });
    }
    expect(cache.size).toBeLessThanOrEqual(200);
  });
});

describe('goalQualityWarnings: the warned rows', () => {
  it('one warned row per weak criterion, detail without criterion text', async () => {
    const { decide } = answering(name => (name === 'c1_noticeable' ? ['no', 0.9] : name === 'rewrite' ? ['state-outcome', 0.8] : ['yes', 0.9]));
    const verdict = await adviseGoalQuality(facts([outcome, weakCommand]), { resolveAccess: allowed as any, decide, cache: new Map(), log: () => {} });
    const rows = goalQualityWarnings(verdict!, {
      missionId: MISSION_ID, workspaceId: 'ws-1', surface: 'POST /api/missions', callerOrigin: 'api',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      gate: 'goal_criteria_quality',
      outcome: 'warned',
      surface: 'POST /api/missions',
      missionId: MISSION_ID,
      workspaceId: 'ws-1',
      callerOrigin: 'api',
      detail: {
        fingerprint: criterionFingerprint(weakCommand),
        type: 'command',
        noticeable: 'no',
        checkable: 'yes',
        rewrite: 'state-outcome',
        promptVersion: GOAL_QUALITY_PROMPT_VERSION,
        model: 'jev-test',
        mode: 'shadow',
      },
    });
    const json = JSON.stringify(rows);
    expect(json).not.toContain('tests pass');
    expect(json).not.toContain('bun run test');
    expect(rows[0].reason).not.toContain('tests pass');
  });

  it('no weak criterion: no rows', async () => {
    const { decide } = answering(name => (name === 'rewrite' ? ['none', 0.9] : ['yes', 0.9]));
    const verdict = await adviseGoalQuality(facts([outcome]), { resolveAccess: allowed as any, decide, cache: new Map(), log: () => {} });
    expect(goalQualityWarnings(verdict!, { missionId: MISSION_ID, workspaceId: 'ws-1', surface: 'POST /api/missions' })).toEqual([]);
  });
});

describe('adviseGoalQuality — the rubric from memory', () => {
  const yes = (name: string): [string, number] => (name === 'rewrite' ? ['none', 0.9] : ['yes', 0.9]);
  const memoryRubric = { text: 'Team rubric: outcomes name a customer.', version: 'mdeadbeef', acceptedFingerprints: [] as string[] };

  it('the rubric read from memory is the rule every question carries, and its version is logged', async () => {
    const { decide, calls } = answering(yes);
    const lines: string[] = [];
    const r = await adviseGoalQuality(facts([outcome]), {
      resolveAccess: allowed as any, decide, cache: new Map(), log: l => lines.push(l),
      loadRubric: async () => memoryRubric,
    });
    for (const q of Object.values(calls[0].questions) as any[]) expect(q.instructions.rule).toBe(memoryRubric.text);
    expect(r!.rubricVersion).toBe('mdeadbeef');
    expect(JSON.parse(lines[0].slice('[decision-shadow] '.length)).rubric).toBe('mdeadbeef');
  });

  it('a different rubric version is a cache miss', async () => {
    const { decide, calls } = answering(yes);
    const cache = new Map();
    await adviseGoalQuality(facts([outcome]), { resolveAccess: allowed as any, decide, cache, log: () => {}, loadRubric: async () => memoryRubric });
    await adviseGoalQuality(facts([outcome]), { resolveAccess: allowed as any, decide, cache, log: () => {}, loadRubric: async () => ({ ...memoryRubric, version: 'm00000000' }) });
    expect(calls).toHaveLength(2);
  });

  it('a throwing rubric read still makes the call, with the code default (AC-11)', async () => {
    const { decide, calls } = answering(yes);
    const r = await adviseGoalQuality(facts([outcome]), {
      resolveAccess: allowed as any, decide, cache: new Map(), log: () => {},
      loadRubric: async () => { throw new Error('memory down'); },
    });
    expect(calls).toHaveLength(1);
    expect((Object.values(calls[0].questions)[0] as any).instructions.rule).toContain('Bookkeeping is all PRs merged');
    expect(r!.rubricVersion).toBe('base');
  });

  it('the rubric is not read when the capability is off', async () => {
    const { decide } = answering(yes);
    let reads = 0;
    await adviseGoalQuality(facts([outcome]), {
      resolveAccess: async () => ({ ok: false as const, error: { kind: 'capability_disabled' as const, capability: 'mission_goal_quality' as const } }),
      decide, cache: new Map(), log: () => {},
      loadRubric: async () => { reads++; return memoryRubric; },
    });
    expect(reads).toBe(0);
  });

  it('an accepted pattern suppresses its criterion: not sent, not in the verdict, never warned (AC-10)', async () => {
    const { decide, calls } = answering(name => (name === 'rewrite' ? ['state-outcome', 0.9] : ['no', 0.95]));
    const loadRubric = async () => ({ ...memoryRubric, acceptedFingerprints: [criterionFingerprint(weakCommand)] });
    const r = await adviseGoalQuality(facts([outcome, weakCommand]), { resolveAccess: allowed as any, decide, cache: new Map(), log: () => {}, loadRubric });
    expect(calls[0].state.criteria).toHaveLength(1);
    expect(JSON.stringify(calls[0].state)).not.toContain('tests pass');
    expect(r!.criteria.map(c => c.fingerprint)).toEqual([criterionFingerprint(outcome)]);
    const rows = goalQualityWarnings(r!, { missionId: MISSION_ID, workspaceId: 'ws-1', surface: 'POST /api/missions' });
    expect(rows.map(x => x.detail!.fingerprint)).not.toContain(criterionFingerprint(weakCommand));
  });

  it('when every gradeable criterion is accepted, no call is made', async () => {
    const { decide, calls } = answering(yes);
    const r = await adviseGoalQuality(facts([weakCommand, prs]), {
      resolveAccess: allowed as any, decide, cache: new Map(), log: () => {},
      loadRubric: async () => ({ ...memoryRubric, acceptedFingerprints: [criterionFingerprint(weakCommand)] }),
    });
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

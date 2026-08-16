import { describe, it, expect, mock } from 'bun:test';

// Only the pure half of the module is under test here (`loadInitiativeEffort`'s
// SQL is covered by the route test). Stub the db/schema/orm modules so importing
// the module never opens a connection. `@buildd/core/mission-helpers` is NOT
// stubbed: `deriveTaskType` is pure and its real prefix rules are what the
// attempt count must agree with.
mock.module('@buildd/core/db', () => ({ db: { select: () => { throw new Error('not used'); } } }));
mock.module('@buildd/core/db/schema', () => ({
  workers: { completedAt: 'completedAt', updatedAt: 'updatedAt', inputTokens: 'inputTokens', outputTokens: 'outputTokens', status: 'status', prUrl: 'prUrl', taskId: 'taskId', mergedAt: 'mergedAt' },
  tasks: { id: 'id', missionId: 'missionId', title: 'title', parentTaskId: 'parentTaskId', createdAt: 'createdAt', mode: 'mode' },
  missions: { id: 'id', teamId: 'teamId', workspaceId: 'workspaceId', initiativeId: 'initiativeId', status: 'status', goalCriteriaState: 'goalCriteriaState' },
  initiatives: { id: 'id', teamId: 'teamId', status: 'status', kpiState: 'kpiState' },
}));
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b }),
  and: (...args: any[]) => args,
  gte: (a: any, b: any) => ({ a, b }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values }),
}));

import {
  buildEffortWindow,
  zeroEffortWindow,
  derivePendingCounts,
  noPendingCounts,
  deriveVerdict,
  deriveConfidence,
  deriveInitiativeVerdict,
  assembleVerdictRollups,
  emptyVerdictRollup,
  sumRecentTokens,
  UNASSIGNED_INITIATIVE_KEY,
  EFFORT_WINDOW_DAYS,
  THRASH_RATIO,
  VERDICT_LABEL,
  type EffortRow,
  type PulseMission,
  type VerdictInputs,
  type Verdict,
} from './initiative-pulse';

// Fixed clock so window arithmetic is assertable. 2026-08-16 UTC.
const TODAY = new Date('2026-08-16T12:00:00Z');

function row(partial: Partial<EffortRow>): EffortRow {
  return { initiativeId: 'init-1', day: '2026-08-16', tokens: 0, merged: 0, failed: 0, open: 0, ...partial };
}

describe('buildEffortWindow', () => {
  it('back-fills a sparse input to exactly 14 entries, oldest first', () => {
    const out = buildEffortWindow([row({ day: '2026-08-10', tokens: '1500' })], { today: TODAY });
    const days = out.get('init-1')!;

    expect(days).toHaveLength(EFFORT_WINDOW_DAYS);
    expect(days[0].date).toBe('2026-08-03');
    expect(days[13].date).toBe('2026-08-16');
    expect(days.filter((d) => d.tokens > 0)).toHaveLength(1);
  });

  it('anchors the window on today, not on the latest row present', () => {
    // Activity that stopped 6 days ago must NOT land at the right-hand edge —
    // that is what made a silent initiative read as busy.
    const out = buildEffortWindow([row({ day: '2026-08-10', tokens: '900' })], { today: TODAY });
    const days = out.get('init-1')!;

    expect(days[13].tokens).toBe(0);
    expect(days.find((d) => d.date === '2026-08-10')!.tokens).toBe(900);
  });

  it('sums input_tokens and output_tokens per day as numbers, not strings', () => {
    const out = buildEffortWindow(
      [row({ day: '2026-08-14', tokens: '1000', merged: '2', failed: '1', open: '0' })],
      { today: TODAY },
    );
    const day = out.get('init-1')!.find((d) => d.date === '2026-08-14')!;

    expect(day).toMatchObject({ tokens: 1000, merged: 2, failed: 1, open: 0 });
  });

  it('sums a day that appears twice for one initiative rather than overwriting it', () => {
    const out = buildEffortWindow(
      [
        row({ day: '2026-08-15', tokens: '100', merged: '1' }),
        row({ day: '2026-08-15', tokens: '250', merged: '2' }),
      ],
      { today: TODAY },
    );
    const day = out.get('init-1')!.find((d) => d.date === '2026-08-15')!;

    expect(day.tokens).toBe(350);
    expect(day.merged).toBe(3);
  });

  it('buckets a null initiativeId under __unassigned__', () => {
    const out = buildEffortWindow([row({ initiativeId: null, tokens: '75' })], { today: TODAY });

    expect(out.has(UNASSIGNED_INITIATIVE_KEY)).toBe(true);
    expect(out.has('unassigned')).toBe(false);
    expect(out.get(UNASSIGNED_INITIATIVE_KEY)![13].tokens).toBe(75);
  });

  it('omits initiatives with no rows rather than inventing them', () => {
    const out = buildEffortWindow([], { today: TODAY });
    expect(out.size).toBe(0);
  });

  it('normalises a timestamp-shaped day value to its date part', () => {
    const out = buildEffortWindow([row({ day: '2026-08-16T00:00:00.000Z', tokens: '10' })], { today: TODAY });
    expect(out.get('init-1')![13].tokens).toBe(10);
  });
});

describe('zeroEffortWindow', () => {
  it('is a dense all-zero window ending today', () => {
    const days = zeroEffortWindow({ today: TODAY });

    expect(days).toHaveLength(EFFORT_WINDOW_DAYS);
    expect(days[13].date).toBe('2026-08-16');
    expect(days.every((d) => d.tokens === 0)).toBe(true);
  });
});

describe('derivePendingCounts', () => {
  const NOW = TODAY.getTime();

  function mission(partial: Partial<PulseMission>): PulseMission {
    return { initiativeId: 'init-1', ...partial };
  }

  it('counts a completed task with an open PR as awaiting verification', () => {
    const out = derivePendingCounts(
      [
        mission({
          tasks: [{ status: 'completed', workers: [{ prUrl: 'https://x/1', mergedAt: null, prLifecycleStatus: 'open' }] }],
        }),
      ],
      { now: NOW },
    );

    expect(out.get('init-1')!.awaitingVerification).toBe(1);
  });

  it('does not count a merged or closed PR as awaiting verification', () => {
    const out = derivePendingCounts(
      [
        mission({
          tasks: [
            { status: 'completed', workers: [{ prUrl: 'https://x/1', mergedAt: new Date(), prLifecycleStatus: 'merged' }] },
            { status: 'completed', workers: [{ prUrl: 'https://x/2', mergedAt: null, prLifecycleStatus: 'closed' }] },
            { status: 'pending', workers: [{ prUrl: 'https://x/3', mergedAt: null, prLifecycleStatus: 'open' }] },
          ],
        }),
      ],
      { now: NOW },
    );

    expect(out.get('init-1')!.awaitingVerification).toBe(0);
  });

  it('sums blocked counts and held missions across an initiative', () => {
    const out = derivePendingCounts(
      [
        mission({ blockedPRCount: 2, isHeld: true }),
        mission({ blockedPRCount: 1, isHeld: false }),
      ],
      { now: NOW },
    );

    expect(out.get('init-1')).toMatchObject({ blocked: 3, held: 1 });
  });

  it('counts a shipped mission only when its activity is inside 7 days', () => {
    const out = derivePendingCounts(
      [
        mission({ health: 'shipped', lastActivityAt: new Date(NOW - 2 * 86_400_000).toISOString() }),
        mission({ health: 'shipped', lastActivityAt: new Date(NOW - 9 * 86_400_000).toISOString() }),
        mission({ health: 'idle', lastActivityAt: new Date(NOW).toISOString() }),
      ],
      { now: NOW },
    );

    expect(out.get('init-1')!.shippedThisWeek).toBe(1);
  });

  it('buckets missions with no initiative under __unassigned__', () => {
    const out = derivePendingCounts([mission({ initiativeId: null, blockedPRCount: 4 })], { now: NOW });

    expect(out.get(UNASSIGNED_INITIATIVE_KEY)!.blocked).toBe(4);
    expect(out.has('init-1')).toBe(false);
  });

  it('tolerates missions with no tasks and no counts', () => {
    const out = derivePendingCounts([mission({ tasks: null })], { now: NOW });

    expect(out.get('init-1')).toEqual(noPendingCounts());
  });
});

// ─── The winning verdict (spec §6.5) ─────────────────────────────────────────

/** A healthy, merging arc — every verdict test starts here and changes one thing. */
function inputs(partial: Partial<VerdictInputs> = {}): VerdictInputs {
  return {
    status: 'active',
    totalMissions: 4,
    allTerminal: false,
    criteriaFail: 0,
    merges7d: 3,
    attempts7d: 2,
    tokens7d: 120_000,
    held: 0,
    blocked: 0,
    awaitingVerification: 0,
    ...partial,
  };
}

describe('deriveVerdict', () => {
  it('reads a merging arc with no failures as winning', () => {
    expect(deriveVerdict(inputs())).toBe('winning');
  });

  // AC-30
  it('reads tokens burning with nothing merged as grinding, at any progress', () => {
    expect(deriveVerdict(inputs({ tokens7d: 40_000, merges7d: 0, attempts7d: 0 }))).toBe('grinding');
  });

  // AC-31
  it('reads rework outrunning ships past THRASH_RATIO as losing', () => {
    expect(deriveVerdict(inputs({ merges7d: 2, attempts7d: 9 }))).toBe('losing');
    expect(deriveVerdict(inputs({ merges7d: 2, attempts7d: 6 }))).toBe('winning');
  });

  it('measures thrash against a floor of one merge rather than dividing by zero', () => {
    // 4 attempts, nothing merged: 4 > 3 × max(0,1) → losing, not grinding.
    expect(deriveVerdict(inputs({ merges7d: 0, attempts7d: 4 }))).toBe('losing');
    expect(deriveVerdict(inputs({ merges7d: 0, attempts7d: 3 }))).toBe('grinding');
  });

  it('ignores thrash on an arc that burned nothing this week', () => {
    // attempts without burn is stale evidence; the ladder gates both motion
    // rules on tokens7d so an idle arc cannot be called losing by old retries.
    expect(deriveVerdict(inputs({ tokens7d: 0, attempts7d: 20, merges7d: 0 }))).toBe('dormant');
  });

  // AC-32
  it('lets a verified failure outrank every motion signal', () => {
    expect(deriveVerdict(inputs({ criteriaFail: 1, merges7d: 5 }))).toBe('losing');
  });

  // AC-33
  it('reads every-mission-terminal on an open arc as won_unclaimed', () => {
    expect(deriveVerdict(inputs({ allTerminal: true, tokens7d: 0, merges7d: 0 }))).toBe('won_unclaimed');
    expect(VERDICT_LABEL.won_unclaimed).toBe('Ready to close');
  });

  it('does not claim won_unclaimed once the arc itself is closed', () => {
    // status 'completed' means a human already closed it — nothing to prompt.
    expect(deriveVerdict(inputs({ allTerminal: true, status: 'completed', tokens7d: 0 }))).toBe('dormant');
  });

  it('prefers a verified failure over won_unclaimed on a finished arc', () => {
    expect(deriveVerdict(inputs({ allTerminal: true, criteriaFail: 1, tokens7d: 0 }))).toBe('losing');
  });

  // AC-34
  it('separates stuck from dormant by whether anything waits on a human', () => {
    expect(deriveVerdict(inputs({ tokens7d: 0, merges7d: 0, attempts7d: 0, held: 1 }))).toBe('stuck');
    expect(deriveVerdict(inputs({ tokens7d: 0, merges7d: 0, attempts7d: 0, blocked: 2 }))).toBe('stuck');
    expect(deriveVerdict(inputs({ tokens7d: 0, merges7d: 0, attempts7d: 0, awaitingVerification: 1 }))).toBe('stuck');
    expect(deriveVerdict(inputs({ tokens7d: 0, merges7d: 0, attempts7d: 0 }))).toBe('dormant');
  });

  // AC-35
  it('short-circuits to empty on a zero-mission arc before any other rule', () => {
    // Failing criteria and thrash are both present; neither is reached.
    expect(deriveVerdict(inputs({ totalMissions: 0, criteriaFail: 3, attempts7d: 40 }))).toBe('empty');
  });

  // AC-37 — the reason this function exists at all.
  it('is unaffected by progress, which is not an input', () => {
    // `progress` is absent from VerdictInputs by design; smuggling it in through
    // a cast must change nothing, and two arcs differing only in it must agree.
    const at97 = { ...inputs(), progress: 97 } as unknown as VerdictInputs;
    const at3 = { ...inputs(), progress: 3 } as unknown as VerdictInputs;

    expect(deriveVerdict(at97)).toBe(deriveVerdict(at3));
    expect(deriveVerdict(at97)).toBe(deriveVerdict(inputs()));
    expect(Object.keys(inputs())).not.toContain('progress');
  });

  it('is total — every reachable input combination yields a verdict', () => {
    const seen = new Set<Verdict>();
    for (const totalMissions of [0, 4]) {
      for (const criteriaFail of [0, 1]) {
        for (const allTerminal of [false, true]) {
          for (const status of ['active', 'completed']) {
            for (const tokens7d of [0, 50_000]) {
              for (const merges7d of [0, 2]) {
                for (const attempts7d of [0, 9]) {
                  for (const held of [0, 1]) {
                    const v = deriveVerdict(
                      inputs({ totalMissions, criteriaFail, allTerminal, status, tokens7d, merges7d, attempts7d, held }),
                    );
                    expect(VERDICT_LABEL[v]).toBeTruthy();
                    seen.add(v);
                  }
                }
              }
            }
          }
        }
      }
    }
    // Every rung is reachable; a ladder with a dead rung is a spec bug.
    expect([...seen].sort()).toEqual(
      ['dormant', 'empty', 'grinding', 'losing', 'stuck', 'winning', 'won_unclaimed'].sort(),
    );
  });

  it('fixes THRASH_RATIO at 3', () => {
    expect(THRASH_RATIO).toBe(3);
  });
});

describe('deriveConfidence', () => {
  // AC-36
  it('is unverified when child missions have no criteria', () => {
    expect(deriveConfidence({ totalMissions: 4, verifiedMissions: 0, kpiOverall: null })).toBe('unverified');
  });

  it('is unverified when only some missions carry a pass/fail verdict', () => {
    expect(deriveConfidence({ totalMissions: 4, verifiedMissions: 3, kpiOverall: null })).toBe('unverified');
  });

  it('is verified when every mission has a pass or fail verdict', () => {
    expect(deriveConfidence({ totalMissions: 4, verifiedMissions: 4, kpiOverall: null })).toBe('verified');
  });

  it('is verified on the initiative KPI alone, whatever the missions say', () => {
    expect(deriveConfidence({ totalMissions: 4, verifiedMissions: 0, kpiOverall: 'pass' })).toBe('verified');
    expect(deriveConfidence({ totalMissions: 4, verifiedMissions: 0, kpiOverall: 'fail' })).toBe('verified');
  });

  it('treats UNVERIFIED and NOT_EVALUATED KPIs as no evidence', () => {
    expect(deriveConfidence({ totalMissions: 2, verifiedMissions: 0, kpiOverall: 'UNVERIFIED' })).toBe('unverified');
    expect(deriveConfidence({ totalMissions: 2, verifiedMissions: 0, kpiOverall: 'NOT_EVALUATED' })).toBe('unverified');
  });

  it('does not call a zero-mission arc verified by vacuous truth', () => {
    expect(deriveConfidence({ totalMissions: 0, verifiedMissions: 0, kpiOverall: null })).toBe('unverified');
  });
});

describe('sumRecentTokens', () => {
  it('sums only the last 7 of the 14 entries', () => {
    const days = zeroEffortWindow({ today: TODAY }).map((d, i) => ({ ...d, tokens: i < 7 ? 1000 : 10 }));
    expect(sumRecentTokens(days)).toBe(70);
  });

  it('is zero for an all-zero window', () => {
    expect(sumRecentTokens(zeroEffortWindow({ today: TODAY }))).toBe(0);
  });
});

describe('assembleVerdictRollups', () => {
  const base = { missionRollups: [], initiativeRows: [], mergeRows: [], attemptRows: [] };

  it('gives every team initiative an entry even with no missions or motion', () => {
    const out = assembleVerdictRollups({
      ...base,
      initiativeRows: [{ id: 'init-1', status: 'active', kpiOverall: null }],
    });

    // Absent from the map would mean absent from the surface; 'empty' is a
    // verdict an arc is entitled to.
    expect(out.get('init-1')).toEqual(emptyVerdictRollup('active'));
    expect(deriveVerdict({ ...inputs(), totalMissions: 0 })).toBe('empty');
  });

  it('marks allTerminal only when a mission exists and none are open', () => {
    const out = assembleVerdictRollups({
      ...base,
      initiativeRows: [
        { id: 'done', status: 'active', kpiOverall: null },
        { id: 'busy', status: 'active', kpiOverall: null },
      ],
      missionRollups: [
        { initiativeId: 'done', totalMissions: '3', openMissions: '0', criteriaFail: '0', verifiedMissions: '3' },
        { initiativeId: 'busy', totalMissions: '3', openMissions: '1', criteriaFail: '0', verifiedMissions: '0' },
      ],
    });

    expect(out.get('done')).toMatchObject({ totalMissions: 3, allTerminal: true, verifiedMissions: 3 });
    expect(out.get('busy')).toMatchObject({ totalMissions: 3, allTerminal: false });
  });

  it('counts only attempt tasks toward attempts7d, per deriveTaskType', () => {
    const out = assembleVerdictRollups({
      ...base,
      initiativeRows: [{ id: 'init-1', status: 'active', kpiOverall: null }],
      attemptRows: [
        // primary task → not an attempt
        { initiativeId: 'init-1', title: 'Add pagination', parentTaskId: null, mode: 'execution' },
        // CI retry
        { initiativeId: 'init-1', title: '[CI Retry #2] Add pagination', parentTaskId: 'p', mode: 'execution' },
        // reviewer run
        { initiativeId: 'init-1', title: '[reviewer] Add pagination', parentTaskId: 'p', mode: 'execution' },
        // unlabelled planning child → legacy attempt
        { initiativeId: 'init-1', title: 'follow-up', parentTaskId: 'p', mode: 'planning' },
      ],
    });

    expect(out.get('init-1')!.attempts7d).toBe(3);
  });

  it('does not count spawned builder tasks as thrash', () => {
    // approve_plan children carry a parentTaskId with mode 'execution' and no
    // prefix. They are distinct deliverables (#1706) — counting them as attempts
    // would read a planned mission's own build-out as rework and call it losing.
    const out = assembleVerdictRollups({
      ...base,
      initiativeRows: [{ id: 'init-1', status: 'active', kpiOverall: null }],
      attemptRows: [
        { initiativeId: 'init-1', title: 'Wire the API client', parentTaskId: 'plan-1', mode: 'execution' },
        { initiativeId: 'init-1', title: 'Add the migration', parentTaskId: 'plan-1', mode: 'execution' },
        // A prefixed retry is still an attempt, execution mode or not.
        { initiativeId: 'init-1', title: '[CI Retry #1] Add the migration', parentTaskId: 'plan-1', mode: 'execution' },
      ],
    });

    expect(out.get('init-1')!.attempts7d).toBe(1);
  });

  it('sums merges and buckets initiative-less rows under __unassigned__', () => {
    const out = assembleVerdictRollups({
      ...base,
      mergeRows: [
        { initiativeId: 'init-1', merges: '2' },
        { initiativeId: null, merges: '5' },
      ],
    });

    expect(out.get('init-1')!.merges7d).toBe(2);
    expect(out.get(UNASSIGNED_INITIATIVE_KEY)!.merges7d).toBe(5);
    expect(out.has('unassigned')).toBe(false);
  });

  it('returns an empty map for a team with no initiatives and no motion', () => {
    expect(assembleVerdictRollups(base).size).toBe(0);
  });
});

describe('deriveInitiativeVerdict', () => {
  const counts = noPendingCounts();

  it('folds a failing initiative KPI into criteriaFail', () => {
    const rollup = { ...emptyVerdictRollup('active'), totalMissions: 2, merges7d: 4, kpiOverall: 'fail' };
    const out = deriveInitiativeVerdict({
      rollup,
      effortDays: zeroEffortWindow({ today: TODAY }).map((d) => ({ ...d, tokens: 900 })),
      counts,
    });

    // Merging steadily, but the arc's own KPI failed — that is losing.
    expect(out.verdict).toBe('losing');
    expect(out.confidence).toBe('verified');
  });

  it('derives tokens7d from the last 7 window entries and reports it as evidence', () => {
    const effortDays = zeroEffortWindow({ today: TODAY }).map((d, i) => ({ ...d, tokens: i >= 7 ? 500 : 99_999 }));
    const out = deriveInitiativeVerdict({
      rollup: { ...emptyVerdictRollup('active'), totalMissions: 1 },
      effortDays,
      counts,
    });

    // 3500 from the recent week; the older 99,999s must not leak in.
    expect(out.tokens7d).toBe(3500);
    expect(out.verdict).toBe('grinding');
  });

  it('reports confidence without letting it change the verdict', () => {
    const rollup = { ...emptyVerdictRollup('active'), totalMissions: 2, verifiedMissions: 0, merges7d: 1 };
    const effortDays = zeroEffortWindow({ today: TODAY }).map((d) => ({ ...d, tokens: 100 }));

    const unverified = deriveInitiativeVerdict({ rollup, effortDays, counts });
    const verified = deriveInitiativeVerdict({ rollup: { ...rollup, verifiedMissions: 2 }, effortDays, counts });

    expect(unverified.confidence).toBe('unverified');
    expect(verified.confidence).toBe('verified');
    expect(unverified.verdict).toBe(verified.verdict);
  });

  it('reads pending counts as the difference between stuck and dormant', () => {
    const rollup = { ...emptyVerdictRollup('active'), totalMissions: 2 };
    const effortDays = zeroEffortWindow({ today: TODAY });

    expect(deriveInitiativeVerdict({ rollup, effortDays, counts }).verdict).toBe('dormant');
    expect(
      deriveInitiativeVerdict({ rollup, effortDays, counts: { ...counts, blocked: 1 } }).verdict,
    ).toBe('stuck');
  });
});

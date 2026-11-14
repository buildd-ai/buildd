import { describe, expect, it } from 'bun:test';
import {
  isRepeatWallEpisode,
  readUsageWall,
  reviewBudgetWaitDescription,
  runnerDisplayName,
  usageWallFromReport,
  usageWallLine,
  usageWallRecord,
  USAGE_WALL_CONTEXT_KEY,
} from './provider-wall';

const base = { hasStructuredOutput: false, hasPr: false };

describe('usageWallFromReport', () => {
  const WALLS = [
    ['Claude 5-hour', "You've hit your 5-hour limit · resets 4pm (UTC)"],
    ['Claude session', "You've hit your session limit · resets 4pm (UTC)"],
    ['Claude weekly', "You've hit your weekly limit · resets Oct 16, 4am (UTC)"],
    ['Claude extra usage', "You're out of extra usage · resets 5pm (UTC)"],
    ['Codex usage', "You've hit your usage limit. Upgrade to Pro or try again at 5pm."],
  ] as const;

  for (const [name, text] of WALLS) {
    it(`reads an 'error' report of the ${name} wall as the wall`, () => {
      expect(usageWallFromReport({ ...base, status: 'error', error: text })).toBe(text);
    });
    it(`reads a 'completed' session whose only output is the ${name} wall as the wall`, () => {
      expect(usageWallFromReport({ ...base, status: 'completed', summary: text, summarySource: 'fallback' })).toBe(text);
      expect(usageWallFromReport({ ...base, status: 'completed', error: text })).toBe(text);
    });
  }

  it('leaves a failed report to the route budget branch', () => {
    expect(usageWallFromReport({ ...base, status: 'failed', error: WALLS[0][1] })).toBeNull();
  });

  it('never reads a completion that delivered a PR or a structured outcome as a wall', () => {
    expect(usageWallFromReport({ ...base, hasPr: true, status: 'completed', error: WALLS[0][1] })).toBeNull();
    expect(usageWallFromReport({ ...base, hasStructuredOutput: true, status: 'completed', error: WALLS[0][1] })).toBeNull();
  });

  it("never reads an agent-authored summary, or a long one, as a wall", () => {
    expect(usageWallFromReport({ ...base, status: 'completed', summary: WALLS[0][1], summarySource: 'agent' })).toBeNull();
    const long = `${'Did a lot of work. '.repeat(40)} ${WALLS[0][1]}`;
    expect(usageWallFromReport({ ...base, status: 'completed', summary: long, summarySource: 'fallback' })).toBeNull();
  });

  it("is not the task's own per-session dollar cap", () => {
    expect(usageWallFromReport({ ...base, status: 'error', error: 'Budget limit exceeded (maxBudgetUsd)', sessionBudgetCapped: true })).toBeNull();
    expect(usageWallFromReport({ ...base, status: 'error', error: 'error_max_budget_usd', budgetExhausted: true })).toBeNull();
  });

  it('ignores ordinary errors', () => {
    expect(usageWallFromReport({ ...base, status: 'error', error: 'TypeError: x is undefined' })).toBeNull();
    expect(usageWallFromReport({ ...base, status: 'completed', summary: 'Done.', summarySource: 'fallback' })).toBeNull();
  });
});

describe('isRepeatWallEpisode', () => {
  const reset = new Date('2026-11-14T16:00:00Z');
  it('is a repeat for the same login and reset', () => {
    expect(isRepeatWallEpisode([{ backend: 'claude', seatKey: 'login:a', resetsAt: reset }],
      { backend: 'claude', seatKey: 'login:a', resetsAt: new Date(reset.getTime() + 60_000) })).toBe(true);
  });
  it('is a new episode for another login, another backend or a later window', () => {
    const active = [{ backend: 'claude', seatKey: 'login:a', resetsAt: reset }];
    expect(isRepeatWallEpisode(active, { backend: 'claude', seatKey: 'login:b', resetsAt: reset })).toBe(false);
    expect(isRepeatWallEpisode(active, { backend: 'codex', seatKey: 'login:a', resetsAt: reset })).toBe(false);
    expect(isRepeatWallEpisode(active, { backend: 'claude', seatKey: 'login:a', resetsAt: new Date(reset.getTime() + 5 * 3600_000) })).toBe(false);
    expect(isRepeatWallEpisode([], { backend: 'claude', seatKey: null, resetsAt: reset })).toBe(false);
  });
});

describe('the usage wall record and its sentence', () => {
  const now = new Date('2026-11-14T13:00:00Z');
  const record = usageWallRecord({ backend: 'claude', resetsAt: new Date('2026-11-14T16:00:00Z'), scope: 'login', runner: 'headless://box-a', now });

  it('reads back from context until its reset passes', () => {
    const ctx = { [USAGE_WALL_CONTEXT_KEY]: record };
    expect(readUsageWall(ctx, now)).toEqual(record);
    expect(readUsageWall(ctx, new Date('2026-11-14T16:00:01Z'))).toBeNull();
    expect(readUsageWall({}, now)).toBeNull();
    expect(readUsageWall({ [USAGE_WALL_CONTEXT_KEY]: { backend: 'claude', resetsAt: 'nope' } }, now)).toBeNull();
  });

  it('says what is happening, when it resumes and whose login hit it', () => {
    expect(usageWallLine(record)).toBe(
      'Waiting for the usage limit to reset at 16:00 UTC (Claude login on runner box-a). Resumes by itself, sooner if another runner with budget takes it.',
    );
    expect(usageWallLine({ ...record, scope: 'pool', backend: 'codex', runner: null })).toBe(
      'Waiting for the usage limit to reset at 16:00 UTC (Codex usage). Resumes by itself.',
    );
  });

  it('names a runner the way a person knows it', () => {
    expect(runnerDisplayName('headless://box-a')).toBe('box-a');
    expect(runnerDisplayName('box-b')).toBe('box-b');
    expect(runnerDisplayName(null)).toBeNull();
  });

  it('gives the review check a pending description with the cause and the time', () => {
    const d = reviewBudgetWaitDescription('2026-11-14T16:00:00Z');
    expect(d).toBe('Review waiting for model budget: resumes 16:00 UTC');
    expect(d.length).toBeLessThanOrEqual(140);
    expect(d).not.toMatch(/unavailable|person has to decide/i);
  });
});

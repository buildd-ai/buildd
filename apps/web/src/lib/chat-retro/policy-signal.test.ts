import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * The chat retro as a model-policy signal: lesson rows to verdicts (labels
 * only), and the on/off + judge status the dial reads.
 */

let retroState = { settings: { lessons: true, proposals: false }, dogfood: false };
let access: any = { ok: true, apiKey: 'k', model: 'typesafe/jev-1.13' };
let rows: any[] = [];
const executed: string[] = [];

mock.module('./store', () => ({ readTeamRetroState: async () => retroState }));
mock.module('@buildd/core/decision-client', () => ({ resolveDecisionAccess: async () => access }));
mock.module('@buildd/core/db', () => ({
  db: { execute: async (q: any) => { executed.push(JSON.stringify(q)); return { rows }; } },
}));

const { chatRetroQualitySource, judgeOf, verdictFromRow, windowClean } = await import('./policy-signal');

beforeEach(() => {
  retroState = { settings: { lessons: true, proposals: false }, dogfood: false };
  access = { ok: true, apiKey: 'k', model: 'typesafe/jev-1.13' };
  rows = [];
  executed.length = 0;
  delete process.env.CHAT_RETRO_ENABLED;
});

describe('verdictFromRow', () => {
  const row = {
    conversation_id: 'c1', from_at: '2026-10-01T10:00:00Z', at: '2026-10-01T10:05:00Z',
    satisfied: 'yes', version: 'cr1|typesafe/jev-1.13', evidence: [],
    served: [{ model: 'claude-sonnet-5', tier: 'standard' }, { model: null, tier: 'standard' }],
  };

  it('carries labels, the judge and who served each turn', () => {
    expect(verdictFromRow(row)).toEqual({
      conversationId: 'c1', fromAt: new Date(row.from_at), at: new Date(row.at), satisfied: 'yes', clean: true,
      judgeModel: 'typesafe/jev-1.13',
      served: [{ model: 'claude-sonnet-5', tier: 'standard' }, { model: null, tier: 'standard' }],
    });
  });

  it('an unknown satisfied label reads as not graded', () => {
    expect(verdictFromRow({ ...row, satisfied: 'maybe' }).satisfied).toBeNull();
  });
});

describe('judgeOf', () => {
  it('reads the model from the lesson version, or null', () => {
    expect(judgeOf('cr1|openai/gpt-6')).toBe('openai/gpt-6');
    expect(judgeOf('cr1')).toBeNull();
    expect(judgeOf(null)).toBeNull();
  });
});

describe('windowClean', () => {
  it('a stopped turn or a routing error is not clean', () => {
    expect(windowClean([{ kind: 'stopped', label: 'reasoning_timeout', conf: 1 }])).toBe(false);
    expect(windowClean([{ kind: 'routing_error', label: 'needed', conf: 0.9 }])).toBe(false);
  });

  it('re_asked / wrong_tier count at the lesson\'s turn gate, not below', () => {
    expect(windowClean([{ kind: 'repeat_call', label: 're_asked', conf: 0.9 }])).toBe(false);
    expect(windowClean([{ kind: 'repeat_call', label: 'wrong_tier', conf: 0.85 }])).toBe(false);
    expect(windowClean([{ kind: 'repeat_call', label: 're_asked', conf: 0.5 }])).toBe(true);
    expect(windowClean([{ kind: 'large_result', label: 'needed', conf: 1 }])).toBe(true);
    expect(windowClean(null)).toBe(true);
  });
});

describe('chatRetroQualitySource.status', () => {
  it('on, with the model the retro would judge with', async () => {
    expect(await chatRetroQualitySource.status('team-1')).toEqual({ enabled: true, judgeModel: 'typesafe/jev-1.13' });
  });

  it('off when the team has no lessons, or the global switch is off', async () => {
    retroState = { settings: { lessons: false, proposals: false }, dogfood: false };
    expect(await chatRetroQualitySource.status('team-1')).toEqual({ enabled: false, judgeModel: null });
    retroState = { settings: { lessons: true, proposals: false }, dogfood: false };
    process.env.CHAT_RETRO_ENABLED = '0';
    expect(await chatRetroQualitySource.status('team-1')).toEqual({ enabled: false, judgeModel: null });
  });

  it('an unreachable decision model is an unknown judge', async () => {
    access = { ok: false, error: { kind: 'missing_key' } };
    expect(await chatRetroQualitySource.status('team-1')).toEqual({ enabled: true, judgeModel: null });
  });
});

describe('chatRetroQualitySource.verdicts', () => {
  it('reads judged windows of one team, never message parts', async () => {
    rows = [{ conversation_id: 'c1', from_at: '2026-10-01T10:00:00Z', at: '2026-10-01T10:05:00Z', satisfied: 'no', version: 'cr1|x/y', evidence: [], served: [] }];
    const v = await chatRetroQualitySource.verdicts('team-1', new Date('2026-09-01T00:00:00Z'));
    expect(v).toHaveLength(1);
    expect(v[0].satisfied).toBe('no');
    const q = executed[0];
    expect(q).toContain('chat_retros');
    expect(q).toContain("status = 'judged'");
    expect(q).toContain('team-1');
    expect(q).not.toContain('parts');
  });
});

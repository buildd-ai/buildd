/**
 * Heartbeat triage: the condensed state, the gate and the never-throw wrapper.
 * Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import {
  buildHeartbeatTriageState,
  formatTriageLog,
  gateHeartbeatTriage,
  heartbeatTriagePromptHash,
  triageHeartbeat,
  HEARTBEAT_TRIAGE_PROMPT_VERSION,
  TRIAGE_MAX_WAIT_MS,
  WAIT_MIN_CONFIDENCE,
} from './heartbeat-triage';

const NOW = new Date('2026-09-28T12:00:00Z');
const recent = new Date(NOW.getTime() - 30 * 60_000);

const DESCRIPTION = [
  '## Heartbeat: Example mission',
  'A long write-up of the goal that says nothing about this cycle.',
  '\n## Mission Phase: BUILDING',
  'Builder work is in flight.',
  '\n## Mission State',
  '- Active: 2 task(s)',
  '\n## Checklist',
  '- the owner\'s checklist',
  '\n## Active/Pending Tasks (DO NOT DUPLICATE)',
  '- [builder] feat: add the thing — in_progress',
  '\n## Artifacts',
  '- **Report** [report]',
  '\n## Completed Tasks',
  `- ${'older work '.repeat(300)}`,
  '- [builder] newest completion: shipped',
].join('\n');

describe('buildHeartbeatTriageState', () => {
  const state = buildHeartbeatTriageState(DESCRIPTION);

  it('keeps the sections that say whether this cycle needs the organizer', () => {
    expect(state).toContain('## Mission Phase: BUILDING');
    expect(state).toContain('## Mission State');
    expect(state).toContain('feat: add the thing — in_progress');
  });

  it('drops the goal write-up, checklist and artifacts', () => {
    expect(state).not.toContain('long write-up');
    expect(state).not.toContain('checklist');
    expect(state).not.toContain('**Report**');
  });

  it('keeps the prior-runs section under its new and its old heading', () => {
    // Renamed from "Prior Heartbeats"; stored descriptions from before the
    // rename still carry the old heading and the benchmark rebuilds from them.
    for (const heading of ['## Prior organizer runs', '## Prior Heartbeats']) {
      const out = buildHeartbeatTriageState(`## Mission Phase: IDLE\n\n${heading}\n- 1h ago: [ok]`);
      expect(out).toContain(heading);
      expect(out).toContain('1h ago: [ok]');
    }
  });

  it('keeps the newest end of a long completed-tasks list', () => {
    expect(state).toContain('newest completion: shipped');
    expect(state.length).toBeLessThan(DESCRIPTION.length);
  });
});

describe('gateHeartbeatTriage', () => {
  const base = { pick: 'wait' as const, confidence: 0.95, apply: true, lastOrganizerAt: recent, now: NOW };

  it('skips only a confident wait, when applying, with a recent organizer cycle', () => {
    expect(gateHeartbeatTriage(base)).toEqual({ skip: true, reason: null });
  });

  it('an experiment may raise the wait threshold', () => {
    expect(gateHeartbeatTriage({ ...base, confidence: 0.95, waitMinConfidence: 0.97 }).reason).toBe('low_confidence');
  });

  it('dispatches on act, low confidence, a stale organizer or in shadow', () => {
    expect(gateHeartbeatTriage({ ...base, pick: 'act' }).reason).toBe('act');
    expect(gateHeartbeatTriage({ ...base, confidence: WAIT_MIN_CONFIDENCE - 0.01 }).reason).toBe('low_confidence');
    expect(gateHeartbeatTriage({ ...base, lastOrganizerAt: null }).reason).toBe('stale_organizer');
    expect(gateHeartbeatTriage({ ...base, lastOrganizerAt: new Date(NOW.getTime() - TRIAGE_MAX_WAIT_MS - 1) }).reason).toBe('stale_organizer');
    expect(gateHeartbeatTriage({ ...base, apply: false })).toEqual({ skip: false, reason: 'shadow' });
  });
});

describe('triageHeartbeat', () => {
  const input = { teamId: 'team-1', workspaceId: 'ws-1', description: DESCRIPTION, lastOrganizerAt: recent };
  const answer = (choice: 'wait' | 'act', confidence: number) => (async () => ({
    ok: true, answers: { next: { choice, confidence, probabilities: {} } }, usage: {}, latencyMs: 12, attempts: 1,
  })) as any;

  it('never sends a sensitive workspace out', async () => {
    let called = false;
    const r = await triageHeartbeat({ ...input, dataClass: 'sensitive' }, { decide: (async () => { called = true; }) as any, now: () => NOW });
    expect(called).toBe(false);
    expect(r).toMatchObject({ pick: null, skipped: false, reason: 'sensitive' });
  });

  it('asks with the heartbeat_triage capability and the condensed state', async () => {
    let params: any;
    await triageHeartbeat(input, { decide: (async (p: any) => { params = p; return answer('act', 0.9)(); }) as any, now: () => NOW });
    expect(params.capability).toBe('heartbeat_triage');
    expect(params.state).toBe(buildHeartbeatTriageState(DESCRIPTION));
  });

  it('records a confident wait as a skip only when applying', async () => {
    const applied = await triageHeartbeat({ ...input, apply: true }, { decide: answer('wait', 0.97), now: () => NOW });
    expect(applied).toMatchObject({ v: HEARTBEAT_TRIAGE_PROMPT_VERSION, pick: 'wait', confidence: 0.97, skipped: true });
    const shadow = await triageHeartbeat(input, { decide: answer('wait', 0.97), now: () => NOW });
    expect(shadow).toMatchObject({ pick: 'wait', skipped: false, reason: 'shadow' });
  });

  it('dispatches when the call fails or throws', async () => {
    const failed = await triageHeartbeat(input, { decide: (async () => ({ ok: false, error: { kind: 'missing_key' }, latencyMs: 1, attempts: 0 })) as any, now: () => NOW });
    expect(failed).toMatchObject({ pick: null, skipped: false, reason: 'unavailable', error: 'missing_key' });
    const threw = await triageHeartbeat(input, { decide: (async () => { throw new Error('boom'); }) as any, now: () => NOW });
    expect(threw).toMatchObject({ skipped: false, reason: 'unavailable', error: 'boom' });
  });

  it('logs one greppable line', async () => {
    const r = await triageHeartbeat(input, { decide: answer('act', 0.81), now: () => NOW });
    expect(formatTriageLog('m1', r)).toBe(`[heartbeat-triage] mission=m1 v=${HEARTBEAT_TRIAGE_PROMPT_VERSION} pick=act conf=0.81 skipped=false reason=act`);
  });
});

describe('prompt version', () => {
  it('bumps whenever the question changes (re-run the benchmark when it does)', () => {
    expect({ v: HEARTBEAT_TRIAGE_PROMPT_VERSION, hash: heartbeatTriagePromptHash() }).toEqual({ v: 'ht1', hash: 'b0300cdf9f7d' });
  });
});

import { describe, it, expect } from 'bun:test';
import {
  planInPlaceResume, inPlaceResumeMessage, describeResumeOutcome, describeResumeInProgress,
  appendResumeHistory, resumeHistoryOf, resumeLineFor, readInPlaceResume, buildInPlaceResumeIntent,
  RESUME_HISTORY_KEEP, IN_PLACE_PAUSE_DEADLINE_MS, type ResumeHistoryEntry,
} from './in-place-resume-policy';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const fresh = new Date(NOW - 5_000);
const stale = new Date(NOW - 10 * 60_000);
const live = (over: Record<string, unknown> = {}) => ({
  status: 'running', runner: 'runner-a', waitingFor: null, updatedAt: fresh, parkedUntil: null, supportsInstructionAck: true, ...over,
});

describe('planInPlaceResume', () => {
  it('pauses a running agent whose runner is reporting', () => {
    expect(planInPlaceResume(live(), NOW)).toEqual({ kind: 'in_place', step: 'pause' });
  });

  it('resumes a paused agent at once', () => {
    expect(planInPlaceResume(live({ status: 'waiting_input', waitingFor: { type: 'pause' } }), NOW)).toEqual({ kind: 'in_place', step: 'resume_now' });
  });

  it('resumes an agent parked on a question', () => {
    expect(planInPlaceResume(live({ status: 'waiting_input', waitingFor: { type: 'question' } }), NOW)).toEqual({ kind: 'in_place', step: 'resume_now' });
  });

  it('resumes a parked cloud worker from its bundle though no runner is reporting', () => {
    const plan = planInPlaceResume(live({ status: 'waiting_input', waitingFor: { type: 'pause' }, updatedAt: stale, parkedUntil: new Date(NOW + 60_000) }), NOW);
    expect(plan).toEqual({ kind: 'in_place', step: 'resume_now' });
  });

  it.each([
    [null, 'no_live_worker'],
    [live({ runner: 'mcp' }), 'interactive_session'],
    [live({ status: 'starting' }), 'session_not_started'],
    [live({ updatedAt: stale }), 'runner_not_reporting'],
    [live({ status: 'waiting_input', waitingFor: { type: 'pause' }, updatedAt: stale, parkedUntil: new Date(NOW - 1) }), 'runner_not_reporting'],
    [live({ supportsInstructionAck: false }), 'runner_cannot_confirm_delivery'],
    [live({ status: 'waiting_input', waitingFor: { type: 'permission' } }), 'permission_prompt'],
  ] as const)('falls back to a new attempt: %#', (worker, reasonCode) => {
    const plan = planInPlaceResume(worker as never, NOW);
    expect(plan.kind).toBe('new_attempt');
    expect(plan).toMatchObject({ reasonCode });
    expect((plan as { reason: string }).reason.length).toBeGreaterThan(10);
  });
});

describe('wording', () => {
  it('the resume message names the new model and that the session is kept', () => {
    const msg = inPlaceResumeMessage({ cause: 'model_change', fromModel: 'model-a', toModel: 'model-b' });
    expect(msg).toContain('same session');
    expect(msg).toContain('You now run on model-b (before: model-a)');
    expect(inPlaceResumeMessage({ cause: 'requeue', fromModel: 'model-a', toModel: null })).not.toContain('You now run on');
  });

  it('says resumed in place with the old and new model, or new attempt with the reason', () => {
    expect(describeResumeOutcome({ kind: 'resumed_in_place', cause: 'model_change', fromModel: 'model-a', toModel: 'model-b' }))
      .toBe('Resumed in place on model-a → model-b: the same session, with everything it had read and worked out.');
    expect(describeResumeOutcome({ kind: 'resumed_in_place', cause: 'requeue', fromModel: 'model-a', toModel: null }))
      .toMatch(/^Resumed in place: the same session/);
    expect(describeResumeOutcome({ kind: 'new_attempt', cause: 'requeue', fromModel: 'model-a', toModel: null, reason: 'the runner holding the session stopped reporting and nothing was parked' }))
      .toBe('New attempt: the task starts again from its last pushed commit, because the runner holding the session stopped reporting and nothing was parked.');
    expect(describeResumeOutcome({ kind: 'new_attempt', cause: 'model_change', fromModel: 'model-a', toModel: 'model-b', reason: 'x' }))
      .toMatch(/^New attempt: model-b applies from the next attempt/);
  });

  it('describes a resume that has not settled', () => {
    const intent = buildInPlaceResumeIntent({ workerId: 'w-1', cause: 'model_change', phase: 'pausing', fromTier: 'standard', fromModel: 'model-a', toTier: 'premium', toModel: 'model-b', now: NOW });
    expect(describeResumeInProgress(intent)).toBe('Pausing the agent at its next safe point, then resuming the same session on model-a → model-b.');
    expect(describeResumeInProgress({ ...intent, phase: 'resuming' })).toBe('Resuming the same session on model-a → model-b.');
    expect(Date.parse(intent.pauseDeadlineAt) - NOW).toBe(IN_PLACE_PAUSE_DEADLINE_MS);
  });
});

describe('history', () => {
  const entry = (i: number, workerId = 'w-1'): ResumeHistoryEntry => ({
    kind: i % 2 ? 'new_attempt' : 'resumed_in_place', cause: 'requeue', workerId,
    fromModel: 'model-a', toModel: null, fromTier: null, toTier: null, at: new Date(NOW + i).toISOString(),
  });

  it('keeps the newest entries and skips malformed ones', () => {
    let ctx: Record<string, unknown> = { resumeHistory: [{ nope: true }] };
    for (let i = 0; i < RESUME_HISTORY_KEEP + 3; i++) ctx = { resumeHistory: appendResumeHistory(ctx, entry(i)) };
    const list = resumeHistoryOf(ctx);
    expect(list.length).toBe(RESUME_HISTORY_KEEP);
    expect(list.at(-1)!.at).toBe(new Date(NOW + RESUME_HISTORY_KEEP + 2).toISOString());
  });

  it('gives the task page the newest line for one attempt', () => {
    const ctx = { resumeHistory: [entry(1, 'w-1'), entry(2, 'w-1'), entry(3, 'w-2')] };
    expect(resumeLineFor(ctx, 'w-1')).toMatchObject({ kind: 'resumed_in_place' });
    expect(resumeLineFor(ctx, 'w-2')!.text).toMatch(/^New attempt/);
    expect(resumeLineFor(ctx, 'w-3')).toBeNull();
  });

  it('reads an intent back and rejects a malformed one', () => {
    const intent = buildInPlaceResumeIntent({ workerId: 'w-1', cause: 'requeue', phase: 'pausing', fromTier: null, fromModel: null, now: NOW });
    expect(readInPlaceResume({ inPlaceResume: intent })).toEqual(intent);
    expect(readInPlaceResume({ inPlaceResume: { workerId: 'w-1', phase: 'done' } })).toBeNull();
    expect(readInPlaceResume(null)).toBeNull();
  });
});

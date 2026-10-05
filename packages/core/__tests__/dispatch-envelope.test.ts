/**
 * Outbox row → Dispatch envelope (knowledge-base
 * buildd/design/cloudflare-dispatch-transport.md, "Envelope" mapping table).
 * The envelope must be a pure function of the row, so re-publishing a row is
 * always safe: Dispatch dedupes on `id`.
 */
import { describe, expect, test } from 'bun:test';
import { envelopeProblem } from '@buildd/dispatch-contract';
import { parseTargetId, targetId, toEnvelope, type EnvelopeSourceRow } from '../dispatch-envelope';
import { primaryCause } from '../dispatch-outbox';

const WS = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-03T12:00:00Z');

function row(over: Partial<EnvelopeSourceRow> = {}): EnvelopeSourceRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    intent: 'work_execution',
    workspaceId: WS,
    taskId: TASK,
    cause: 'task.created',
    causes: ['task.created'],
    notBefore: new Date(NOW - 1000),
    dedupeKey: 'now',
    attemptCount: 0,
    metadata: null,
    ...over,
  };
}
const ROUTE = { steps: [{ target: targetId(WS, 'runner-wake'), mode: 'first' as const }] };

describe('toEnvelope', () => {
  test('maps every column per the design table, and the result is a valid envelope', () => {
    const e = toEnvelope(row({ attemptCount: 2 }), ROUTE, { now: NOW });
    expect(e).toEqual({
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'work_execution',
      source: { system: 'buildd', scope: `workspace:${WS}`, subject: `task:${TASK}` },
      target: ROUTE,
      dedupeKey: `task:${TASK}:now`,
      payloadRef: 'buildd:dispatch/33333333-3333-4333-8333-333333333333',
      labels: { cause: 'task.created', causes: ['task.created'] },
      attempt: 2,
    });
    expect(envelopeProblem(e)).toBeNull();
  });

  test('labels.cause is primaryCause of the coalesced trail, precedence unchanged', () => {
    const causes = ['task.created', 'plan_child.ready'] as const;
    const e = toEnvelope(row({ causes: [...causes] }), ROUTE, { now: NOW });
    expect(e.labels).toEqual({ cause: 'plan_child.ready', causes: [...causes] });
    expect(e.labels!.cause).toBe(primaryCause([...causes], 'task.created'));
  });

  test('notBefore is carried only when it is in the future', () => {
    expect(toEnvelope(row({ notBefore: new Date(NOW) }), ROUTE, { now: NOW }).notBefore).toBeUndefined();
    const due = new Date(NOW + 60_000);
    expect(toEnvelope(row({ notBefore: due, dedupeKey: `start_at:${due.getTime()}` }), ROUTE, { now: NOW })).toMatchObject({
      notBefore: due.toISOString(),
      dedupeKey: `task:${TASK}:start_at:${due.getTime()}`,
    });
  });

  test('a non-work kind keeps its namespaced dedupe key, so it never collapses into a runner wake', () => {
    const e = toEnvelope(row({ intent: 'human_action', dedupeKey: 'human_action:now', causes: ['policy.requested'], cause: 'policy.requested' }), ROUTE, { now: NOW });
    expect(e.kind).toBe('human_action');
    expect(e.dedupeKey).toBe(`task:${TASK}:human_action:now`);
    expect(e.dedupeKey).not.toBe(toEnvelope(row(), ROUTE, { now: NOW }).dedupeKey);
  });

  test('the inline payload rides along; an empty one is omitted', () => {
    const payload = { taskId: TASK, workspaceId: WS, dispatchId: 'x' };
    expect(toEnvelope(row(), { ...ROUTE, payload }, { now: NOW }).payload).toEqual(payload);
    expect('payload' in toEnvelope(row(), { ...ROUTE, payload: {} }, { now: NOW })).toBe(false);
  });

  test('a causes column that arrives as a JSON string is parsed', () => {
    const e = toEnvelope(row({ causes: '["task.created","ci.retry"]' as never }), ROUTE, { now: NOW });
    expect(e.labels).toEqual({ cause: 'ci.retry', causes: ['task.created', 'ci.retry'] });
  });

  test('is deterministic: the same row maps to the same envelope', () => {
    expect(toEnvelope(row(), ROUTE, { now: NOW })).toEqual(toEnvelope(row(), ROUTE, { now: NOW }));
  });
});

describe('target ids', () => {
  test('round-trip and reject anything else', () => {
    expect(targetId(WS, 'webhook')).toBe(`buildd:ws:${WS}:webhook`);
    expect(parseTargetId(targetId(WS, 'runner-wake'))).toEqual({ workspaceId: WS, type: 'runner-wake' });
    expect(parseTargetId(`buildd:ws:${WS}:slack`)).toBeNull();
    // A queued intent from before GitHub Actions was removed names a type no callback serves.
    expect(parseTargetId(`buildd:ws:${WS}:github-actions`)).toBeNull();
    expect(parseTargetId(`buildd:ws:not-a-uuid:webhook`)).toBeNull();
    expect(parseTargetId(`other:ws:${WS}:webhook`)).toBeNull();
  });
});

/**
 * The pure halves of the kernel replay harness: the sanitizer, the corpus
 * reader, step ordering, command reconstruction, the recorded reader and the
 * decision diff. The database half is apps/web/tests/db/workflow-replay.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { compactIds, expandIds, parseCorpus, readCorpus, type CorpusDelivery, type CorpusTransition } from './corpus';
import { canonical, firstDivergence, remapIds, type StepDecision } from './diff';
import { recordedReader, UnansweredRead } from './recorded-github';
import { buildSteps, reconstructCommand } from './reconstruct';
import { isProse, Pseudonymizer, REDACTED, redactProse } from './sanitize';
import type { KernelView } from '../types';

const FIXTURE = join(import.meta.dir, 'fixtures/synthetic-corpus.jsonl');
const SALT = Buffer.alloc(32, 7);
const A_UUID = '5f0c2a8e-3b1d-4c6a-9e2f-7a8b9c0d1e2f';
const A_SHA = 'c0ffee'.repeat(6) + 'beef';

describe('sanitize', () => {
  test('ids, SHAs, repos, branches and people become stable pseudonyms, inside any string', () => {
    const p = new Pseudonymizer(SALT);
    const raw = { repoFullName: 'acme/widgets', baseRef: 'feature/x-y', key: `head:acme/widgets#7:${A_SHA}->${A_SHA}@v3`, actor: 'human:octocat', id: A_UUID, url: 'https://github.com/acme/widgets/pull/7' };
    p.collect(raw);
    const out = p.value(raw, 0);
    const text = JSON.stringify(out);
    for (const s of ['acme', 'widgets', 'feature/x-y', 'octocat', A_UUID, A_SHA]) expect(text).not.toContain(s);
    expect(out.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(out.key).toBe(`head:${out.repoFullName}#7:${p.sha(A_SHA)}->${p.sha(A_SHA)}@v3`);
    expect(out.url).toBe(`https://github.com/${out.repoFullName}/pull/7`);
    expect(out.actor).toMatch(/^human:user-[0-9a-f]{10}$/);
    // Same salt, same answers; trunk names are not identifying.
    expect(new Pseudonymizer(SALT).uuid(A_UUID)).toBe(out.id);
    expect(p.value({ baseRef: 'dev' }, 0)).toEqual({ baseRef: 'dev' });
  });

  test('prose and free-text keys are redacted; enum-like strings are kept', () => {
    const p = new Pseudonymizer(SALT);
    expect(p.value({ reason: 'please do not merge', state: 'APPROVED', body: 'x', surface: 'POST /api/tasks' }, 0))
      .toEqual({ reason: REDACTED, state: 'APPROVED', body: REDACTED, surface: 'POST /api/tasks' });
    expect(p.value({ link: 'https://tracker.example/issue/1' }, 0)).toEqual({ link: REDACTED });
    expect(isProse('state_moved')).toBe(false);
    expect(redactProse({ detail: 'base moved 3 times', note: 'no_open_pr_head' })).toEqual({ detail: REDACTED, note: 'no_open_pr_head' });
  });

  test('timestamps move to a 2000-01-01 epoch, keeping their format and relative timing', () => {
    const p = new Pseudonymizer(SALT);
    const created = Date.parse('2026-10-06T10:00:00Z');
    expect(p.value({ at: '2026-10-06T10:00:05Z', k: 'closed:r#1:2026-10-06T10:00:01.250+00:00' }, created))
      .toEqual({ at: '2000-01-01T00:00:05Z', k: 'closed:r#1:2000-01-01T00:00:01.250+00:00' });
  });
});

describe('corpus', () => {
  test('the fixture holds placeholders, never a UUID, and parses into replayable deliveries', async () => {
    const text = await Bun.file(FIXTURE).text();
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    const corpus = readCorpus(FIXTURE);
    expect(corpus.length).toBeGreaterThan(0);
    expect(corpus.every((c) => /^[0-9a-f-]{36}$/.test(c.delivery.id) && c.transitions.length > 0)).toBe(true);
  });

  test('compactIds and expandIds round-trip consistently', () => {
    const text = `{"a":"${A_UUID}","b":"x:${A_UUID}","c":"${A_UUID.toUpperCase()}"}`;
    const compact = compactIds(text);
    expect(compact).toBe('{"a":"{id:1}","b":"x:{id:1}","c":"{id:1}"}');
    expect(JSON.parse(expandIds(compact)).a).toBe('00000000-0000-4000-8000-000000000001');
  });

  test('a wrong version or a broken line is refused, never skipped', () => {
    expect(() => parseCorpus('{"v":2,"delivery":{"id":"x"},"transitions":[],"facts":[]}')).toThrow(/version/);
    expect(() => parseCorpus('not json')).toThrow(/not JSON/);
    expect(parseCorpus('\n\n')).toEqual([]);
  });
});

const t = (o: Partial<CorpusTransition> & Pick<CorpusTransition, 'command' | 'toVersion'>): CorpusTransition => ({
  id: `t${o.toVersion}`, fromVersion: o.toVersion - 1, fromState: null, toState: 'WORKING', idempotencyKey: `k${o.toVersion}`, actor: 'kernel',
  evidence: {}, bypass: null, tUs: o.toVersion * 10, ...o,
});

function delivery(over: Partial<CorpusDelivery> = {}): CorpusDelivery {
  return {
    v: 1,
    delivery: { id: 'd', workspaceId: 'w', ownerTaskId: 'o', repoFullName: 'r/r', prNumber: 1, baseRef: 'dev', state: 'WORKING', stateReason: null, version: 1, currentHeadSha: 'h', currentRound: 0, maxRounds: 3, approvedHeads: [], approvalBasis: null, compositionHeads: [], authority: 'kernel' },
    outcome: { ownerTaskStatus: null, attemptTaskStatuses: [], gateRefusals: 0, errorPatterns: {} },
    facts: [], transitions: [], effects: [], rounds: [], attempts: [], gateEvents: [],
    ...over,
  };
}

const view = (state = 'APPROVED', head = 'H1'): KernelView => ({
  delivery: { id: 'rd', workspaceId: 'w', ownerTaskId: 'o', repoFullName: 'r/r', prNumber: 1, baseRef: 'dev', state: state as never, stateReason: null, version: 4, currentHeadSha: head, currentRound: 1, maxRounds: 3, boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: [head], approvalBasis: 'verdict', compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null, mergeCommitSha: null, supersededByPr: null },
  rounds: [], attempts: [],
});

describe('steps', () => {
  test('a fact applied by a transition is that step; an unapplied one sits where it was observed', () => {
    const c = delivery({
      transitions: [t({ command: 'HeadObserved', toVersion: 2 }), t({ command: 'DeliveryOpened', toVersion: 1 }), t({ command: 'ReviewVerdictRecorded', toVersion: 3 })],
      facts: [
        { id: 'f1', kind: 'delivery_opened', factKey: 'open:o', source: 'runner', repoFullName: null, prNumber: null, payload: {}, appliedTransitionId: 't1', tUs: 5 },
        { id: 'f2', kind: 'head_observed', factKey: 'x', source: 'webhook', repoFullName: 'r/r', prNumber: 1, payload: {}, appliedTransitionId: 't2', tUs: 15 },
        { id: 'f3', kind: 'head_observed', factKey: 'y', source: 'webhook', repoFullName: 'r/r', prNumber: 1, payload: {}, appliedTransitionId: null, tUs: 25 },
        { id: 'f4', kind: 'pr_closed', factKey: 'z', source: 'webhook', repoFullName: 'r/r', prNumber: 1, payload: {}, appliedTransitionId: null, tUs: 99 },
      ],
    });
    expect(buildSteps(c).map((s) => (s.kind === 'fact' ? `${s.fact.id}${s.expected ? `>${s.expected.id}` : ''}` : s.expected.id)))
      .toEqual(['f1>t1', 'f2>t2', 'f3', 't3', 'f4']);
  });
});

describe('reconstructCommand', () => {
  const ctx = (c: CorpusDelivery, v = view()) => ({ view: v, corpus: c, factIds: new Map<string, string>() });

  test('a landing request is rebuilt from its key, evidence, bypass and merge_call effect', () => {
    const tr = t({ command: 'LandingRequested', toVersion: 5, idempotencyKey: 'merge:r/r#1:H1:v4', actor: 'human:u', evidence: { door: 'dashboard', rails: { passed: true } }, bypass: { reason: REDACTED, kinds: ['freshness'] } });
    const c = delivery({ transitions: [tr], effects: [{ id: 'e', transitionId: tr.id, kind: 'merge_call', dedupeKey: 'm', payload: { mergeMethod: 'rebase' }, status: 'done', outcome: null, tUs: 0 }] });
    const r = reconstructCommand(tr, ctx(c));
    expect(r).toMatchObject({ ok: true, cmd: { type: 'LandingRequested', headSha: 'H1', door: 'dashboard', mergeMethod: 'rebase', override: { reason: REDACTED, kinds: ['freshness'] }, live: { headSha: 'H1', state: 'open' } } });
  });

  test('an owner attempt end names the inputs it had to read off the outcome', () => {
    const tr = t({ command: 'AttemptEnded', toVersion: 3, toState: 'AWAITING_REVIEW', idempotencyKey: 'end:W', evidence: { outcome: 'success', localHeadSha: 'L', commitCount: 1, live: { headSha: 'H2', state: 'open', merged: false } } });
    const r = reconstructCommand(tr, ctx(delivery(), view('WORKING', 'H1')));
    expect(r).toMatchObject({ ok: true, cmd: { type: 'AttemptEnded', workerId: 'W', taskId: 'o', proof: { liveContainsLocal: true } }, inferred: ['proof.liveContainsLocal'] });
  });

  test('a transition the record cannot rebuild says what is missing', () => {
    expect(reconstructCommand(t({ command: 'MergeCallResult', toVersion: 2, idempotencyKey: 'mergeresult:r/r#1:H1:4:merged' }), ctx(delivery())))
      .toMatchObject({ ok: false, missing: expect.stringContaining('MergeCallResult') });
    expect(reconstructCommand(t({ command: 'HeadObserved', toVersion: 2 }), ctx(delivery()))).toMatchObject({ ok: false });
  });
});

describe('recordedReader', () => {
  test('answers the PR read and the compare calls the fact recorded, and refuses the rest', async () => {
    const v = view('REPAIRING');
    v.attempts = [{ id: 'a', family: 'ci', attemptNo: 1, mode: 'agent', boundHeadSha: 'B', triggerReason: 's', taskId: null, status: 'running', outcome: null, maxAttempts: 3, reportedShas: ['L'] }];
    v.delivery!.boundAttemptId = 'a';
    const r = recordedReader({ live: { headSha: 'H2', state: 'open', merged: false }, proof: { liveContainsLocal: false }, attribution: { descendsFromBound: true } }, v);
    expect((await r.readPr('r/r', 1))?.headSha).toBe('H2');
    expect(await r.contains!('r/r', 'L', 'H2')).toBe(false);
    expect(await r.contains!('r/r', 'B', 'H2')).toBe(true);
    await expect(r.contains!('r/r', 'Z', 'H2')).rejects.toBeInstanceOf(UnansweredRead);
    await expect(r.ciGreen!('r/r', 'H2')).rejects.toBeInstanceOf(UnansweredRead);
    await expect(recordedReader({}, v).readPr('r/r', 1)).rejects.toBeInstanceOf(UnansweredRead);
  });
});

describe('firstDivergence', () => {
  const dec = (o: Partial<NonNullable<StepDecision['transition']>> = {}, effects: StepDecision['effects'] = []): StepDecision => ({
    transition: { command: 'X', fromState: 'A', toState: 'B', fromVersion: 1, toVersion: 2, idempotencyKey: 'k', actor: 'a', evidence: { x: 1, y: [1, 2] }, bypass: null, ...o },
    effects,
  });

  test('the same decision, key order aside, is no divergence', () => {
    expect(firstDivergence(dec(), dec({ evidence: { y: [1, 2], x: 1 } }))).toBeNull();
    expect(canonical({ b: 1, a: undefined })).toBe('{"b":1}');
  });

  test('names the first field that differs, an effect present on one side only, or a missing transition', () => {
    expect(firstDivergence(dec(), dec({ toState: 'C' }))).toEqual({ field: 'transition.toState', recorded: 'B', replayed: 'C' });
    expect(firstDivergence(dec({}, [{ kind: 'notify', dedupeKey: 'n', payload: {} }]), dec())).toEqual({ field: 'effects[n]', recorded: 'notify', replayed: null });
    expect(firstDivergence(dec(), { transition: null, effects: [] })?.field).toBe('transition');
  });

  test('remapIds swaps replay ids back to recorded ones at any depth', () => {
    expect(remapIds({ k: 'render:R1:3', n: ['R1'] }, new Map([['R1', 'D1']]))).toEqual({ k: 'render:D1:3', n: ['D1'] });
  });
});

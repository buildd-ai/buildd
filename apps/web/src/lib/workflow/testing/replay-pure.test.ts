/**
 * The pure halves of the kernel replay harness: the sanitizer, the corpus
 * reader, step ordering, command reconstruction, the recorded reader and the
 * decision diff. The database half is apps/web/tests/db/workflow-replay.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { compactIds, expandIds, parseCorpus, readCorpus, type CorpusAttempt, type CorpusDelivery, type CorpusTransition } from './corpus';
import { canonical, firstDivergence, normalizeForCompare, remapIds, RETIRED_INPUTS, SUPERSEDED_DECISIONS, type StepDecision } from './diff';
import { recordedReader, UnansweredRead } from './recorded-github';
import { buildSteps, isDecisionEffect, outOfBandAttemptEnds, outOfBandEffects, outOfBandFacts, reconstructCommand } from './reconstruct';
import { isProse, Pseudonymizer, REDACTED, redactProse } from './sanitize';
import type { AttemptSnapshot, KernelView } from '../types';

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

  test('GitHub Actions run and job ids are pseudonymized; a PR number is not', () => {
    const p = new Pseudonymizer(SALT);
    const raw = { repoFullName: 'acme/widgets', url: 'https://github.com/acme/widgets/actions/runs/1234567890/job/9876543210', pr: 'https://github.com/acme/widgets/pull/42' };
    p.collect(raw);
    const out = p.value(raw, 0);
    expect(out.url).not.toContain('1234567890');
    expect(out.url).not.toContain('9876543210');
    expect(out.url).toMatch(/^https:\/\/github\.com\/org-[0-9a-f]{8}\/repo-[0-9a-f]{8}\/actions\/runs\/[1-9]\d{9}\/job\/[1-9]\d{9}$/);
    expect(out.pr).toBe(`https://github.com/${out.repoFullName}/pull/42`);
    // Stable within an export: the same run is the same pseudonym wherever it appears.
    expect(p.value({ u: 'https://github.com/acme/widgets/actions/runs/1234567890' }, 0).u).toBe(out.url.split('/job/')[0]);
  });

  test('redactProse keeps the exporter\'s exemptions, so a sanitized recording compares equal to the replayed text', () => {
    expect(redactProse({ surface: 'POST /api/tasks', detail: 'base moved 3 times under the approved PR' })).toEqual({ surface: 'POST /api/tasks', detail: REDACTED });
    const p = new Pseudonymizer(SALT);
    const replayed = { event: 'landing_needs_human', detail: 'base moved 3 times under the approved PR (refresh cycle 1 of 3)' };
    expect(redactProse(replayed)).toEqual(p.value(replayed, 0));
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

  test('an activity note is not a step, and an effect a later statement hung on a transition is not its decision', () => {
    const t1 = t({ command: 'DeliveryOpened', toVersion: 1 });
    const t2 = t({ command: 'AttemptEnded', toVersion: 2, toState: 'AWAITING_PUSH' });
    const fx = (id: string, transitionId: string, tUs: number) => ({ id, transitionId, kind: 'push_recovery', dedupeKey: id, payload: {}, status: 'done', outcome: null, tUs });
    const c = delivery({
      transitions: [t1, t2],
      facts: [
        { id: 'f1', kind: 'delivery_opened', factKey: 'open:o', source: 'runner', repoFullName: null, prNumber: null, payload: {}, appliedTransitionId: 't1', tUs: 5 },
        { id: 'n1', kind: 'activity_note', factKey: 'activity:d:x:0', source: 'legacy:appendPrActivity', repoFullName: 'r/r', prNumber: 1, payload: {}, appliedTransitionId: null, tUs: 12 },
      ],
      effects: [fx('own', 't2', t2.tUs), fx('drain-try-2', 't2', t2.tUs + 1), fx('note-render', 't1', 12)],
    });
    expect(buildSteps(c).map((s) => (s.kind === 'fact' ? s.fact.id : s.expected.id))).toEqual(['f1', 't2']);
    expect(outOfBandFacts(c).map((f) => f.id)).toEqual(['n1']);
    expect(c.effects.filter((e) => isDecisionEffect(e, t2)).map((e) => e.id)).toEqual(['own']);
    expect(outOfBandEffects(c).map((e) => e.id)).toEqual(['note-render', 'drain-try-2']);
  });
});

describe('reconstructCommand', () => {
  const ctx = (c: CorpusDelivery, v = view()) => ({ view: v, corpus: c, factIds: new Map<string, string>() });

  test('a landing request is rebuilt from its key, evidence, bypass and merge_call effect', () => {
    const tr = t({ command: 'LandingRequested', toVersion: 5, idempotencyKey: 'merge:r/r#1:H1:v4', actor: 'human:u', evidence: { door: 'dashboard', rails: { passed: true } }, bypass: { reason: REDACTED, kinds: ['freshness'] } });
    const c = delivery({ transitions: [tr], effects: [{ id: 'e', transitionId: tr.id, kind: 'merge_call', dedupeKey: 'm', payload: { mergeMethod: 'rebase' }, status: 'done', outcome: null, tUs: tr.tUs }] });
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

/**
 * bc92e43f: a conflict repair that escalates to an agent. The head the first agent
 * attempt pushed took the delivery out of REPAIRING; its worker ended later, unbound,
 * which writes the attempt row and no transition. A second conflict at a new head goes
 * REPAIRING (mechanical), the refresh is refused, and `effect:refresh_branch` records
 * ConflictObserved REPAIRING -> REPAIRING with an agent attempt.
 */
describe('a conflict repair escalating to an agent', () => {
  const att = (o: Partial<AttemptSnapshot> & Pick<AttemptSnapshot, 'id' | 'mode' | 'attemptNo' | 'status'>): AttemptSnapshot => ({
    family: 'conflict', boundHeadSha: 'H1', triggerReason: 'conflict', taskId: null, outcome: null, maxAttempts: 3, reportedShas: [], ...o,
  });
  const rec = (o: Partial<CorpusAttempt> & Pick<CorpusAttempt, 'id' | 'mode' | 'attemptNo' | 'status' | 'tUs'>): CorpusAttempt => ({
    family: 'conflict', boundHeadSha: 'H1', triggerReason: 'conflict', triggerFactId: null, taskId: null, trigger: 'automatic',
    reportedShas: [], pushedHeadSha: null, outcome: null, maxAttempts: 3, ...o,
  });
  // The replay's delivery just before the escalation: REPAIRING at H2, mechanical try 2 bound.
  const repairing = (): KernelView => {
    const v = view('REPAIRING', 'H2');
    v.delivery!.boundAttemptId = 'm2';
    v.attempts = [
      att({ id: 'm1', mode: 'mechanical', attemptNo: 1, status: 'ended', outcome: 'failed' }),
      att({ id: 'a1', mode: 'agent', attemptNo: 1, status: 'running', outcome: 'delivered' }),
      att({ id: 'm2', mode: 'mechanical', attemptNo: 2, status: 'queued', boundHeadSha: 'H2' }),
    ];
    return v;
  };
  const escalation = t({
    command: 'ConflictObserved', toVersion: 9, fromState: 'REPAIRING', toState: 'REPAIRING', idempotencyKey: 'conflict:d:H2:a2', actor: 'effect:refresh_branch', tUs: 900,
    evidence: { mode: 'agent', actor: 'effect:refresh_branch', headSha: 'H2', repairKind: 'conflict' },
  });

  test('the escalation is rebuilt as the refused mechanical repair the effect sent, whatever the replay ledger shows', () => {
    const c = delivery({ transitions: [escalation], attempts: [rec({ id: 'a2', mode: 'agent', attemptNo: 2, status: 'queued', boundHeadSha: 'H2', tUs: escalation.tUs })] });
    const ctx = (v: KernelView) => ({ view: v, corpus: c, factIds: new Map<string, string>() });
    expect(reconstructCommand(escalation, ctx(repairing()))).toMatchObject({ ok: true, cmd: { type: 'ConflictObserved', mechanicalRefused: true, headSha: 'H2' } });
    // No open mechanical try in the replay's view: the record still says who sent it.
    const noMech = repairing();
    noMech.attempts = noMech.attempts.filter((a) => a.id !== 'm2');
    expect(reconstructCommand(escalation, ctx(noMech))).toMatchObject({ ok: true, cmd: { mechanicalRefused: true } });
    // The door's own observation is never a refusal, open mechanical try or not.
    const door = t({ ...escalation, actor: 'door:conflict', evidence: { ...escalation.evidence, actor: 'door:conflict' } });
    expect(reconstructCommand(door, ctx(repairing()))).toMatchObject({ ok: true, cmd: { mechanicalRefused: false } });
  });

  test('an attempt the record shows ended with no transition writing it is ended before the step, at its recorded time when there is one', () => {
    const steps = [t({ command: 'ConflictObserved', toVersion: 8, tUs: 500 }), escalation];
    const base = { id: 'a1', mode: 'agent', attemptNo: 1, status: 'ended', outcome: 'delivered', tUs: 100 } as const;
    const ends = (a1: CorpusAttempt, beforeUs: number, v = repairing()) =>
      outOfBandAttemptEnds(delivery({ transitions: steps, attempts: [a1, rec({ id: 'm2', mode: 'mechanical', attemptNo: 2, status: 'ended', outcome: 'failed', boundHeadSha: 'H2', endedUs: escalation.tUs, tUs: 500 })] }), v, beforeUs);

    // Timed: before the step, and no transition shares the statement.
    expect(ends(rec({ ...base, endedUs: 300 }), escalation.tUs)).toEqual([{ attemptId: 'a1', status: 'ended', outcome: 'delivered', timed: true }]);
    expect(ends(rec({ ...base, endedUs: 300 }), 200)).toEqual([]);
    expect(ends(rec({ ...base, endedUs: 500 }), escalation.tUs)).toEqual([]);
    // A corpus exported before the end time was: an unbound worker end, inferred.
    expect(ends(rec(base), escalation.tUs)).toEqual([{ attemptId: 'a1', status: 'ended', outcome: 'delivered', timed: false }]);
    // Untimed, it is never applied to the bound attempt, nor to a cancellation (a transition's write).
    const bound = repairing();
    bound.delivery!.boundAttemptId = 'a1';
    expect(ends(rec(base), escalation.tUs, bound)).toEqual([]);
    expect(ends(rec({ ...base, status: 'cancelled', outcome: 'noop' }), escalation.tUs)).toEqual([]);
    // Nor to a row still waiting for its claim: a review fix is queued and unbound until FixClaimed.
    const unclaimed = repairing();
    unclaimed.attempts = unclaimed.attempts.map((a) => (a.id === 'a1' ? { ...a, status: 'queued' as const } : a));
    expect(ends(rec(base), escalation.tUs, unclaimed)).toEqual([]);
    // Already ended in the replay: nothing to do.
    const closed = repairing();
    closed.attempts = closed.attempts.map((a) => (a.id === 'a1' ? { ...a, status: 'ended' as const } : a));
    expect(ends(rec(base), escalation.tUs, closed)).toEqual([]);
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

  test('#4072 treadmill evidence is tolerated only in its exact shape, and prose compares redacted', () => {
    const esc = (evidence: Record<string, unknown>, effects: StepDecision['effects'] = []) =>
      dec({ command: 'ConflictObserved', toState: 'ESCALATED', idempotencyKey: 'conflict:d:H:treadmill', evidence }, effects);
    const old = { actor: 'door:conflict', headSha: 'H', refreshes: 3, repairKind: 'behind' };
    const notify = (detail: string) => [{ kind: 'notify', dedupeKey: 'notify:d:treadmill:H', payload: { event: 'landing_needs_human', detail } }];
    const now = esc({ ...old, treadmill: true, cycle: 1 }, notify('base moved 3 times under the approved PR (refresh cycle 1 of 3)'));
    const r = normalizeForCompare(esc(old, notify(REDACTED)), now, redactProse);
    expect(firstDivergence(r.recorded, r.replayed)).toBeNull();
    expect(r.tolerated).toEqual([expect.stringContaining('#4072')]);
    // Anything beyond the added keys, a later cycle, a final cycle or another command stays a divergence.
    for (const replayed of [
      esc({ ...old, treadmill: true, cycle: 2 }),
      esc({ ...old, treadmill: true, cycle: 1, finalCycle: true }),
      esc({ ...old, treadmill: true, cycle: 1, refreshes: 4 }),
      dec({ command: 'CiFailedObserved', toState: 'ESCALATED', idempotencyKey: 'conflict:d:H:treadmill', evidence: { ...old, treadmill: true, cycle: 1 } }),
    ]) {
      const n = normalizeForCompare(esc(old), replayed, redactProse);
      expect(firstDivergence(n.recorded, n.replayed)).not.toBeNull();
    }
    // An identical step needs no tolerance.
    expect(normalizeForCompare(now, now, redactProse).tolerated).toEqual([]);
  });

  test('10658a4c: a version-bound key is tolerated against its bare recorded key, and only that', () => {
    const t7 = (key: string, fx: string) => dec({ command: 'ReviewBudgetExhausted', toState: 'ESCALATED', idempotencyKey: key },
      [{ kind: 'escalate_exhaustion', dedupeKey: fx, payload: { family: 'review_fix', rounds: 3 } }]);
    const r = normalizeForCompare(t7('exhaust:d:H', 'exhaust:d:H'), t7('exhaust:d:H@v5', 'exhaust:d:H@v5'), redactProse);
    expect(firstDivergence(r.recorded, r.replayed)).toBeNull();
    expect(r.tolerated).toEqual([expect.stringContaining('10658a4c')]);
    const policy = (key: string) => dec({ command: 'PolicyEvidenceRecorded', toState: 'ESCALATED', idempotencyKey: key });
    const p = normalizeForCompare(policy('policy:d:H:human'), policy('policy:d:H:human@v7'), redactProse);
    expect(firstDivergence(p.recorded, p.replayed)).toBeNull();
    // Another head, another prefix, or a suffix the recording also had: still a divergence.
    for (const [rec, rep] of [['exhaust:d:H', 'exhaust:d:H2@v5'], ['end:w', 'end:w@v5']] as const) {
      const n = normalizeForCompare(policy(rec), policy(rep), redactProse);
      expect(firstDivergence(n.recorded, n.replayed)).not.toBeNull();
    }
  });

  test('10658a4c: a dead dispatch_review recorded as effect_dead is tolerated; any other dead effect is not', () => {
    const dead = (effectKind: string, reason: string) => dec({ command: 'EffectDead', toState: 'ESCALATED', idempotencyKey: 'effectdead:e1', evidence: { effectKind, reason } },
      [{ kind: 'notify', dedupeKey: 'notify:d:effectdead:e1', payload: { event: 'effect_dead', effectKind, reason } }]);
    const r = normalizeForCompare(dead('dispatch_review', 'effect_dead'), dead('dispatch_review', 'review_unavailable'), redactProse);
    expect(firstDivergence(r.recorded, r.replayed)).toBeNull();
    const n = normalizeForCompare(dead('dispatch_fix', 'effect_dead'), dead('dispatch_fix', 'review_unavailable'), redactProse);
    expect(firstDivergence(n.recorded, n.replayed)).not.toBeNull();
  });

  const clean = (recorded: StepDecision, replayed: StepDecision) => {
    const n = normalizeForCompare(recorded, replayed, redactProse);
    return { div: firstDivergence(n.recorded, n.replayed), tolerated: n.tolerated };
  };

  test('#4911: a round trigger on dispatch_review is tolerated only when the recording has none and the trigger is a known one', () => {
    const fx = (payload: Record<string, unknown>) => dec({ command: 'AttemptEnded', toState: 'AWAITING_REVIEW' }, [{ kind: 'dispatch_review', dedupeKey: 'dispatch_review:d:1', payload }]);
    const old = { roundId: 'r1', round: 1, headSha: 'H', kind: 'full', priorRound: null, scope: null };
    const r = clean(fx(old), fx({ ...old, trigger: 'first_pass' }));
    expect(r.div).toBeNull();
    expect(r.tolerated).toEqual([expect.stringContaining('#4911')]);
    for (const replayed of [fx({ ...old, trigger: 'not_a_trigger' }), fx({ ...old, trigger: 'first_pass', round: 2 })]) expect(clean(fx(old), replayed).div).not.toBeNull();
    // A recording that carries a trigger is compared as is.
    expect(clean(fx({ ...old, trigger: 'first_pass' }), fx({ ...old, trigger: 'new_commits' })).div).not.toBeNull();
  });

  test('#4911: a full round after an approval stands for the recorded delta round only with the unread eligibility answer', () => {
    const fx = (payload: Record<string, unknown>) => dec({ command: 'HeadObserved', fromState: 'APPROVED', toState: 'AWAITING_REVIEW' }, [{ kind: 'dispatch_review', dedupeKey: 'dispatch_review:d:2', payload }]);
    const old = { roundId: 'r2', round: 2, headSha: 'H2', priorRound: 1 };
    const base = { ...old, trigger: 'new_commits' };
    const recorded = fx({ ...old, kind: 'delta', scope: null });
    const unread = { deltaApproval: { eligible: false, reason: 'the delta could not be read', fromHeadSha: null } };
    expect(clean(recorded, fx({ ...base, kind: 'full', scope: unread })).div).toBeNull();
    for (const scope of [
      { deltaApproval: { eligible: true, reason: 'small', fromHeadSha: 'H1', files: 1, lines: 2 } },
      { deltaApproval: { eligible: false, reason: 'too big', fromHeadSha: 'H1', files: 40, lines: 9000 } },
      { ...unread, other: 1 },
    ]) expect(clean(recorded, fx({ ...base, kind: 'full', scope })).div).not.toBeNull();
    // A recorded full round, or a recorded delta with a scope, is not this change.
    expect(clean(fx({ ...old, kind: 'full', scope: null }), fx({ ...base, kind: 'full', scope: unread })).div).not.toBeNull();
  });

  test('#4368: the unread freshness verdict on a behind refresh is tolerated, a read one is not', () => {
    const refresh = (evidence: Record<string, unknown>) => dec({ command: 'ConflictObserved', fromState: 'APPROVED', toState: 'REPAIRING', idempotencyKey: 'conflict:d:H:m1', evidence });
    const old = { actor: 'door:conflict', headSha: 'H', mode: 'mechanical', repairKind: 'behind' };
    const r = clean(refresh(old), refresh({ ...old, freshness: { tolerated: false, cause: 'unread' } }));
    expect(r.div).toBeNull();
    expect(r.tolerated).toEqual([expect.stringContaining('#4368')]);
    for (const freshness of [{ tolerated: false, cause: 'refresh_unsafe', files: ['a'] }, { tolerated: true, rule: 'bounded' }, { tolerated: false, cause: 'unread', behindBy: 3 }]) {
      expect(clean(refresh(old), refresh({ ...old, freshness })).div).not.toBeNull();
    }
    expect(clean(refresh(old), dec({ command: 'CiFailedObserved', fromState: 'APPROVED', toState: 'REPAIRING', idempotencyKey: 'conflict:d:H:m1', evidence: { ...old, freshness: { tolerated: false, cause: 'unread' } } })).div).not.toBeNull();
  });

  test('S5 #4815: findings on escalate_exhaustion are tolerated only when the recording has none', () => {
    const fx = (payload: Record<string, unknown>) => dec({ command: 'ReviewVerdictRecorded', fromState: 'AWAITING_REVIEW', toState: 'ESCALATED' }, [{ kind: 'escalate_exhaustion', dedupeKey: 'exhaust:d:H@v4', payload }]);
    expect(clean(fx({ family: 'review_fix', rounds: 4 }), fx({ family: 'review_fix', rounds: 4, findings: ['f:0'] })).div).toBeNull();
    expect(clean(fx({ family: 'review_fix', rounds: 4 }), fx({ family: 'review_fix', rounds: 5, findings: ['f:0'] })).div).not.toBeNull();
    expect(clean(fx({ family: 'review_fix', rounds: 4, findings: [] }), fx({ family: 'review_fix', rounds: 4, findings: ['f:0'] })).div).not.toBeNull();
  });

  test('a90fc99b: a cycle-1 treadmill escalation may lack exactly the recorded landing_needs_human notice', () => {
    const notify = [{ kind: 'notify', dedupeKey: 'notify:d:treadmill:H', payload: { event: 'landing_needs_human', detail: REDACTED } }];
    const esc = (evidence: Record<string, unknown>, effects: StepDecision['effects'] = []) =>
      dec({ command: 'ConflictObserved', fromState: 'APPROVED', toState: 'ESCALATED', idempotencyKey: 'conflict:d:H:treadmill', evidence }, effects);
    const old = { actor: 'door:conflict', headSha: 'H', refreshes: 3, repairKind: 'behind' };
    const r = clean(esc(old, notify), esc({ ...old, treadmill: true, cycle: 1 }));
    expect(r.div).toBeNull();
    expect(r.tolerated).toEqual([expect.stringContaining('a90fc99b'), expect.stringContaining('#4072')]);
    // The final cycle still pages, so a missing notice there is a divergence; so is another missing effect.
    expect(clean(esc(old, notify), esc({ ...old, treadmill: true, cycle: 1, finalCycle: true })).div).not.toBeNull();
    expect(clean(esc(old, [{ ...notify[0], payload: { event: 'other' } }]), esc({ ...old, treadmill: true, cycle: 1 })).div).not.toBeNull();
  });

  test('a decision the kernel replaced on purpose is recognised only in its exact shape, and never rewritten', () => {
    const [abe, budget] = SUPERSEDED_DECISIONS;
    const end = (toState: string, evidence: Record<string, unknown>) => dec({ command: 'AttemptEnded', fromState: 'FIXING', toState, idempotencyKey: 'end:w', evidence });
    const parked = end('AWAITING_PUSH', { outcome: 'success', commitCount: 0, localHeadSha: null, proof: { holds: false, reason: 'local_head_unknown' } });
    const next = end('AWAITING_REVIEW', { outcome: 'success', commitCount: 0, localHeadSha: null, proof: { holds: true } });
    expect(abe.matches(parked, next, { state: 'FIXING', stateReason: null })).toBe(true);
    // Unreported commits are not proof, a known local head is another decision, and so is any other to-state.
    expect(abe.matches(end('AWAITING_PUSH', { outcome: 'unproven', commitCount: 1, localHeadSha: null, proof: { holds: false, reason: 'local_head_unknown' } }), next, null)).toBe(false);
    expect(abe.matches(end('AWAITING_PUSH', { outcome: 'success', commitCount: 0, localHeadSha: 'L', proof: { holds: false, reason: 'live_head_missing_local' } }), next, null)).toBe(false);
    expect(abe.matches(parked, end('ESCALATED', { proof: { holds: true } }), null)).toBe(false);
    // The match is not a tolerance: the decisions still differ.
    expect(clean(parked, next).div).not.toBeNull();

    const head = (from: string, to: string, effects: StepDecision['effects'] = []) => dec({ command: 'HeadObserved', fromState: from, toState: to, idempotencyKey: 'head:r#1:A->B@v9' }, effects);
    const rearmed = head('ESCALATED', 'AWAITING_REVIEW', [{ kind: 'dispatch_review', dedupeKey: 'dispatch_review:d:9', payload: {} }]);
    expect(budget.matches(rearmed, head('ESCALATED', 'ESCALATED'), { state: 'ESCALATED', stateReason: 'review_exhausted' })).toBe(true);
    // Only a spent review budget; another escalation re-reviews a push as before.
    expect(budget.matches(rearmed, head('ESCALATED', 'ESCALATED'), { state: 'ESCALATED', stateReason: 'review_unavailable' })).toBe(false);
    expect(budget.matches(rearmed, head('ESCALATED', 'ESCALATED', [{ kind: 'dispatch_review', dedupeKey: 'dispatch_review:d:9', payload: {} }]), { state: 'ESCALATED', stateReason: 'review_exhausted' })).toBe(false);
  });

  test('#4189: only the anonymous forced review request is a retired input', () => {
    const [force] = RETIRED_INPUTS;
    expect(force.matches({ command: 'ReviewRequested', actor: 'force', bypass: { forced: true, actor: 'force' } })).toBe(true);
    expect(force.matches({ command: 'ReviewRequested', actor: 'human:user-1', bypass: { forced: true, actor: 'human:user-1' } })).toBe(false);
    expect(force.matches({ command: 'ReviewRequested', actor: 'force', bypass: null })).toBe(false);
    expect(force.matches({ command: 'HumanResolve', actor: 'force', bypass: { forced: true } })).toBe(false);
  });

  test('remapIds swaps replay ids back to recorded ones at any depth', () => {
    expect(remapIds({ k: 'render:R1:3', n: ['R1'] }, new Map([['R1', 'D1']]))).toEqual({ k: 'render:D1:3', n: ['D1'] });
  });
});

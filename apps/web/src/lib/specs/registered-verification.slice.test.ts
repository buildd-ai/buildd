import { describe, expect, it } from 'bun:test';
import {
  MAX_REGISTERED_SURFACES, dispatchRegisteredVerification, registeredAuthor,
  type CollectedSurface, type Collection, type Execution, type RegisteredRun, type RegisteredSubject, type RegisteredVerificationDeps,
} from './registered-verification';

/**
 * The coordinator's own rules, with its store stubbed. What the store decides
 * (lineage, revisions, reservations, recording) is proven against real
 * Postgres in apps/web/tests/db/registered-verification-store.test.ts.
 */

const HEAD = 'a'.repeat(40);
const binding = (id: string, mode = 'required') => JSON.stringify({ id, version: 1, profile: 'buildd.enterprise@1', mode });
const subject = (body = `R-1: Actions agree with state.\n verify: ${binding('ui.actions_match_state')}`): RegisteredSubject => ({
  kind: 'task', taskId: 'subject', subjectId: 'subject', workspaceId: 'workspace', teamId: 'team', specRevisionId: 'revision',
  headSha: HEAD, body, criterionIds: ['R-1', 'AC-1'], criterionHashes: new Map([['R-1', 'words']]),
});
const shot = (n: number): CollectedSurface => ({
  input: { n }, ref: `art-${n}:hash`, fingerprint: `fp-${n}`, provenance: { artifactId: `art-${n}`, revision: 1, auditTaskId: 'audit', captureSha: HEAD },
});
const exec = (verdict: Execution['result']['verdict'], method: Execution['method']): Execution => ({
  result: { verdict, observed: verdict } as Execution['result'], method, inputFingerprint: 'x', decisionRecordIds: method === 'model' ? ['d'] : [], receipts: [],
});

function harness(over: Partial<{ s: RegisteredSubject; collection: Collection; verdicts: Execution[] }> = {}) {
  const writes: RegisteredRun[] = [];
  const calls: unknown[] = [];
  const released: string[] = [];
  let verdicts = over.verdicts ?? [];
  const deps: RegisteredVerificationDeps = {
    load: async () => over.s ?? subject(),
    collect: async () => over.collection ?? { admitted: [shot(1)], refused: [] },
    evaluator: async (id) => ({ key: `${id}-v1`, cacheable: id === 'ui.actions_match_state' }),
    cached: async () => null,
    reserve: async () => ({ owner: 'me', recovered: false }),
    release: async (_s, key) => { released.push(key); },
    execute: async (id, input) => { calls.push({ id, input }); return verdicts.shift() ?? exec('pass', id === 'ui.card_clarity' ? 'model' : 'deterministic'); },
    record: async (_s, run) => { writes.push(run); return { ok: true, verdictId: 'v' }; },
  };
  return { deps, writes, calls, released, setVerdicts: (v: Execution[]) => { verdicts = v; } };
}
const run = (deps: RegisteredVerificationDeps, evidenceRef?: string) => dispatchRegisteredVerification({ taskId: 'subject', headSha: HEAD, ...(evidenceRef ? { evidenceRef } : {}) }, deps);

describe('registered verification coordinator', () => {
  it('judges every admitted capture: one failing surface fails the binding', async () => {
    const h = harness({ collection: { admitted: [shot(1), shot(2), shot(3)], refused: [] }, verdicts: [exec('pass', 'deterministic'), exec('fail', 'deterministic'), exec('pass', 'deterministic')] });
    const r = await run(h.deps);
    expect(h.calls).toHaveLength(3);
    expect(r.results).toEqual([{ criterionId: 'R-1', bindingId: 'ui.actions_match_state', verdict: 'fail', method: 'deterministic', cached: false, recorded: true }]);
    expect(h.writes[0]).toMatchObject({ recordedBy: 'check:registered:ui.actions_match_state', evidenceRefs: ['art-1:hash', 'art-2:hash', 'art-3:hash'] });
    expect(h.released).toEqual([h.writes[0]!.runKey]);
  });

  it('a surface its verifier could not judge makes the whole run a fallback, authored as a review', async () => {
    const h = harness({ collection: { admitted: [shot(1), shot(2)], refused: [] }, verdicts: [exec('pass', 'deterministic'), exec('inconclusive', 'fallback')] });
    const r = await run(h.deps);
    expect(r.results[0]).toMatchObject({ verdict: 'inconclusive', method: 'fallback', recorded: true });
    expect(h.writes[0]).toMatchObject({ method: 'fallback', recordedBy: 'registered:ui.actions_match_state' });
    expect(registeredAuthor('ui.card_clarity', 'model')).toBe('registered:ui.card_clarity');
    expect(registeredAuthor('ui.card_clarity', 'deterministic')).toBe('registered:ui.card_clarity');
  });

  it('capture order does not change identity; a different capture set does', async () => {
    const a = harness({ collection: { admitted: [shot(1), shot(2)], refused: [] } });
    const b = harness({ collection: { admitted: [shot(2), shot(1)], refused: [] } });
    const c = harness({ collection: { admitted: [shot(1)], refused: [] } });
    await run(a.deps); await run(b.deps); await run(c.deps);
    expect(a.writes[0]!.runKey).toBe(b.writes[0]!.runKey);
    expect(a.writes[0]!.runKey).not.toBe(c.writes[0]!.runKey);
  });

  it('a binding change, a policy change or a wording change is a new identity', async () => {
    const base = harness(); await run(base.deps);
    const advisory = harness({ s: subject(`R-1: Actions agree with state.\n verify: ${binding('ui.actions_match_state', 'advisory')}`) }); await run(advisory.deps);
    const reworded = harness({ s: { ...subject(), criterionHashes: new Map([['R-1', 'other words']]) } }); await run(reworded.deps);
    const keys = [base, advisory, reworded].map((h) => h.writes[0]!.runKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('refused, missing and too many captures execute nothing and record nothing', async () => {
    const named = harness({ collection: { admitted: [shot(1)], refused: [{ ref: 'forged', reason: 'cross_workspace' }] } });
    const r = await run(named.deps, 'forged');
    expect(r.refused).toEqual([{ ref: 'forged', reason: 'cross_workspace' }]);
    expect(r.results[0]).toMatchObject({ verdict: 'inconclusive', recorded: false });

    const none = harness({ collection: { admitted: [], refused: [] } });
    expect((await run(none.deps)).results[0]).toMatchObject({ verdict: 'inconclusive', recorded: false, reason: expect.stringContaining('no independent capture') });

    const many = harness({ collection: { admitted: Array.from({ length: MAX_REGISTERED_SURFACES + 1 }, (_, i) => shot(i)), refused: [] } });
    expect((await run(many.deps)).results[0]).toMatchObject({ verdict: 'inconclusive', recorded: false });

    const unreachable = harness({ collection: { admitted: [], refused: [], error: 'GitHub could not be reached' } });
    expect((await run(unreachable.deps)).reason).toContain('GitHub');
    for (const h of [named, none, many, unreachable]) { expect(h.calls).toEqual([]); expect(h.writes).toEqual([]); }
  });

  it('a stale head, an unknown subject or an invalid binding records nothing', async () => {
    const h = harness();
    expect((await dispatchRegisteredVerification({ taskId: 'subject', headSha: 'b'.repeat(40) }, h.deps)).reason).toContain('no longer current');
    expect((await dispatchRegisteredVerification({ taskId: 'subject', headSha: 'short' }, h.deps)).reason).toContain('full commit SHA');
    const gone = harness(); gone.deps.load = async () => ({ error: 'task not found' });
    expect((await run(gone.deps)).reason).toBe('task not found');
    const invalid = harness({ s: subject('R-1: Actions.\n verify: {"id":"ui.unknown"}') });
    expect((await run(invalid.deps)).reason).toContain('invalid verifier binding');
    for (const x of [h, gone, invalid]) expect(x.calls).toEqual([]);
  });

  it('runs only in-scope criteria and reports declaration coverage, not a verdict, for the rest', async () => {
    const h = harness({ s: { ...subject(`R-1: Actions.\n verify: ${binding('ui.actions_match_state')}\nAC-1: No check.\nR-2: Not in scope.\n verify: ${binding('ui.card_clarity')}`) } });
    const r = await run(h.deps);
    expect(r.results.map((x) => x.criterionId)).toEqual(['R-1']);
    expect(r.coverage.map((c) => [c.criterionId, c.status])).toEqual([['R-1', 'declared'], ['AC-1', 'missing']]);
  });

  it('a held reservation or a provider failure records nothing and always releases', async () => {
    const held = harness(); held.deps.reserve = async () => null;
    expect((await run(held.deps)).results[0]).toMatchObject({ recorded: false, reason: expect.stringContaining('already running') });
    expect(held.calls).toEqual([]);
    const broken = harness(); broken.deps.execute = async () => { throw new Error('budget exhausted'); };
    expect((await run(broken.deps)).results[0]).toMatchObject({ verdict: 'inconclusive', recorded: false, reason: expect.stringContaining('budget exhausted') });
    expect(broken.writes).toEqual([]);
    expect(broken.released).toHaveLength(1);
    const refusedWrite = harness(); refusedWrite.deps.record = async () => ({ ok: false, reason: 'the verification target moved while it ran' });
    expect((await run(refusedWrite.deps)).results[0]).toMatchObject({ verdict: 'inconclusive', recorded: false, reason: 'the verification target moved while it ran' });
  });

  it('a deterministic hit replays without executing, and re-records only when a newer row superseded it; a model is never served from cache', async () => {
    const stored = { verdict: 'pass', method: 'deterministic' } as RegisteredRun;
    const current = harness(); current.deps.cached = async () => ({ verdictId: 'old', run: stored, current: true });
    expect((await run(current.deps)).results[0]).toMatchObject({ verdict: 'pass', cached: true, recorded: true });
    expect(current.calls).toEqual([]); expect(current.writes).toEqual([]);
    const superseded = harness(); superseded.deps.cached = async () => ({ verdictId: 'old', run: stored, current: false });
    await run(superseded.deps);
    expect(superseded.calls).toEqual([]); expect(superseded.writes[0]).toMatchObject({ replayOf: 'old', verdict: 'pass' });

    const model = harness({ s: subject(`R-1: Clear.\n verify: ${binding('ui.card_clarity')}`) });
    let looked = 0; model.deps.cached = async () => { looked++; return { verdictId: 'old', run: { ...stored, method: 'model' }, current: true }; };
    await run(model.deps); await run(model.deps);
    expect(looked).toBe(0);
    expect(model.calls).toHaveLength(2);
    expect(model.writes.map((w) => w.recordedBy)).toEqual(['registered:ui.card_clarity', 'registered:ui.card_clarity']);
  });
});

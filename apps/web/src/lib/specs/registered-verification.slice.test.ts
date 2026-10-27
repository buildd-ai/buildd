import { describe, expect, it } from 'bun:test';
import { bindingFingerprint } from '@buildd/spec-contract/verification-bindings';
import {
  MAX_REGISTERED_SURFACES, dispatchRegisteredVerification, registeredAuthor, planRegisteredChecks, REGISTERED_VERIFIER_REGISTRY,
  type CollectedSurface, type Collection, type Execution, type RegisteredRun, type RegisteredSubject, type RegisteredVerificationDeps,
} from './registered-verification';

/**
 * The coordinator's own rules, with its store stubbed. What the store decides
 * (lineage, revisions, reservations, recording) is proven against real
 * Postgres in apps/web/tests/db/registered-verification-store.test.ts.
 */

const HEAD = 'a'.repeat(40);
const json = (id: string, mode = 'required') => JSON.stringify({ id, version: 1, profile: 'buildd.enterprise@1', mode });
/** A `verify:` value and, on the next line, the one capture it needs. */
const binding = (id: string, mode = 'required') => `${json(id, mode)}\n scenarios: card@mobile`;
const subject = (body = `R-1: Actions agree with state.\n verify: ${binding('ui.actions_match_state')}`): RegisteredSubject => ({
  kind: 'task', taskId: 'subject', subjectId: 'subject', workspaceId: 'workspace', teamId: 'team', specRevisionId: 'revision',
  headSha: HEAD, body, criterionIds: ['R-1', 'AC-1'], criterionHashes: new Map([['R-1', 'words']]),
});
const shot = (n: number): CollectedSurface => ({
  input: { n }, ref: `art-${n}:hash`, fingerprint: `fp-${n}`, provenance: { artifactId: `art-${n}`, revision: 1, auditTaskId: 'audit', captureSha: HEAD },
  scenario: { scenarioId: 'card', viewport: 'mobile' },
});
const shotOf = (n: number, scenarioId: string, viewport: 'mobile' | 'desktop'): CollectedSurface => ({ ...shot(n), scenario: { scenarioId, viewport } });
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
const run = (deps: RegisteredVerificationDeps, evidenceRef?: string, trigger?: 'request' | 'event') =>
  dispatchRegisteredVerification({ taskId: 'subject', headSha: HEAD, ...(evidenceRef ? { evidenceRef } : {}), ...(trigger ? { trigger } : {}) }, deps);

describe('registered verification coordinator', () => {
  it('uses the canonical planner identity for key=value and legacy JSON through the production coordinator', async () => {
    const body = 'R-1: Actions agree with state.\n verify: verifier=ui.action-state@1 profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions,ui.state\n scenarios: card@mobile';
    const canonical = harness({ s: subject(body) });
    const legacy = harness();
    await run(canonical.deps); await run(legacy.deps);
    const [planned] = planRegisteredChecks({ subject: { kind: 'task', taskId: 'subject' }, workspaceId: 'workspace', specRevisionId: 'revision', body, target: { headSha: HEAD }, registry: REGISTERED_VERIFIER_REGISTRY });
    expect(canonical.writes[0]!.bindingFingerprint).toBe(bindingFingerprint(planned!.binding));
    expect(canonical.writes[0]!.runKey).toBe(legacy.writes[0]!.runKey);
    expect(canonical.writes[0]!.verdict).toBe('pass');
  });

  it('never certifies additional evidence the selected verifier does not inspect', async () => {
    const body = 'R-1: The image is correct.\n verify: verifier=ui.copy@1 profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions,ui.pixels\n scenarios: card@mobile';
    const h = harness({ s: subject(body) });
    const r = await run(h.deps);
    expect(r.results[0]).toMatchObject({ verdict: 'unsupported', recorded: false });
    expect(r.results[0]!.reason).toContain('ui.pixels');
    expect(h.calls).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('judges every admitted capture: one failing surface fails the binding', async () => {
    const h = harness({ collection: { admitted: [shot(1), shot(2), shot(3)], refused: [] }, verdicts: [exec('pass', 'deterministic'), exec('fail', 'deterministic'), exec('pass', 'deterministic')] });
    const r = await run(h.deps);
    expect(h.calls).toHaveLength(3);
    expect(r.results).toEqual([{ criterionId: 'R-1', bindingId: 'ui.actions_match_state', verdict: 'fail', method: 'deterministic', cached: false, recorded: true }]);
    // A registered result is a review whatever its method; the method is kept beside it.
    expect(h.writes[0]).toMatchObject({ recordedBy: 'registered:ui.actions_match_state', method: 'deterministic', evidenceRefs: ['art-1:hash', 'art-2:hash', 'art-3:hash'] });
    expect(h.released).toEqual([h.writes[0]!.runKey]);
  });

  it('a model binding with no model answer records nothing and keeps the standing result', async () => {
    const h = harness({ s: subject(`R-1: Clear.\n verify: ${binding('ui.card_clarity')}`), verdicts: [exec('inconclusive', 'fallback')] });
    const r = await run(h.deps);
    expect(r.results[0]).toMatchObject({ verdict: 'inconclusive', method: 'fallback', recorded: false, reason: expect.stringContaining('no result') });
    expect(h.writes).toEqual([]);
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
    const first = harness(); await run(first.deps);
    const stored = first.writes[0]!;
    expect(stored.plan).toMatchObject({ verifier: { id: 'ui.action-state', version: 1 }, profile: { id: 'buildd-ui', version: 1 }, subject: { kind: 'task', taskId: 'subject' } });
    const current = harness(); current.deps.cached = async () => ({ verdictId: 'old', run: stored, current: true });
    expect((await run(current.deps)).results[0]).toMatchObject({ verdict: 'pass', cached: true, recorded: true });
    expect(current.calls).toEqual([]); expect(current.writes).toEqual([]);
    const superseded = harness(); superseded.deps.cached = async () => ({ verdictId: 'old', run: stored, current: false });
    await run(superseded.deps);
    expect(superseded.calls).toEqual([]); expect(superseded.writes[0]).toMatchObject({ replayOf: 'old', verdict: 'pass' });

    // reusablePass decides a pass replay: a run recorded for another planned run, on other evidence, or before
    // runs carried their plan, is executed again rather than replayed.
    for (const other of [{ ...stored, plan: { ...stored.plan!, key: 'another-run' } }, { ...stored, inputFingerprint: 'other-evidence' }, { ...stored, plan: undefined }]) {
      const h = harness(); h.deps.cached = async () => ({ verdictId: 'old', run: other, current: true });
      expect((await run(h.deps)).results[0]).toMatchObject({ verdict: 'pass', cached: false, recorded: true });
      expect(h.calls).toHaveLength(1);
    }

    const model = harness({ s: subject(`R-1: Clear.\n verify: ${binding('ui.card_clarity')}`) });
    let looked = 0; model.deps.cached = async () => { looked++; return { verdictId: 'old', run: { ...stored, method: 'model' }, current: true }; };
    await run(model.deps); await run(model.deps);
    expect(looked).toBe(0);
    expect(model.calls).toHaveLength(2);
    expect(model.writes.map((w) => w.recordedBy)).toEqual(['registered:ui.card_clarity', 'registered:ui.card_clarity']);
  });

  it('R-16: a pass over part of the declared captures certifies nothing; a failing capture still fails; a model is not asked about part', async () => {
    const two = (id: string) => subject(`R-1: Cards.\n verify: ${json(id)}\n scenarios: card@mobile, card@desktop`);
    const partial = harness({ s: two('ui.actions_match_state'), collection: { admitted: [shotOf(1, 'card', 'mobile'), shotOf(2, 'other', 'desktop')], refused: [] } });
    const r = await run(partial.deps);
    expect(r.results[0]).toMatchObject({ verdict: 'inconclusive', recorded: false, reason: expect.stringContaining('card@desktop') });
    // Only the declared capture was judged: an unrelated scenario neither passes nor fails this criterion.
    expect(partial.calls).toEqual([{ id: 'ui.actions_match_state', input: { n: 1 } }]);
    expect(partial.writes).toEqual([]);

    const failing = harness({ s: two('ui.actions_match_state'), collection: { admitted: [shotOf(1, 'card', 'mobile')], refused: [] }, verdicts: [exec('fail', 'deterministic')] });
    expect((await run(failing.deps)).results[0]).toMatchObject({ verdict: 'fail', recorded: true });
    expect(failing.writes[0]).toMatchObject({ scenarios: ['card@mobile', 'card@desktop'], missing: ['card@desktop'] });

    const model = harness({ s: two('ui.card_clarity'), collection: { admitted: [shotOf(1, 'card', 'mobile')], refused: [] } });
    expect((await run(model.deps)).results[0]).toMatchObject({ verdict: 'inconclusive', recorded: false, reason: expect.stringContaining('card@desktop') });
    expect(model.calls).toEqual([]);

    const complete = harness({ s: two('ui.actions_match_state'), collection: { admitted: [shotOf(1, 'card', 'mobile'), shotOf(2, 'card', 'desktop')], refused: [] } });
    expect((await run(complete.deps)).results[0]).toMatchObject({ verdict: 'pass', recorded: true });
    expect(complete.writes[0]).toMatchObject({ scenarios: ['card@mobile', 'card@desktop'] });
    expect(complete.writes[0]!.missing).toBeUndefined();

    const none = harness({ s: two('ui.actions_match_state'), collection: { admitted: [shotOf(1, 'other', 'mobile')], refused: [] } });
    expect((await run(none.deps)).results[0]).toMatchObject({ verdict: 'inconclusive', recorded: false, reason: expect.stringContaining('card@mobile, card@desktop') });
    expect(none.calls).toEqual([]);
  });

  it('R-16: a binding with no declared captures (an older revision) never certifies a pass', async () => {
    const h = harness({ s: subject(`R-1: Cards.\n verify: ${json('ui.actions_match_state')}`) });
    expect((await run(h.deps)).results[0]).toMatchObject({ verdict: 'inconclusive', recorded: false, reason: expect.stringContaining('declares no scenarios') });
    const f = harness({ s: subject(`R-1: Cards.\n verify: ${json('ui.actions_match_state')}`), verdicts: [exec('fail', 'deterministic')] });
    expect((await run(f.deps)).results[0]).toMatchObject({ verdict: 'fail', recorded: true });
  });

  it('R-4: the declared captures are part of the run identity', async () => {
    const one = harness(); await run(one.deps);
    const wider = harness({ s: subject(`R-1: Cards.\n verify: ${json('ui.actions_match_state')}\n scenarios: card@mobile, other@desktop`),
      collection: { admitted: [shot(1), shotOf(2, 'other', 'desktop')], refused: [] } });
    await run(wider.deps);
    expect(one.writes[0]!.runKey).not.toBe(wider.writes[0]!.runKey);
  });

  it('R-6: an automatic trigger does not re-ask a model whose identical run is the standing row; a request does', async () => {
    const clarity = subject(`R-1: Clear.\n verify: ${binding('ui.card_clarity')}`);
    const standing = { verdict: 'pass', method: 'model' } as RegisteredRun;
    const event = harness({ s: clarity }); event.deps.cached = async () => ({ verdictId: 'old', run: standing, current: true });
    expect((await run(event.deps, undefined, 'event')).results[0]).toMatchObject({ verdict: 'pass', cached: true, recorded: false });
    expect(event.calls).toEqual([]); expect(event.writes).toEqual([]);

    // Superseded by a newer row, or never recorded: the event runs it.
    const superseded = harness({ s: clarity }); superseded.deps.cached = async () => ({ verdictId: 'old', run: standing, current: false });
    await run(superseded.deps, undefined, 'event');
    expect(superseded.calls).toHaveLength(1);

    const asked = harness({ s: clarity }); asked.deps.cached = async () => ({ verdictId: 'old', run: standing, current: true });
    await run(asked.deps, undefined, 'request');
    expect(asked.calls).toHaveLength(1);
  });

  it('a body with no verify binding is untouched: nothing is collected, nothing runs', async () => {
    const h = harness({ s: subject('R-1: Plain.\n check: bun test') });
    let collected = 0; h.deps.collect = async () => { collected++; return { admitted: [shot(1)], refused: [] }; };
    const r = await run(h.deps, undefined, 'event');
    expect(r.results).toEqual([]);
    expect(collected).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

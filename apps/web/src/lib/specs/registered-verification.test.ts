import { describe, expect, it } from 'bun:test';
import { dispatchRegisteredVerification, type RegisteredVerificationDeps, type RegisteredSubject } from './registered-verification';

const HEAD = 'a'.repeat(40);
const binding = { id: 'ui.actions_match_state', version: 1, profile: 'buildd.enterprise@1', mode: 'required' };
const subject: RegisteredSubject = {
  taskId: 'subject', workspaceId: 'workspace', teamId: 'team', specRevisionId: 'revision',
  headSha: HEAD, body: `R-1: Actions agree with state.\n verify: ${JSON.stringify(binding)}`,
  criterionIds: ['R-1'], criterionHashes: new Map([['R-1', 'words']]),
};
const evidence = () => ({ input: { subject: { commitSha: HEAD }, facts: { prState: 'closed' } },
  workspaceId: 'workspace', subjectTaskId: 'subject', independent: true, captureSha: HEAD, ref: 'shot' });
function harness() {
  const writes: any[] = []; const calls: any[] = []; const cache = new Map();
  let current = subject; let captured: any = evidence(); let policy = 'policy-v1';
  const deps: RegisteredVerificationDeps = {
    load: async () => current, collect: async () => captured ? [captured] : [],
    evaluator: async () => ({ key: policy, cacheable: true }),
    reserve: async key => { if (cache.has(key)) return false; cache.set(key, null); return true; },
    cached: async key => cache.get(key) ?? null,
    execute: async (id, input) => { calls.push({ id, input }); return { result: { verdict: 'pass', observed: 'Consistent.' } as any,
      method: id === 'ui.card_clarity' ? 'model' : 'deterministic', inputFingerprint: 'executor-input', decisionRecordIds: ['decision'], receipts: [] }; },
    record: async (_s, item) => { writes.push(item); cache.set(item.runKey, item); return true; },
  };
  return { deps, writes, calls, setSubject: (s: RegisteredSubject) => current = s,
    setEvidence: (e: any) => captured = e, setPolicy: (p: string) => policy = p };
}
describe('registered requirement coordinator', () => {
  it('AC-5: automatic and explicit requests share exact-input caching and criterion-linked evidence', async () => {
    const h = harness();
    await dispatchRegisteredVerification({ taskId: 'subject', headSha: HEAD }, h.deps);
    const replay = await dispatchRegisteredVerification({ taskId: 'subject', headSha: HEAD, evidenceRef: 'shot' }, h.deps);
    expect(h.calls).toHaveLength(1); expect(replay.results[0]?.cached).toBe(true);
    expect(h.writes[0]).toMatchObject({ criterionId: 'R-1', headSha: HEAD, method: 'deterministic', recordedBy: 'check:registered:ui.actions_match_state', verdict: 'pass' });
    expect(h.writes[0].bindingFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('AC-5: a changed capture, runtime fact, policy, binding or head cannot replay an earlier pass', async () => {
    const h = harness(); const run = () => dispatchRegisteredVerification({ taskId: 'subject', headSha: HEAD }, h.deps);
    await run(); h.setEvidence({ ...evidence(), input: { ...evidence().input, facts: { prState: 'merged' } } }); await run();
    h.setPolicy('policy-v2'); await run();
    h.setSubject({ ...subject, body: subject.body.replace('required', 'advisory') }); await run();
    expect(h.calls).toHaveLength(4);
    const stale = await dispatchRegisteredVerification({ taskId: 'subject', headSha: 'b'.repeat(40) }, h.deps);
    expect(stale.results).toEqual([]); expect(stale.reason).toContain('target');
  });
  it.each(['independent', 'workspaceId', 'subjectTaskId', 'captureSha'])('AC-2: refuses forged or stale %s before executing', async key => {
    const h = harness(); h.setEvidence({ ...evidence(), [key]: key === 'independent' ? false : 'foreign' });
    const result = await dispatchRegisteredVerification({ taskId: 'subject', headSha: HEAD }, h.deps);
    expect(h.calls).toHaveLength(0); expect(result.results[0]?.verdict).toBe('inconclusive');
  });
  it('AC-2: preserves model provenance and routes final mission subjects through the same executor', async () => {
    const h = harness(); h.setSubject({ ...subject, missionId: 'mission', body: subject.body.replace('ui.actions_match_state', 'ui.card_clarity') });
    await dispatchRegisteredVerification({ taskId: 'subject', headSha: HEAD }, h.deps);
    expect(h.calls).toHaveLength(1); expect(h.writes[0]).toMatchObject({ method: 'model', recordedBy: 'registered:ui.card_clarity', decisionRecordIds: ['decision'] });
  });
  it('AC-4: absent evidence and provider failures stay explicit and cannot pass', async () => {
    const h = harness(); h.setEvidence(null);
    expect((await dispatchRegisteredVerification({ taskId: 'subject', headSha: HEAD }, h.deps)).results[0]?.verdict).toBe('inconclusive');
    h.setEvidence(evidence()); h.deps.execute = async () => { throw new Error('budget exhausted'); };
    expect((await dispatchRegisteredVerification({ taskId: 'subject', headSha: HEAD }, h.deps)).results[0]?.verdict).toBe('inconclusive');
  });
  it('AC-5: concurrent identical requests reserve only one provider execution', async () => {
    const h = harness(); await Promise.all([1, 2].map(() => dispatchRegisteredVerification({ taskId: 'subject', headSha: HEAD }, h.deps)));
    expect(h.calls).toHaveLength(1);
  });
  it('does not run criteria outside the selected scope or hide missing declaration coverage', async () => {
    const h = harness(); h.setSubject({ ...subject, body: subject.body + '\nAC-1: Missing check.', criterionIds: ['AC-1'] });
    const result = await dispatchRegisteredVerification({ taskId: 'subject', headSha: HEAD }, h.deps);
    expect(h.calls).toHaveLength(0); expect(result.coverage).toEqual([{ criterionId: 'AC-1', command: false, visual: false, registered: false, status: 'missing' }]);
  });
});

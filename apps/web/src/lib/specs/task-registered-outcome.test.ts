import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { criterionVerifications } from '@buildd/spec-contract/verification-bindings';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const pin = { specId: 'spec', specRevisionId: 'revision', contentHash: 'hash' };
const task = { id: 'task', workspaceId: 'workspace', parentTaskId: null, context: { specSource: pin } };
let body: string;
let rows: any[];
mock.module('@buildd/core/db', () => ({ db: { select: () => {
  const q = { from: () => q, where: () => q, orderBy: async () => rows, limit: async () => [task] };
  return q;
} } }));
mock.module('@/lib/uuid', () => ({ isUuid: () => true }));
mock.module('@/lib/workflow/delivery-view', () => ({ getDeliveryViewsForTasks: async () => new Map([['task', { headSha: HEAD }]]) }));
const read = () => ({ ok: true, body, specId: 'spec', revision: 1 });
mock.module('./pin', () => ({ readPinnedSpecRevision: async () => read(), readPinnedSpecRevisions: async () => new Map([['pin', read()]]), pinnedReadOf: (reads: Map<string, unknown>) => reads.get('pin') }));
mock.module('./store', () => ({ fail: (status: number, error: string) => ({ ok: false, status, error }), reach: async () => true }));
mock.module('./criteria', () => ({ criterionHashes: () => new Map([['R-1', 'wording-hash']]) }));
mock.module('./verdict-source', () => ({ settleVerdictSource: async () => {} }));
const { readGovernedOutcome, governedOutcomesFor } = await import('./outcome');
const declared = (mode = 'required') => `R-1: Clear cards.\n verify: {"id":"ui.card_clarity","version":1,"profile":"buildd.enterprise@1","mode":"${mode}"}`;
const row = (verdict: string, extra: Record<string, unknown> = {}) => ({ taskId: 'task', specRevisionId: 'revision', criterionId: 'R-1', verdict, headSha: HEAD, at: new Date('2026-10-21T12:00:00Z'), textHash: 'wording-hash', evidence: { recordedBy: 'registered:ui.card_clarity', bindingFingerprint: criterionVerifications(body)[0].fingerprint }, ...extra });
const command = (verdict = 'pass') => row(verdict, { evidence: { recordedBy: 'check:command' } });
async function both() {
  const single = await readGovernedOutcome(null, 'task');
  if (!single.ok) throw new Error(single.error);
  const batch = (await governedOutcomesFor([task], new Map([['task', HEAD]]), rows)).get('task')!;
  expect(batch).toEqual(single.outcome);
  return single.outcome;
}
beforeEach(() => { body = declared(); rows = []; });

describe('registered task outcome single and batch reads', () => {
  it('required model failure participates beside a passing command without changing source', async () => {
    rows = [command(), row('fail')];
    const result = await both();
    expect(result.outcome).toBe('fail');
    expect(result.criteria[0]).toMatchObject({ verdict: 'fail', source: 'review' });
  });
  it.each(['inconclusive', 'unsupported'])('required %s remains unverified', async verdict => {
    rows = [command(), row(verdict)];
    expect((await both()).outcome).toBe('unverified');
  });
  it('required missing or old-fingerprint evidence cannot be replaced by a command pass', async () => {
    rows = [command()]; expect((await both()).outcome).toBe('unverified');
    rows.push(row('pass', { evidence: { recordedBy: 'registered:ui.card_clarity', bindingFingerprint: 'old-binding' } }));
    expect((await both()).outcome).toBe('unverified');
  });
  it.each(['pass', 'fail'])('a registered %s at an older target needs verification again', async verdict => {
    rows = [row(verdict, { headSha: OLD })];
    expect((await both()).outcome).toBe('unverified');
  });
  it('a current required model pass can verify while staying a review', async () => {
    rows = [row('pass')];
    const result = await both();
    expect(result.outcome).toBe('verified'); expect(result.criteria[0].source).toBe('review');
  });
  it('advisory deterministic failures do not replace legacy command authority', async () => {
    body = declared('advisory');
    rows = [command(), row('fail', { evidence: { recordedBy: 'check:registered:ui.card_clarity', bindingFingerprint: criterionVerifications(body)[0].fingerprint } })];
    expect((await both()).outcome).toBe('verified');
  });
  it('a deterministic registered pass cannot override a command failure', async () => {
    rows = [command('fail'), row('pass', { at: new Date('2026-10-21T13:00:00Z'), evidence: { recordedBy: 'check:registered:ui.card_clarity', bindingFingerprint: criterionVerifications(body)[0].fingerprint } })];
    expect((await both()).outcome).toBe('fail');
  });
});

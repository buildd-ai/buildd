import { expect, it } from 'bun:test';
import { runLocalCheck, readStagedChanges } from './cli';
import bad from './negative.json';
import good from './positive.json';

it('same local command reports bad copy with repair then passing corrected copy', async () => {
  const result = await runLocalCheck(bad, 'commit');
  expect(result.exitCode).toBe(1);
  expect(result.findings.some(f => f.reasonCode === 'redundant-sort-narration')).toBe(true);
  expect(result.findings.some(f => f.suggestedCorrection === 'Scheduled')).toBe(true);
  expect((await runLocalCheck(good, 'commit')).exitCode).toBe(0);
  expect((await runLocalCheck(bad, 'agent')).exitCode).toBe(0);
  expect(result.coverage.agentHook).toBe('not integrated');
  expect(result.coverage.preCommitHook).toBe('not integrated');
  expect(result.model.decisions).toBe(0);
});

it('reads staged blobs rather than unstaged worktree content, with argument-safe paths', () => {
  const calls: string[][] = [];
  const result = readStagedChanges(args => {
    calls.push(args);
    if (args.includes('--name-only')) return 'src/Mission section.tsx\0';
    if (args[0] === 'show') return args[1].startsWith('HEAD:') ? '<p>Before</p>' : '<p>After</p>';
    return '@@ -1 +1 @@\n-<p>Before</p>\n+<p>After</p>';
  });
  expect(result[0].after).toBe('<p>After</p>');
  expect(calls).toContainEqual(['show', ':src/Mission section.tsx']);
  expect(calls[0]).toContain('--no-renames');
});

it('rejects ambiguous line-only context rather than applying a state to visible title props', async () => {
  await expect(runLocalCheck({ changes: [{ file: 'src/Status.tsx', before: '',
    after: '<span title="More information">Planning</span>',
    contexts: { '1': { role: 'status', state: { kind: 'waiting', value: 'start_deferred' }, source: 'fixture' } } }] }, 'commit')).rejects.toThrow('ambiguous');
  const result = await runLocalCheck({ changes: [{ file: 'src/Status.tsx', before: '',
    after: '<span title="More information">Planning</span>',
    contexts: { '1': { prop: 'children', role: 'status', state: { kind: 'waiting', value: 'start_deferred' }, source: 'fixture' } } }] }, 'commit');
  expect(result.findings.filter(f => f.reasonCode === 'state-label-mismatch').map(f => f.subject.prop)).toEqual(['children']);
});

it('rejects malformed supplied inputs instead of claiming no findings', async () => {
  await expect(runLocalCheck({ changes: [{ file: 'x.tsx' }] }, 'commit')).rejects.toThrow();
  await expect(runLocalCheck({ changes: [] }, 'invalid' as 'commit')).rejects.toThrow();
});

it('opt-in semantic execution reports model receipts but preserves deterministic enforcement', async () => {
  const result = await runLocalCheck(bad, 'commit', async () => ({ label: 'redundant', reasonCode: 'model_redundant',
    model: 'test-model', version: 'v1', promptFingerprint: 'p1', inputFingerprint: 'i1', confidence: 1,
    latencyMs: 15, costUsd: 0.001, attempts: 1, receipt: null }));
  expect(result.exitCode).toBe(1);
  // The unchanged heading also needs review when its neighboring changed copy changes.
  expect(result.model.decisions).toBe(2);
  expect(result.findings.find(f => f.evaluator === 'model-advisory')?.enforced).toBe(false);
});

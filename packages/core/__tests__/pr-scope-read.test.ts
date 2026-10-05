import { describe, it, expect } from 'bun:test';
import { readPinnedPrScope } from '../pr-scope-read';
const pr = (over = {}) => ({ state: 'closed', merged: true, head: { sha: 'head' }, base: { sha: 'base', ref: 'dev' }, changed_files: 1, ...over });
describe('outcome PR diff read', () => {
  it('reads a merged PR and unions both sides of renames', async () => {
    const result = await readPinnedPrScope(async path => path.includes('/files?') ? [{ filename: 'new.ts', previous_filename: 'old.ts' }] : pr(), { repoFullName: 'example/project', prNumber: 1, allowClosed: true });
    expect(result).toMatchObject({ status: 'complete', files: ['new.ts', 'old.ts'], headSha: 'head', baseSha: 'base' });
  });
  it('records a truncated file list rather than an empty diff', async () => {
    const result = await readPinnedPrScope(async path => path.includes('/files?') ? [] : pr(), { repoFullName: 'example/project', prNumber: 1, allowClosed: true });
    expect(result).toMatchObject({ status: 'incomplete', reason: 'truncated' });
  });
  it('rejects changed base revisions on closed PRs too', async () => {
    let reads = 0;
    const result = await readPinnedPrScope(async path => path.includes('/files?') ? [{ filename: 'new.ts' }] : pr({ base: { sha: ++reads === 1 ? 'base' : 'moved', ref: 'dev' } }), { repoFullName: 'example/project', prNumber: 1, allowClosed: true });
    expect(result).toMatchObject({ status: 'incomplete', reason: 'base_moved' });
  });
  it('refuses outcome reads without a changed-file count', async () => {
    const result = await readPinnedPrScope(async path => path.includes('/files?') ? [] : pr({ changed_files: undefined }), { repoFullName: 'example/project', prNumber: 1, allowClosed: true });
    expect(result).toMatchObject({ status: 'incomplete', reason: 'malformed' });
  });
  it('preserves reconciliation refusal of closed PRs by default', async () => {
    expect(await readPinnedPrScope(async () => pr(), { repoFullName: 'example/project', prNumber: 1 })).toMatchObject({ status: 'closed' });
  });
});

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { checkGeneratedSpecs } from './check-generated-specs';
import { renderRepoCopy } from '../packages/spec-contract/src/repo-copy';

// docs/specs/living-specs.md §18, R-16, AC-75.

async function copy() {
  const r = await renderRepoCopy({
    shortId: 'c0ffee12', revision: 2, title: 'Exports', body: '---\ntitle: Exports\nsummary: Exports MUST be complete.\n---\n# Exports\n\n- AC-1: GIVEN x WHEN y THEN z.\n',
    metadata: {}, domain: 'integrations', status: 'draft', defaultOwner: 'buildd', defaultLastVerified: '2026-10-13',
  });
  if (!r.ok) throw new Error(r.message);
  return r.text;
}

describe('check-generated-specs', () => {
  it('passes an unedited copy and ignores hand-written specs', async () => {
    const r = await checkGeneratedSpecs([
      { file: 'docs/specs/exports.md', text: await copy() },
      { file: 'docs/specs/other.md', text: '---\ntitle: Other\n---\n# Other\n' },
    ], 'https://buildd.dev');
    expect(r).toEqual({ generated: 1, findings: [] });
  });

  it('fails a hand edit to the body, naming the short id and printing its link', async () => {
    const text = (await copy()).replace('THEN z', 'THEN w');
    const r = await checkGeneratedSpecs([{ file: 'docs/specs/exports.md', text }], 'https://buildd.dev/');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.shortId).toBe('c0ffee12');
    expect(r.findings[0]!.message).toContain('edited in buildd');
    expect(r.findings[0]!.message).toContain('https://buildd.dev/app/specs/c0ffee12');
  });

  it('fails a hand edit to domain', async () => {
    const text = (await copy()).replace('domain: integrations', 'domain: tasks');
    const r = await checkGeneratedSpecs([{ file: 'docs/specs/exports.md', text }], 'https://buildd.dev');
    expect(r.findings[0]!.message).toContain('metadata block');
  });

  it('the repo as checked in passes (the CLI exits 0)', () => {
    const out = spawnSync('bun', ['run', join(import.meta.dir, 'check-generated-specs.ts')], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('generated spec copies:');
  });
});

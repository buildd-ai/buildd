/**
 * Acceptance tests for Living Specs "writing and approving a spec" revision 3,
 * "Retiring a spec" R-78 to R-80, written before the build. They name the seams
 * the build adds; each fails until they exist. Opening the PR and the SQL are
 * not asserted here: these pin what the PR contains, what the import plans and
 * what a restore does not do.
 *
 *   ./retire-file
 *     retirementFileChange({ importedPath, copyPath }) -> { kind: 'frontmatter' | 'remove', path } | null
 *     supersededFileText(text, supersededBy)           -> the file with status and superseded_by set
 *     afterRestore({ filePr, filePath })               -> { opensPr: false, note: string | null }
 *   ./import-retire
 *     planImportRetirements({ imported, files, commit, titles }) -> Retirement[]  (a plan; writes nothing)
 *     confirmedRetirements(plan, confirmedSpecIds)               -> the plan entries a person confirmed
 */
import { describe, expect, it } from 'bun:test';
import { repoSpecForImport } from '@buildd/spec-contract/repo-import';
import { parseSpecFrontmatter } from '@buildd/spec-contract/repo-spec';

const FILE = `---
title: Checkout
status: active
owner: someone
last_verified: 2026-10-01
summary: A checkout MUST total in the shopper's currency.
domain: payments
---

# Checkout

R-1: Totals are in the shopper's currency.
`;

describe('R-78: retiring a spec with a repo file opens one PR', () => {
  it('R-78: an imported source file gets frontmatter edits, a generated copy is removed, a spec with neither gets no PR', async () => {
    const { retirementFileChange } = await import('../../src/lib/specs/retire-file');
    expect(retirementFileChange({ importedPath: 'docs/specs/checkout.md', copyPath: null })).toEqual({ kind: 'frontmatter', path: 'docs/specs/checkout.md' });
    expect(retirementFileChange({ importedPath: null, copyPath: 'docs/specs/payments/checkout.md' })).toEqual({ kind: 'remove', path: 'docs/specs/payments/checkout.md' });
    expect(retirementFileChange({ importedPath: null, copyPath: null })).toBeNull();
  });

  it('R-78: the source-file edit sets status and superseded_by and leaves the body as it is', async () => {
    const { supersededFileText } = await import('../../src/lib/specs/retire-file');
    const next = supersededFileText(FILE, 'checkout-v2');
    const fm = parseSpecFrontmatter(next);
    expect(fm?.status).toBe('superseded');
    expect(fm?.superseded_by).toBe('checkout-v2');
    expect(fm?.title).toBe('Checkout');
    expect(next.slice(next.indexOf('# Checkout'))).toBe(FILE.slice(FILE.indexOf('# Checkout')));
  });
});

describe('AC-124: a superseded imported spec is marked in its file, and the next import skips it', () => {
  it('AC-124: the edited file reads as superseded to the next import, which skips it', async () => {
    const { supersededFileText } = await import('../../src/lib/specs/retire-file');
    const edited = supersededFileText(FILE, 'checkout-v2');
    expect(edited).not.toBe(FILE);
    const r = repoSpecForImport('docs/specs/checkout.md', edited);
    expect(r).toMatchObject({ ok: false, reason: 'superseded' });
  });
});

describe('R-79 and AC-125: an import lists removed or superseded files as retirements', () => {
  const imported = [
    { specId: 'spec-a', title: 'Checkout', path: 'docs/specs/checkout.md', status: 'approved' },
    { specId: 'spec-b', title: 'Refunds', path: 'docs/specs/refunds.md', status: 'approved' },
    { specId: 'spec-c', title: 'Old thing', path: 'docs/specs/old.md', status: 'retired' },
    { specId: 'spec-d', title: 'Kept', path: 'docs/specs/kept.md', status: 'approved' },
  ];
  const files = [
    { path: 'docs/specs/refunds.md', text: FILE.replace('title: Checkout', 'title: Refunds').replace('status: active', 'status: superseded\nsuperseded_by: checkout') },
    { path: 'docs/specs/kept.md', text: FILE.replace('title: Checkout', 'title: Kept') },
  ];
  const input = { imported, files, commit: 'abcdef0123456789abcdef0123456789abcdef01', titles: { checkout: 'spec-a' } as Record<string, string> };

  it('AC-125: a previously imported file deleted from the repo is listed under Retire with the commit', async () => {
    const { planImportRetirements } = await import('../../src/lib/specs/import-retire');
    const plan = planImportRetirements(input);
    const deleted = plan.find((p) => p.specId === 'spec-a');
    expect(deleted).toMatchObject({ action: 'retire', path: 'docs/specs/checkout.md', supersededBy: null });
    expect(deleted?.reason).toContain('file removed in abcdef0');
  });

  it('R-79: a file marked superseded is listed with its replacement when buildd can match it, else retired; retired and kept specs are not listed', async () => {
    const { planImportRetirements } = await import('../../src/lib/specs/import-retire');
    const plan = planImportRetirements(input);
    const marked = plan.find((p) => p.specId === 'spec-b');
    expect(marked).toMatchObject({ action: 'retire', supersededBy: 'spec-a' });
    expect(marked?.reason).toContain('marked superseded by');
    expect(plan.map((p) => p.specId).sort()).toEqual(['spec-a', 'spec-b']);
    const unmatched = planImportRetirements({ ...input, titles: {} }).find((p) => p.specId === 'spec-b');
    expect(unmatched?.supersededBy).toBeNull();
  });

  it('AC-125: nothing is retired without the confirmation; confirming retires the spec', async () => {
    const { planImportRetirements, confirmedRetirements } = await import('../../src/lib/specs/import-retire');
    const plan = planImportRetirements(input);
    expect(confirmedRetirements(plan, [])).toEqual([]);
    expect(confirmedRetirements(plan, ['spec-a']).map((p) => p.specId)).toEqual(['spec-a']);
    expect(confirmedRetirements(plan, ['spec-d'])).toEqual([]);
  });
});

describe('R-80 and AC-126: restoring never touches the repo file', () => {
  it('AC-126: restoring a spec retired by the file PR opens no PR and says the file still reads superseded', async () => {
    const { afterRestore } = await import('../../src/lib/specs/retire-file');
    const r = afterRestore({ filePr: 4321, filePath: 'docs/specs/checkout.md' });
    expect(r.opensPr).toBe(false);
    expect(r.note).toContain('docs/specs/checkout.md');
    expect(r.note?.toLowerCase()).toContain('still reads superseded');
  });

  it('R-80: a spec that never had a repo file gets no note', async () => {
    const { afterRestore } = await import('../../src/lib/specs/retire-file');
    expect(afterRestore({ filePr: null, filePath: null })).toEqual({ opensPr: false, note: null });
  });
});

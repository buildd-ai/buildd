import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchPanelFacts, branchPanelHasAction } from './mission-branch-panel';
import type { VisualReviewPresentation } from './workflow/visual-review-presentation';

// page.tsx is a server component: a function it calls must not come from a
// 'use client' module, or every mission page throws in a production build.
describe('branch panel rules are server-safe (spec f7f67f1a R-37)', () => {
  const p = (over: Partial<VisualReviewPresentation> = {}) => ({
    showPanel: true, owner: null, report: null,
    branch: { base: 'dev', integrationPr: null, headSha: null },
    ...over,
  }) as unknown as VisualReviewPresentation;

  it('this module is not a client module, and page.tsx takes the predicate from it', () => {
    expect(readFileSync(join(import.meta.dir, 'mission-branch-panel.ts'), 'utf8')).not.toMatch(/^['"]use client['"]/m);
    const page = readFileSync(join(import.meta.dir, '../app/app/(protected)/missions/[id]/page.tsx'), 'utf8');
    expect(page).toContain("import { branchPanelHasAction } from '@/lib/mission-branch-panel';");
    expect(page).not.toMatch(/import MissionBranchPanel, \{/);
  });

  it('runs on the server: action or report only, never when closed; no base-only facts line', () => {
    expect(branchPanelHasAction(p())).toBe(false);
    expect(branchPanelHasAction(p({ owner: { kind: 'run_review', label: 'Run' } as never }))).toBe(true);
    expect(branchPanelHasAction(p({ report: { label: 'Report' } as never }), true)).toBe(false);
    expect(branchPanelFacts(p())).toBe('');
    expect(branchPanelFacts(p({ branch: { base: 'dev', integrationPr: { number: 9 }, headSha: 'abcdef123' } as never }))).toBe('into dev · PR #9 · abcdef1');
  });
});

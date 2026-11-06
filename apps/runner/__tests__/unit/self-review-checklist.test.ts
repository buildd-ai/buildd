/**
 * Staged self-review checklist (self-review-checklist.ts): intent-only items,
 * exemption table, fail-open builder.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/self-review-checklist.test.ts
 */
import { describe, test, expect } from 'bun:test';
import {
  buildSelfReviewChecklist,
  deriveSpecCriterionIds,
  isMechanicalItem,
  selfReviewExemption,
  SELF_REVIEW_CHECKLIST_VERSION,
} from '../../src/self-review-checklist';

const task = {
  title: 'Add export button',
  description: [
    'Add an export button to the report page.',
    '',
    '- Button appears in the top bar',
    '- [ ] Clicking it downloads a CSV',
    '1. Empty reports show a disabled button',
    '- Run the unit tests and typecheck',
    '- Open a PR against dev',
    '- Make sure CI and lint pass; show the diff',
  ].join('\n'),
  pathManifest: ['apps/web/src/report.tsx', { path: 'apps/web/src/export.ts' }],
  specCriterionIds: ['AC-1', 'AC-4'],
};

describe('buildSelfReviewChecklist', () => {
  test('one item per requirement line, a scope item, and criterion ids', () => {
    const c = buildSelfReviewChecklist(task)!;
    expect(c.version).toBe(SELF_REVIEW_CHECKLIST_VERSION);
    const req = c.items.filter((i) => i.kind === 'requirement');
    expect(req.map((i) => i.text)).toEqual([
      'Did you deliver: Button appears in the top bar',
      'Did you deliver: Clicking it downloads a CSV',
      'Did you deliver: Empty reports show a disabled button',
    ]);
    const scope = c.items.filter((i) => i.kind === 'scope');
    expect(scope).toHaveLength(1);
    expect(scope[0].text).toContain('apps/web/src/report.tsx');
    expect(scope[0].text).toContain('apps/web/src/export.ts');
    expect(c.items.filter((i) => i.kind === 'criterion').map((i) => i.id)).toEqual(['crit-AC-1', 'crit-AC-4']);
  });

  test('no scope item without a manifest; ids are unique', () => {
    const c = buildSelfReviewChecklist({ description: '- one\n- two' })!;
    expect(c.items.some((i) => i.kind === 'scope')).toBe(false);
    expect(new Set(c.items.map((i) => i.id)).size).toBe(c.items.length);
  });

  test('denylist: nothing about tests, typecheck, lint, build, PR, diff, CI or verification (AC-5)', () => {
    const c = buildSelfReviewChecklist(task)!;
    for (const i of c.items) {
      expect(isMechanicalItem(i.text)).toBe(false);
      expect(i.text).not.toMatch(/\b(test|typecheck|lint|build|PR|diff|CI|verif)/i);
    }
  });

  test('builder throwing returns null so the caller fails open (AC-7)', () => {
    const hostile = {
      get description(): string {
        throw new Error('boom');
      },
    };
    expect(buildSelfReviewChecklist(hostile as any)).toBeNull();
  });
});

describe('selfReviewExemption', () => {
  test('applies to a plain builder task', () => {
    expect(selfReviewExemption({ roleSlug: 'builder', outputRequirement: 'pr_required' })).toBeNull();
    expect(selfReviewExemption({})).toBeNull();
  });

  const cases: Array<[string, Parameters<typeof selfReviewExemption>[0]]> = [
    ['error', { error: new Error('x') }],
    ['blocked', { blockedOnTaskId: 'abc' }],
    ['discard-edits', { discardEdits: true }],
    ['reviewer-role', { roleSlug: 'reviewer' }],
    ['visual-auditor-role', { roleSlug: 'visual-auditor' }],
    ['bookkeeping', { bookkeeping: true }],
    ['planning', { planning: true }],
    ['already-shipped', { alreadyShippedIn: 123 }],
    ['output-requirement-none', { outputRequirement: 'none' }],
  ];
  for (const [reason, input] of cases) {
    test(`exempts: ${reason}`, () => {
      expect(selfReviewExemption(input)).toBe(reason);
    });
  }
});

describe('deriveSpecCriterionIds', () => {
  const repairTask = {
    id: 't-repair', title: 'Repair AC-5', description: '- Make the checklist show the pinned criterion',
    context: { specRepair: { missionId: 'm1', specId: 's1', criterionId: 'AC-5', filedBy: 't0' } },
  };
  test('spec-repair task yields a crit item and the denylist still holds', () => {
    const ids = deriveSpecCriterionIds(repairTask);
    expect(ids).toEqual(['AC-5']);
    const c = buildSelfReviewChecklist({ ...repairTask, description: '- Make it right\n- Run the tests and lint', specCriterionIds: ids })!;
    expect(c.items.map(i => i.id)).toContain('crit-AC-5');
    expect(c.items.some(i => /tests|lint/i.test(i.text.replace(/spec criterion/, '')))).toBe(false);
  });
  test('dedupes, drops malformed, tolerates junk', () => {
    expect(deriveSpecCriterionIds({ specCriterionIds: ['AC-1', 'bad'], context: { specRepair: { criterionId: 'AC-1' } } })).toEqual(['AC-1']);
    expect(deriveSpecCriterionIds(null)).toEqual([]);
    expect(deriveSpecCriterionIds({ context: { specRepair: 'x' } })).toEqual([]);
  });
});

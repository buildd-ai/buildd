import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateAssertions,
  evaluateAssertion,
  isSuppressed,
  computeDerivedStatus,
  checkContradiction,
  checkMissingAssertions,
  parseFrontmatter,
  extractBoldStatus,
  declaredStatus,
  discoverDocs,
  evaluateDoc,
  evaluateAllDocs,
  resolveConformanceConfig,
  computeWatchSet,
  isWatched,
  MISSING_ASSERTIONS_DEBT,
  type RawAssertion,
  type TypedAssertion,
  type AssertionResult,
} from '../spec-conformance';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'spec-conformance-test-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function typed(overrides: Partial<TypedAssertion> & { type: TypedAssertion['type'] }): TypedAssertion {
  return { id: 'test-id', fields: {}, ...overrides };
}

// ─── validateAssertions ─────────────────────────────────────────────────────

describe('validateAssertions', () => {
  test('rejects an assertion missing id (§7 — required, no grace period)', () => {
    const raw: RawAssertion[] = [{ type: 'symbol', name: 'Foo', path: 'a.ts' }];
    const { valid, errors } = validateAssertions(raw);
    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/missing required field "id"/);
  });

  test('rejects a duplicate id within the same doc', () => {
    const raw: RawAssertion[] = [
      { id: 'dup', type: 'symbol', name: 'Foo', path: 'a.ts' },
      { id: 'dup', type: 'symbol', name: 'Bar', path: 'b.ts' },
    ];
    const { valid, errors } = validateAssertions(raw);
    expect(valid).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/duplicate id "dup"/);
  });

  test('rejects an unknown assertion type', () => {
    const raw: RawAssertion[] = [{ id: 'x', type: 'bogus', name: 'Foo' }];
    const { errors } = validateAssertions(raw);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/not one of/);
  });

  test('rejects skip_until without skip_reason (§6)', () => {
    const raw: RawAssertion[] = [
      { id: 'x', type: 'symbol', name: 'Foo', path: 'a.ts', skip_until: '2099-01-01' },
    ];
    const { errors } = validateAssertions(raw);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/skip_until set without skip_reason/);
  });

  const requiredFieldCases: Array<[RawAssertion['type'] & string, Record<string, string>]> = [
    ['symbol', { name: 'Foo', path: 'a.ts' }],
    ['symbol_reachable', { symbol: 'Foo', entry: 'a.ts' }],
    ['route', { method: 'GET', path: '/api/x', file: 'a.ts' }],
    ['migration', { number: '91', contains: 'loop_config' }],
    ['config_key', { key: 'FOO', file: 'a.ts' }],
    ['test_file', { path: 'a.test.ts' }],
  ];

  for (const [type, fields] of requiredFieldCases) {
    test(`accepts a well-formed "${type}" assertion`, () => {
      const raw: RawAssertion[] = [{ id: `${type}-id`, type, ...fields }];
      const { valid, errors } = validateAssertions(raw);
      expect(errors).toHaveLength(0);
      expect(valid).toHaveLength(1);
      expect(valid[0].type).toBe(type);
    });

    test(`rejects a "${type}" assertion missing its required fields`, () => {
      const raw: RawAssertion[] = [{ id: `${type}-id`, type }];
      const { valid, errors } = validateAssertions(raw);
      expect(valid).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/missing required field/);
    });
  }
});

// ─── isSuppressed ───────────────────────────────────────────────────────────

describe('isSuppressed', () => {
  const now = new Date('2026-09-11');

  test('false when no skip_until', () => {
    expect(isSuppressed(typed({ type: 'symbol' }), now)).toBe(false);
  });

  test('true when skip_until is in the future', () => {
    expect(isSuppressed(typed({ type: 'symbol', skipUntil: '2099-01-01', skipReason: 'r' }), now)).toBe(true);
  });

  test('false once skip_until has expired — the assertion runs again (§6)', () => {
    expect(isSuppressed(typed({ type: 'symbol', skipUntil: '2020-01-01', skipReason: 'r' }), now)).toBe(false);
  });
});

// ─── evaluateAssertion — one fixture-backed positive + negative per type ───

describe('evaluateAssertion', () => {
  test('symbol: passes when an export of the name exists', () => {
    const dir = join(root, 'sym-pass');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.ts'), 'export function buildWorkerBwrapArgv() {}\n');
    const result = evaluateAssertion(typed({ type: 'symbol', fields: { name: 'buildWorkerBwrapArgv', path: 'a.ts' } }), { repoRoot: dir });
    expect(result.outcome).toBe('pass');
  });

  test('symbol: fails when the named symbol does not resolve in the file', () => {
    const dir = join(root, 'sym-fail');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.ts'), 'export function somethingElse() {}\n');
    const result = evaluateAssertion(typed({ type: 'symbol', fields: { name: 'buildWorkerMountAllowlist', path: 'a.ts' } }), { repoRoot: dir });
    expect(result.outcome).toBe('fail');
    expect(result.detail).toMatch(/no exported "buildWorkerMountAllowlist"/);
  });

  test('symbol: fails when the file does not exist', () => {
    const result = evaluateAssertion(typed({ type: 'symbol', fields: { name: 'Foo', path: 'nope.ts' } }), { repoRoot: root });
    expect(result.outcome).toBe('fail');
    expect(result.detail).toMatch(/file not found/);
  });

  test('symbol_reachable as:assign passes only on assignment, not mere mention', () => {
    const dir = join(root, 'reachable');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'route.ts'), 'import type { LoopState } from "./x";\n// loopState is discussed here\n');
    const mention = evaluateAssertion(
      typed({ type: 'symbol_reachable', fields: { symbol: 'loopState', entry: 'route.ts', as: 'assign' } }),
      { repoRoot: dir },
    );
    expect(mention.outcome).toBe('fail');

    writeFileSync(join(dir, 'route.ts'), 'taskUpdate.loopState = "condition_unmet";\n');
    const assigned = evaluateAssertion(
      typed({ type: 'symbol_reachable', fields: { symbol: 'loopState', entry: 'route.ts', as: 'assign' } }),
      { repoRoot: dir },
    );
    expect(assigned.outcome).toBe('pass');
  });

  test('route: passes when the file exports the named HTTP method', () => {
    const dir = join(root, 'route-pass');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'route.ts'), 'export async function GET(req: Request) {}\n');
    const result = evaluateAssertion(
      typed({ type: 'route', fields: { method: 'GET', path: '/api/x', file: 'route.ts' } }),
      { repoRoot: dir },
    );
    expect(result.outcome).toBe('pass');
  });

  test('route: fails when the expected method is not exported', () => {
    const dir = join(root, 'route-fail');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'route.ts'), 'export async function GET(req: Request) {}\n');
    const result = evaluateAssertion(
      typed({ type: 'route', fields: { method: 'POST', path: '/api/x', file: 'route.ts' } }),
      { repoRoot: dir },
    );
    expect(result.outcome).toBe('fail');
  });

  test('migration: passes when the numbered file exists and contains the identifier', () => {
    const dir = join(root, 'migration-pass');
    mkdirSync(join(dir, 'drizzle'), { recursive: true });
    writeFileSync(join(dir, 'drizzle', '0091_loop.sql'), 'ALTER TABLE tasks ADD COLUMN loop_config jsonb;\n');
    const result = evaluateAssertion(
      typed({ type: 'migration', fields: { number: '91', contains: 'loop_config' } }),
      { repoRoot: dir, migrationsDir: 'drizzle' },
    );
    expect(result.outcome).toBe('pass');
  });

  test('migration: fails when no file matches the number', () => {
    const dir = join(root, 'migration-fail');
    mkdirSync(join(dir, 'drizzle'), { recursive: true });
    const result = evaluateAssertion(
      typed({ type: 'migration', fields: { number: '92', contains: 'loop_config' } }),
      { repoRoot: dir, migrationsDir: 'drizzle' },
    );
    expect(result.outcome).toBe('fail');
    expect(result.detail).toMatch(/no migration file numbered/);
  });

  test('config_key: passes/fails on literal presence in the named file', () => {
    const dir = join(root, 'config-key');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.ts'), 'if (process.env.BUILDD_DISABLE_SANDBOX) {}\n');
    expect(
      evaluateAssertion(typed({ type: 'config_key', fields: { key: 'BUILDD_DISABLE_SANDBOX', file: 'a.ts' } }), { repoRoot: dir }).outcome,
    ).toBe('pass');
    expect(
      evaluateAssertion(typed({ type: 'config_key', fields: { key: 'BUILDD_OTHER_FLAG', file: 'a.ts' } }), { repoRoot: dir }).outcome,
    ).toBe('fail');
  });

  test('test_file: existence only', () => {
    const dir = join(root, 'test-file');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'foo.test.ts'), '');
    expect(evaluateAssertion(typed({ type: 'test_file', fields: { path: 'foo.test.ts' } }), { repoRoot: dir }).outcome).toBe('pass');
    expect(evaluateAssertion(typed({ type: 'test_file', fields: { path: 'missing.test.ts' } }), { repoRoot: dir }).outcome).toBe('fail');
  });

  test('a currently-suppressed assertion is never evaluated against the filesystem', () => {
    const result = evaluateAssertion(
      typed({ type: 'symbol', fields: { name: 'Foo', path: 'does-not-exist.ts' }, skipUntil: '2099-01-01', skipReason: 'not built yet' }),
      { repoRoot: root, now: new Date('2026-09-11') },
    );
    expect(result.outcome).toBe('suppressed');
  });
});

// ─── computeDerivedStatus (§2 table + §6 suppression carve-outs) ───────────

describe('computeDerivedStatus', () => {
  const r = (outcome: AssertionResult['outcome'], n = 1): AssertionResult[] =>
    Array.from({ length: n }, (_, i) => ({ id: `a${i}`, type: 'symbol' as const, outcome, detail: '' }));

  test('zero assertions → unverified, never a failure', () => {
    expect(computeDerivedStatus([])).toBe('unverified');
  });

  test('all pass → implemented', () => {
    expect(computeDerivedStatus(r('pass', 3))).toBe('implemented');
  });

  test('all fail → failing', () => {
    expect(computeDerivedStatus(r('fail', 3))).toBe('failing');
  });

  test('mix of pass and fail → partial', () => {
    expect(computeDerivedStatus([...r('pass', 1), ...r('fail', 1)])).toBe('partial');
  });

  test('every assertion suppressed → unverified, not implemented (§6)', () => {
    expect(computeDerivedStatus(r('suppressed', 2))).toBe('unverified');
  });

  test('pass + suppressed mix → partial, suppressed never counts as pass (§6)', () => {
    expect(computeDerivedStatus([...r('pass', 2), ...r('suppressed', 1)])).toBe('partial');
  });
});

// ─── checkContradiction (§2 CI failure conditions) ─────────────────────────

describe('checkContradiction', () => {
  test('declared implemented + derived partial → declared-ahead-of-derived', () => {
    const c = checkContradiction('design', 'implemented', 'partial');
    expect(c?.kind).toBe('declared-ahead-of-derived');
  });

  test('declared active (spec) + derived failing → declared-ahead-of-derived', () => {
    const c = checkContradiction('spec', 'active', 'failing');
    expect(c?.kind).toBe('declared-ahead-of-derived');
  });

  test('derived implemented + declared proposed → derived-ahead-of-declared', () => {
    const c = checkContradiction('design', 'proposed', 'implemented');
    expect(c?.kind).toBe('derived-ahead-of-declared');
  });

  test('derived partial + declared proposed → no contradiction (expected in-progress state)', () => {
    expect(checkContradiction('design', 'proposed', 'partial')).toBeNull();
  });

  test('derived unverified never contradicts, even against a terminal declared status', () => {
    expect(checkContradiction('design', 'implemented', 'unverified')).toBeNull();
  });

  test('no declared status → no contradiction', () => {
    expect(checkContradiction('design', null, 'implemented')).toBeNull();
  });

  test('a status outside the known enum (e.g. superseded) never contradicts', () => {
    expect(checkContradiction('design', 'superseded', 'implemented')).toBeNull();
    expect(checkContradiction('design', 'superseded', 'failing')).toBeNull();
  });
});

// ─── checkMissingAssertions (Part A — enforce first) ───────────────────────

describe('checkMissingAssertions', () => {
  test('terminal status + zero assertions + not grandfathered → missing-assertions', () => {
    const c = checkMissingAssertions('docs/design/brand-new.md', 'design', 'implemented', 0, null);
    expect(c?.kind).toBe('missing-assertions');
  });

  test('terminal status (active, spec) + zero assertions → missing-assertions', () => {
    const c = checkMissingAssertions('docs/specs/brand-new.md', 'spec', 'active', 0, null);
    expect(c?.kind).toBe('missing-assertions');
  });

  test('non-terminal status (proposed/draft) + zero assertions → no failure (§5 honest backlog state)', () => {
    expect(checkMissingAssertions('docs/design/x.md', 'design', 'proposed', 0, null)).toBeNull();
    expect(checkMissingAssertions('docs/specs/x.md', 'spec', 'draft', 0, null)).toBeNull();
  });

  test('no declared status → no failure', () => {
    expect(checkMissingAssertions('docs/design/x.md', 'design', null, 0, null)).toBeNull();
  });

  test('at least one assertion declared → no failure, even if every assertion is suppressed', () => {
    // Presence, not evaluated outcome — a doc's own §2 contradiction check separately
    // handles whether a suppressed-only doc's derived status contradicts declared.
    expect(checkMissingAssertions('docs/design/x.md', 'design', 'implemented', 1, null)).toBeNull();
  });

  test('not_mechanizable_reason (10+ chars) is a valid escape hatch, mirroring goalCriteria', () => {
    expect(
      checkMissingAssertions('docs/design/x.md', 'design', 'implemented', 0, 'no code surface exists to assert against'),
    ).toBeNull();
  });

  test('not_mechanizable_reason under 10 chars does not satisfy the escape hatch', () => {
    const c = checkMissingAssertions('docs/design/x.md', 'design', 'implemented', 0, 'too short');
    expect(c?.kind).toBe('missing-assertions');
  });

  test('backfilled terminal docs cannot silently lose all assertions', () => {
    expect(MISSING_ASSERTIONS_DEBT.size).toBe(0);
    for (const [path, docType, status] of [
      ['docs/design/backend-failover-policy.md', 'design', 'implemented'],
      ['docs/specs/mission-task-lifecycle.md', 'spec', 'active'],
      ['docs/specs/team-namespace-scoping.md', 'spec', 'active'],
    ] as const) {
      expect(checkMissingAssertions(path, docType, status, 0, null)?.kind).toBe('missing-assertions');
    }
  });

});

// ─── parseFrontmatter / extractBoldStatus / declaredStatus ─────────────────

describe('parseFrontmatter', () => {
  test('returns null when the doc has no leading --- block', () => {
    expect(parseFrontmatter('# Title\n\nNo frontmatter here.\n')).toBeNull();
  });

  test('parses a flat status field', () => {
    const fm = parseFrontmatter('---\nstatus: proposed\n---\n# Title\n');
    expect(fm?.status).toBe('proposed');
    expect(fm?.assertions).toEqual([]);
  });

  test('parses a nested assertions block, including comments and quoted values', () => {
    const content = [
      '---',
      'status: implemented',
      'assertions:',
      '  # a leading comment',
      '  - id: mount-symbol',
      '    type: symbol',
      '    name: buildWorkerBwrapArgv',
      '    path: apps/runner/src/bwrap-mount-allowlist.ts',
      '  - id: renamed',
      '    type: symbol',
      '    name: old',
      '    path: a.ts',
      '    skip_until: "2026-08-15"',
      '    skip_reason: "Renamed — PR pending"',
      '---',
      '# Title',
      '',
    ].join('\n');
    const fm = parseFrontmatter(content);
    expect(fm?.status).toBe('implemented');
    expect(fm?.assertions).toHaveLength(2);
    expect(fm?.assertions[0]).toEqual({
      id: 'mount-symbol',
      type: 'symbol',
      name: 'buildWorkerBwrapArgv',
      path: 'apps/runner/src/bwrap-mount-allowlist.ts',
    });
    expect(fm?.assertions[1].skip_until).toBe('2026-08-15');
    expect(fm?.assertions[1].skip_reason).toBe('Renamed — PR pending');
  });

  test('parses not_mechanizable_reason (Part A escape hatch)', () => {
    const fm = parseFrontmatter('---\nstatus: implemented\nnot_mechanizable_reason: "no code surface to assert against"\n---\n# Title\n');
    expect(fm?.notMechanizableReason).toBe('no code surface to assert against');
  });

  test('not_mechanizable_reason defaults to null when absent', () => {
    const fm = parseFrontmatter('---\nstatus: proposed\n---\n# Title\n');
    expect(fm?.notMechanizableReason).toBeNull();
  });
});

describe('extractBoldStatus', () => {
  test('reads the first status word off the bold header line', () => {
    expect(extractBoldStatus('# Title\n\n**Status:** Proposed\n**Related:** x\n')).toBe('proposed');
  });

  test('ignores trailing prose after the status word', () => {
    expect(extractBoldStatus('**Status:** Proposed — prerequisites merged (see PR #1864)\n')).toBe('proposed');
  });

  test('returns null when there is no bold status line', () => {
    expect(extractBoldStatus('# Title\n\nNo status line.\n')).toBeNull();
  });
});

describe('declaredStatus', () => {
  test('prefers frontmatter status over the bold line when both are present', () => {
    const content = '---\nstatus: implemented\n---\n**Status:** Proposed\n';
    expect(declaredStatus(content, parseFrontmatter(content), 'design')).toBe('implemented');
  });

  test('falls back to the bold status line for design docs with no frontmatter', () => {
    const content = '# Title\n\n**Status:** Proposed\n';
    expect(declaredStatus(content, parseFrontmatter(content), 'design')).toBe('proposed');
  });

  test('does not fall back to a bold line for spec docs (they always carry frontmatter)', () => {
    const content = '# Title\n\n**Status:** Proposed\n';
    expect(declaredStatus(content, parseFrontmatter(content), 'spec')).toBeNull();
  });
});

// ─── discoverDocs / evaluateDoc / evaluateAllDocs — portability seam ───────

describe('portability (Part C — specsRoot/designRoot are not hardcoded)', () => {
  test('discoverDocs walks caller-supplied roots and skips known meta files', () => {
    const dir = join(root, 'portable-repo');
    mkdirSync(join(dir, 'my-specs'), { recursive: true });
    mkdirSync(join(dir, 'my-designs'), { recursive: true });
    writeFileSync(join(dir, 'my-specs', 'SPEC-FORMAT.md'), '# meta');
    writeFileSync(join(dir, 'my-specs', 'INDEX.md'), '# meta');
    writeFileSync(join(dir, 'my-specs', 'widget.md'), '---\nstatus: active\n---\n# Widget\n');
    writeFileSync(join(dir, 'my-designs', 'DESIGN-FORMAT.md'), '# meta');
    writeFileSync(join(dir, 'my-designs', 'gadget.md'), '# Gadget\n\n**Status:** Proposed\n');

    const config = resolveConformanceConfig({ repoRoot: dir, specsRoot: 'my-specs', designRoot: 'my-designs' });
    const docs = discoverDocs(config);

    expect(docs).toHaveLength(2);
    expect(docs.some((d) => d.path.endsWith('widget.md') && d.docType === 'spec')).toBe(true);
    expect(docs.some((d) => d.path.endsWith('gadget.md') && d.docType === 'design')).toBe(true);
    expect(docs.some((d) => d.path.includes('SPEC-FORMAT') || d.path.includes('DESIGN-FORMAT') || d.path.includes('INDEX'))).toBe(false);
  });

  test('defaults to docs/specs and docs/design when no override is given', () => {
    const config = resolveConformanceConfig({ repoRoot: root });
    expect(config.specsRoot).toBe('docs/specs');
    expect(config.designRoot).toBe('docs/design');
  });
});

describe('evaluateDoc end-to-end', () => {
  test('a draft/proposed spec with zero assertions resolves to unverified, fails nothing, and stays visible (§5 honest backlog state)', () => {
    const dir = join(root, 'zero-assertions-nonterminal');
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true });
    mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
    // Non-terminal status with no assertions at all — must not be flagged as a contradiction.
    writeFileSync(join(dir, 'docs', 'specs', 'lonely.md'), '---\nstatus: draft\n---\n# Lonely\n');

    const config = resolveConformanceConfig({ repoRoot: dir });
    const [evaluation] = evaluateAllDocs(config);

    expect(evaluation.derivedStatus).toBe('unverified');
    expect(evaluation.results).toEqual([]);
    expect(evaluation.contradiction).toBeNull();
  });

  test('an active spec with zero assertions and no grandfathering is a missing-assertions contradiction (Part A)', () => {
    const dir = join(root, 'zero-assertions-terminal');
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true });
    mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'specs', 'lonely.md'), '---\nstatus: active\n---\n# Lonely\n');

    const config = resolveConformanceConfig({ repoRoot: dir });
    const [evaluation] = evaluateAllDocs(config);

    expect(evaluation.derivedStatus).toBe('unverified');
    expect(evaluation.contradiction?.kind).toBe('missing-assertions');
  });

  test('an active spec with zero assertions but a stated not_mechanizable_reason is not a contradiction', () => {
    const dir = join(root, 'zero-assertions-escape-hatch');
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true });
    mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
    writeFileSync(
      join(dir, 'docs', 'specs', 'lonely.md'),
      '---\nstatus: active\nnot_mechanizable_reason: "purely a UX copy contract, no code surface"\n---\n# Lonely\n',
    );

    const config = resolveConformanceConfig({ repoRoot: dir });
    const [evaluation] = evaluateAllDocs(config);

    expect(evaluation.contradiction).toBeNull();
  });

  test('an assertion naming a symbol that does not resolve produces a failing doc, not a crash', () => {
    const dir = join(root, 'unresolved-symbol');
    mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
    mkdirSync(join(dir, 'apps'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'workers.ts'), 'export function somethingUnrelated() {}\n');
    writeFileSync(
      join(dir, 'docs', 'design', 'ghost.md'),
      ['---', 'status: implemented', 'assertions:', '  - id: ghost-symbol', '    type: symbol', '    name: buildWorkerMountAllowlist', '    path: apps/workers.ts', '---', '# Ghost', ''].join(
        '\n',
      ),
    );

    const config = resolveConformanceConfig({ repoRoot: dir });
    const [evaluation] = evaluateAllDocs(config);

    expect(evaluation.derivedStatus).toBe('failing');
    expect(evaluation.results[0].outcome).toBe('fail');
    expect(evaluation.contradiction?.kind).toBe('declared-ahead-of-derived');
  });

  test('an assertion missing id is a validation error, not silently skipped or evaluated', () => {
    const dir = join(root, 'missing-id');
    mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
    writeFileSync(
      join(dir, 'docs', 'design', 'legacy.md'),
      ['---', 'status: implemented', 'assertions:', '  - type: symbol', '    name: whatever', '    path: apps/whatever.ts', '---', '# Legacy', ''].join('\n'),
    );

    const config = resolveConformanceConfig({ repoRoot: dir });
    const [evaluation] = evaluateAllDocs(config);

    expect(evaluation.results).toEqual([]);
    expect(evaluation.validationErrors).toHaveLength(1);
    expect(evaluation.derivedStatus).toBe('unverified');
  });
});

// ─── computeWatchSet / isWatched (§4) ───────────────────────────────────────

describe('computeWatchSet', () => {
  test('always watches docs/design/** in full, independent of any assertion', () => {
    const dir = join(root, 'watch-design-prefix');
    mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'design', 'no-assertions.md'), ['---', 'status: proposed', '---', '# No assertions', ''].join('\n'));

    const config = resolveConformanceConfig({ repoRoot: dir });
    const watchSet = computeWatchSet(config);

    expect(watchSet.prefixes).toContain('docs/design/');
    expect(isWatched('docs/design/no-assertions.md', watchSet)).toBe(true);
    expect(isWatched('docs/design/brand-new-doc-not-yet-discovered.md', watchSet)).toBe(true);
  });

  test('collects path/file/entry fields from assertions across both spec and design docs', () => {
    const dir = join(root, 'watch-assertion-fields');
    mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true });
    writeFileSync(
      join(dir, 'docs', 'design', 'a.md'),
      [
        '---',
        'status: proposed',
        'assertions:',
        '  - id: sym',
        '    type: symbol',
        '    name: foo',
        '    path: apps/runner/src/foo.ts',
        '  - id: reach',
        '    type: symbol_reachable',
        '    symbol: bar',
        '    entry: apps/web/src/app/api/workers/[id]/route.ts',
        '---',
        '# A',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'docs', 'specs', 'b.md'),
      [
        '---',
        'status: draft',
        'assertions:',
        '  - id: rt',
        '    type: route',
        '    method: GET',
        '    path: /api/thing',
        '    file: apps/web/src/app/api/thing/route.ts',
        '---',
        '# B',
        '',
      ].join('\n'),
    );

    const config = resolveConformanceConfig({ repoRoot: dir });
    const watchSet = computeWatchSet(config);

    expect(watchSet.paths).toContain('apps/runner/src/foo.ts');
    expect(watchSet.paths).toContain('apps/web/src/app/api/workers/[id]/route.ts');
    expect(watchSet.paths).toContain('apps/web/src/app/api/thing/route.ts');
    expect(isWatched('apps/runner/src/foo.ts', watchSet)).toBe(true);
    expect(isWatched('apps/web/src/app/api/unrelated/route.ts', watchSet)).toBe(false);
  });

  test('a doc that lives outside docs/specs/** only enters the watch set via its own referenced paths, not wholesale', () => {
    const dir = join(root, 'watch-specs-not-wholesale');
    mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'specs', 'untouched.md'), ['---', 'status: draft', '---', '# Untouched', ''].join('\n'));

    const config = resolveConformanceConfig({ repoRoot: dir });
    const watchSet = computeWatchSet(config);

    expect(isWatched('docs/specs/untouched.md', watchSet)).toBe(false);
  });

  test('an assertion missing id (invalid) does not contribute its path to the watch set', () => {
    const dir = join(root, 'watch-invalid-assertion');
    mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
    writeFileSync(
      join(dir, 'docs', 'design', 'invalid.md'),
      ['---', 'status: proposed', 'assertions:', '  - type: symbol', '    name: foo', '    path: apps/should-not-be-watched.ts', '---', '# Invalid', ''].join('\n'),
    );

    const config = resolveConformanceConfig({ repoRoot: dir });
    const watchSet = computeWatchSet(config);

    expect(watchSet.paths).not.toContain('apps/should-not-be-watched.ts');
  });
});

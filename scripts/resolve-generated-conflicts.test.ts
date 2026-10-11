/**
 * The generated-file resolver against a real git merge in a scratch repo.
 * Git is real; the three regenerators (specs:check, db:generate,
 * design:check --update) are stand-ins that write what the real ones would,
 * so each test controls what "regenerating" produces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  exitCodeFor,
  mergeBaselineCounts,
  realRun,
  resolveGeneratedConflicts,
  type Run,
} from './resolve-generated-conflicts';

let root: string;

function sh(args: string[]) {
  const r = realRun('git', args, { cwd: root });
  if (r.status !== 0 && !(args[0] === 'merge')) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r;
}
function write(path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function read(path: string) {
  return readFileSync(join(root, path), 'utf8');
}
function commitAll(msg: string) {
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', msg]);
}

/** A repo with `main` (trunk) and `mission` diverged from a common base; returns after `git merge main` on mission. */
function diverge(setup: { base: () => void; trunk: () => void; mission: () => void }) {
  setup.base();
  commitAll('base');
  sh(['checkout', '-q', '-b', 'mission']);
  setup.mission();
  commitAll('mission work');
  sh(['checkout', '-q', 'main']);
  setup.trunk();
  commitAll('trunk work');
  sh(['checkout', '-q', 'mission']);
  sh(['merge', '-q', '--no-edit', 'main']);
}

interface Fakes { specsIndex?: string; designUpdateStatus?: number }
const calls: string[] = [];
function runWith(f: Fakes): Run {
  return (cmd, args, opts) => {
    if (cmd !== 'bun') return realRun(cmd, args, opts);
    calls.push(args.join(' '));
    if (args.join(' ') === 'run specs:check') {
      write('docs/specs/INDEX.md', f.specsIndex ?? 'regenerated index\n');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args.join(' ') === 'run design:check --update') return { status: f.designUpdateStatus ?? 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected bun ${args.join(' ')}` };
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'resolve-generated-'));
  sh(['init', '-q', '-b', 'main']);
  sh(['config', 'user.email', 't@example.com']);
  sh(['config', 'user.name', 't']);
  sh(['config', 'commit.gpgsign', 'false']);
  calls.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the specs INDEX', () => {
  it('is regenerated, not merged, and the merge is left with nothing to resolve', () => {
    diverge({
      base: () => write('docs/specs/INDEX.md', 'index v0\n'),
      trunk: () => write('docs/specs/INDEX.md', 'index trunk\n'),
      mission: () => write('docs/specs/INDEX.md', 'index mission\n'),
    });
    const report = resolveGeneratedConflicts(root, runWith({ specsIndex: 'regenerated index\n' }));
    expect(report.steps).toEqual([{ path: 'docs/specs/INDEX.md', result: 'resolved' }]);
    expect(read('docs/specs/INDEX.md')).toBe('regenerated index\n');
    expect(report.remaining).toEqual([]);
    expect(exitCodeFor(report)).toBe(0);
  });

  it('waits while a spec file itself is conflicted', () => {
    diverge({
      base: () => { write('docs/specs/INDEX.md', 'v0\n'); write('docs/specs/a.md', 'a0\n'); },
      trunk: () => { write('docs/specs/INDEX.md', 'trunk\n'); write('docs/specs/a.md', 'a trunk\n'); },
      mission: () => { write('docs/specs/INDEX.md', 'mission\n'); write('docs/specs/a.md', 'a mission\n'); },
    });
    const report = resolveGeneratedConflicts(root, runWith({}));
    expect(report.steps[0]).toMatchObject({ path: 'docs/specs/INDEX.md', result: 'waiting' });
    expect(calls).toEqual([]);
    expect(report.remaining.sort()).toEqual(['docs/specs/INDEX.md', 'docs/specs/a.md']);
    expect(exitCodeFor(report)).toBe(2);
  });
});

describe('a real code conflict', () => {
  it('is never touched, and is listed as what remains', () => {
    diverge({
      base: () => write('apps/web/src/lib/x.ts', 'export const x = 0;\n'),
      trunk: () => write('apps/web/src/lib/x.ts', 'export const x = 1;\n'),
      mission: () => write('apps/web/src/lib/x.ts', 'export const x = 2;\n'),
    });
    const before = read('apps/web/src/lib/x.ts');
    const report = resolveGeneratedConflicts(root, runWith({}));
    expect(report.steps).toEqual([]);
    expect(read('apps/web/src/lib/x.ts')).toBe(before);
    expect(report.remaining).toEqual(['apps/web/src/lib/x.ts']);
    expect(exitCodeFor(report)).toBe(2);
  });
});

describe('drizzle migrations at the same index', () => {
  const journal = (tags: string[]) => JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag })) }, null, 2) + '\n';
  function journalsCollide(extra: { trunk?: () => void; mission?: () => void } = {}) {
    diverge({
      base: () => { write('packages/core/db/schema.ts', 's0\n'); write('packages/core/drizzle/meta/_journal.json', journal(['0000_base'])); },
      trunk: () => { write('packages/core/drizzle/meta/_journal.json', journal(['0000_base', '0001_trunk'])); extra.trunk?.(); },
      mission: () => { write('packages/core/drizzle/meta/_journal.json', journal(['0000_base', '0001_mission'])); extra.mission?.(); },
    });
  }
  /** Stands in for renumberAgainstBase: settles the drizzle conflict the way it would. */
  const renumbered = (r: { sqlChanged?: boolean; throws?: string } = {}) => (dir: string) => {
    if (r.throws) throw new Error(r.throws);
    realRun('git', ['checkout', 'MERGE_HEAD', '--', 'packages/core/drizzle'], { cwd: dir });
    realRun('git', ['add', '-A', '--', 'packages/core/drizzle'], { cwd: dir });
    return { removed: ['0001_mission.sql'], generated: ['0002_mission.sql'], sqlChanged: r.sqlChanged ?? false };
  };

  it('is repaired by the migration renumber, against the trunk being merged', () => {
    journalsCollide();
    let calledWith: string | null = null;
    const report = resolveGeneratedConflicts(root, runWith({}), (dir) => { calledWith = dir; return renumbered()(dir); });
    expect(calledWith).toBe(root);
    expect(report.steps).toEqual([{ path: 'packages/core/drizzle/', result: 'resolved' }]);
    expect(report.remaining).toEqual([]);
  });

  it('runs after the INDEX is regenerated, so that conflict does not hold it back', () => {
    journalsCollide({
      trunk: () => write('docs/specs/INDEX.md', 'trunk\n'),
      mission: () => write('docs/specs/INDEX.md', 'mission\n'),
    });
    write('docs/specs/INDEX.md', 'x'); // keep the working copy conflicted as git left it
    realRun('git', ['checkout', '-m', '--', 'docs/specs/INDEX.md'], { cwd: root });
    const report = resolveGeneratedConflicts(root, runWith({}), renumbered());
    expect(report.steps.map((s) => [s.path, s.result])).toEqual([['docs/specs/INDEX.md', 'resolved'], ['packages/core/drizzle/', 'resolved']]);
  });

  it('waits while real code is conflicted: the migrations regenerate from the merged schema', () => {
    journalsCollide({
      trunk: () => write('packages/core/db/schema.ts', 's trunk\n'),
      mission: () => write('packages/core/db/schema.ts', 's mission\n'),
    });
    let called = false;
    const report = resolveGeneratedConflicts(root, runWith({}), (dir) => { called = true; return renumbered()(dir); });
    expect(called).toBe(false);
    expect(report.steps[0]).toMatchObject({ path: 'packages/core/drizzle/', result: 'waiting' });
    expect(report.remaining).toContain('packages/core/db/schema.ts');
  });

  it('leaves it for a person when the regenerated SQL differs from what it replaced', () => {
    journalsCollide();
    const report = resolveGeneratedConflicts(root, runWith({}), renumbered({ sqlChanged: true }));
    expect(report.steps[0]).toMatchObject({ path: 'packages/core/drizzle/', result: 'needs_person' });
    expect((report.steps[0] as { reason: string }).reason).toContain('hand-written');
    expect(exitCodeFor(report)).toBe(2);
  });

  it('leaves it for a person when the renumber itself fails', () => {
    journalsCollide();
    const report = resolveGeneratedConflicts(root, runWith({}), renumbered({ throws: 'drizzle-kit generate failed' }));
    expect(report.steps[0]).toMatchObject({ result: 'needs_person', reason: 'drizzle-kit generate failed' });
  });
});

describe('the design-check baseline', () => {
  const baseline = (counts: Record<string, number>) => JSON.stringify({ rule: counts }, null, 2) + '\n';

  it("carries both sides' changes, then lets design:check lower it", () => {
    diverge({
      base: () => write('scripts/design-check.baseline.json', baseline({ 'a.tsx': 2, 'b.tsx': 1 })),
      trunk: () => write('scripts/design-check.baseline.json', baseline({ 'a.tsx': 1, 'b.tsx': 1, 'c.tsx': 3 })),
      mission: () => write('scripts/design-check.baseline.json', baseline({ 'a.tsx': 2, 'b.tsx': 4 })),
    });
    const report = resolveGeneratedConflicts(root, runWith({ designUpdateStatus: 0 }));
    expect(report.steps).toEqual([{ path: 'scripts/design-check.baseline.json', result: 'resolved' }]);
    expect(JSON.parse(read('scripts/design-check.baseline.json'))).toEqual({ rule: { 'a.tsx': 1, 'b.tsx': 4, 'c.tsx': 3 } });
    expect(calls).toEqual(['run design:check --update']);
  });

  it('waits while a scanned source file is conflicted: its markers would count both sides', () => {
    diverge({
      base: () => { write('scripts/design-check.baseline.json', baseline({ 'a.tsx': 1 })); write('apps/web/src/a.tsx', 'a0\n'); },
      trunk: () => { write('scripts/design-check.baseline.json', baseline({ 'a.tsx': 2 })); write('apps/web/src/a.tsx', 'a trunk\n'); },
      mission: () => { write('scripts/design-check.baseline.json', baseline({ 'a.tsx': 3 })); write('apps/web/src/a.tsx', 'a mission\n'); },
    });
    const report = resolveGeneratedConflicts(root, runWith({}));
    expect(report.steps[0]).toMatchObject({ path: 'scripts/design-check.baseline.json', result: 'waiting' });
    expect(calls).toEqual([]);
  });

  it('leaves it for a person when the merged code has more debt than either side', () => {
    diverge({
      base: () => write('scripts/design-check.baseline.json', baseline({ 'a.tsx': 1 })),
      trunk: () => write('scripts/design-check.baseline.json', baseline({ 'a.tsx': 2 })),
      mission: () => write('scripts/design-check.baseline.json', baseline({ 'a.tsx': 3 })),
    });
    const report = resolveGeneratedConflicts(root, runWith({ designUpdateStatus: 1 }));
    expect(report.steps[0]).toMatchObject({ result: 'needs_person' });
    expect(report.remaining).toContain('scripts/design-check.baseline.json');
  });
});

describe('outside a merge', () => {
  it('refuses rather than guessing what to resolve', () => {
    write('README.md', 'x\n');
    commitAll('init');
    expect(() => resolveGeneratedConflicts(root, runWith({}))).toThrow('not in the middle of a merge');
  });
});

describe('pure helpers', () => {
  it('a three-way count merge takes a change both sides made once, not twice', () => {
    // Both sides already lowered a file the same way (an earlier refresh carried it to both).
    expect(mergeBaselineCounts({ r: { a: 77 } }, { r: { a: 53 } }, { r: { a: 53 } })).toEqual({ r: { a: 53 } });
    // One side changed it: that side's count.
    expect(mergeBaselineCounts({ r: { a: 5 } }, { r: { a: 5 } }, { r: { a: 7 } })).toEqual({ r: { a: 7 } });
    // Both changed it differently: each side's change is kept.
    expect(mergeBaselineCounts({ r: { a: 5 } }, { r: { a: 6 } }, { r: { a: 8 } })).toEqual({ r: { a: 9 } });
  });

  it('a three-way count merge drops a file both sides cleared', () => {
    expect(mergeBaselineCounts({ r: { a: 2 } }, { r: { a: 1 } }, { r: {} })).toEqual({ r: {} });
  });
});

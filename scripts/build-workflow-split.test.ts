import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

/**
 * The `build` job was split into three parallel jobs. `build` itself stays as
 * an aggregator because branch protection on main requires a check named
 * exactly `build`, and a Skipped check would satisfy it without running.
 */
const wf: any = Bun.YAML.parse(readFileSync('.github/workflows/build.yml', 'utf8'));
const PARTS = ['build-checks', 'build-unit-tests', 'build-next'] as const;
const stepNames = (id: string): string[] => wf.jobs[id].steps.map((s: any) => s.name ?? s.uses ?? s.run);

describe('build job split', () => {
  test('`build` is an aggregator over the three parts with no name override', () => {
    const agg = wf.jobs.build;
    expect(agg.name).toBeUndefined();
    expect([...agg.needs].sort()).toEqual([...PARTS].sort());
    // always(): a failed or cancelled part must turn `build` red, never Skipped.
    expect(agg.if).toContain('always()');
    const run = agg.steps.map((s: any) => s.run ?? '').join('\n');
    for (const p of PARTS) expect(run).toContain(`needs.${p}.result`);
    expect(run).toContain('success');
    expect(run).toContain('exit 1');
  });

  test('unit tests are a matrix of shards that does not cancel itself, and `build` needs all of it', () => {
    const unit = wf.jobs['build-unit-tests'];
    const shards: number[] = unit.strategy.matrix.shard;
    expect(shards.length).toBeGreaterThan(1);
    // A failed shard must not cancel the rest: their failures would go unreported.
    expect(unit.strategy['fail-fast']).toBe(false);
    // `needs` on a matrix job waits for every shard, and its result is success
    // only when all of them succeeded; the aggregator checks exactly that.
    expect(wf.jobs.build.needs).toContain('build-unit-tests');
    const run = wf.jobs.build.steps.map((s: any) => s.run ?? '').join('\n');
    expect(run).toContain('needs.build-unit-tests.result');
    expect(run).toMatch(/\[ "\$\{r#\*=\}" = "success" \] \|\| failed=1/);
  });

  test('every shard uploads its .test-report.log, pass or fail', () => {
    const steps = wf.jobs['build-unit-tests'].steps;
    const upload = steps.find((s: any) => String(s.uses ?? '').startsWith('actions/upload-artifact'));
    expect(upload).toBeDefined();
    expect(upload.if).toBe('always()');
    expect(upload.with.path).toBe('.test-report.log');
    expect(upload.with.name).toContain('${{ matrix.shard }}');
  });

  test('selection runs after install (the graph resolves through node_modules) and feeds the shard', () => {
    const steps = wf.jobs['build-unit-tests'].steps;
    const install = steps.findIndex((s: any) => s.run === 'bun install');
    const detect = steps.findIndex((s: any) => s.name === 'Detect affected tests');
    expect(install).toBeLessThan(detect);
    expect(steps[detect].run).toContain('scripts/affected-tests.ts');
    const tests = steps.find((s: any) => s.name === 'Run tests');
    expect(tests.run).toContain('--shard "${{ matrix.shard }}/');
    expect(tests.env.TESTS).toBe('${{ steps.affected.outputs.tests }}');
  });

  test('no part is skippable at job level', () => {
    for (const p of PARTS) expect(wf.jobs[p].if).toBeUndefined();
  });

  test('every original gate still runs in exactly one part', () => {
    const gates = [
      'Lint workflow name fields',
      'Lint specs (frontmatter + dead paths + index)',
      'Check design drift',
      'Check UI copy (AI-voice ratchet)',
      'Lint public docs boundary (design stubs only)',
      'Verify env contract (buildd env verify)',
      'Check migrations are up to date',
      'Notify on migration check failure',
      'Lint migration journal ordering',
      'Lint hardcoded model IDs',
      'Lint hand-built SQL',
      'Type check',
      'Detect affected tests',
      'Run tests',
      'Build @builddai/ai-kit dist and import it on Node',
      'Install @builddai/ai-kit into a clean consumer project',
      'Build',
    ];
    const all = PARTS.flatMap(stepNames);
    for (const g of gates) expect({ g, n: all.filter((n) => n === g).length }).toEqual({ g, n: 1 });
  });

  test('each part checks out with full history and installs once', () => {
    for (const p of PARTS) {
      const steps = wf.jobs[p].steps;
      expect(steps[0].uses).toContain('actions/checkout');
      expect(steps[0].with['fetch-depth']).toBe(0);
      expect(steps.filter((s: any) => s.run === 'bun install').length).toBe(1);
    }
  });

  test('the type check covers what next build skipped: route types first, same tsconfig', () => {
    const steps = wf.jobs['build-checks'].steps;
    const typegen = steps.findIndex((s: any) => String(s.run ?? '').includes('next typegen'));
    const tc = steps.findIndex((s: any) => s.name === 'Type check');
    expect(typegen).toBeGreaterThan(-1);
    expect(typegen).toBeLessThan(tc);
    expect(steps[tc].run).toBe('bun run type-check');
  });

  test('only the CI Next build skips its type check, and the type check job gates `build`', () => {
    const build = wf.jobs['build-next'].steps.find((s: any) => s.name === 'Build');
    expect(build.env.CI_TYPECHECK_DONE).toBe('1');
    expect(wf.jobs.build.needs).toContain('build-checks');
  });

  test('.next/cache and the tsbuildinfo are cached', () => {
    const paths = (id: string) =>
      wf.jobs[id].steps
        .filter((s: any) => String(s.uses ?? '').startsWith('actions/cache'))
        .map((s: any) => s.with.path);
    expect(paths('build-next').join('\n')).toContain('apps/web/.next/cache');
    expect(paths('build-checks').join('\n')).toContain('apps/web/tsconfig.tsbuildinfo');
  });
});

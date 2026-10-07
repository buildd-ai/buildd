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

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

const wf: any = Bun.YAML.parse(readFileSync('.github/workflows/build.yml', 'utf8'));
const job = wf.jobs['db-architecture'];
const steps: any[] = job.steps;

describe('db-architecture dedupe on release PRs', () => {
  test('job name states which ref is under test', () => {
    expect(job.name).toContain("'merge ref'");
    expect(job.name).toContain("'branch HEAD'");
  });

  test('job is never skipped at job level (skipped would satisfy branch protection)', () => {
    expect(job.if).toBeUndefined();
  });

  test('dedupe step is limited to same-repo dev-head PRs and compares trees', () => {
    const d = steps.find((s) => s.id === 'dedupe');
    expect(d.if).toContain("github.head_ref == 'dev'");
    expect(d.if).toContain('pull_request');
    expect(d.run).toContain('HEAD^2');
    expect(d.run).toContain('event=push');
  });

  test('every expensive step is gated on the dedupe output; checkout is not', () => {
    const gated = steps.filter((s) => String(s.if ?? '').includes('steps.dedupe.outputs.redundant'));
    const names = gated.map((s) => s.name ?? s.run ?? s.uses);
    expect(names).toContain('Run DB architecture tests');
    expect(names).toContain('Migrate');
    expect(steps[0].uses).toContain('actions/checkout');
    expect(steps[0].if).toBeUndefined();
  });

  test('needs actions: read to look up the push run', () => {
    expect(job.permissions.actions).toBe('read');
  });
});

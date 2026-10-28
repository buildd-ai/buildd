import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

const wf: any = Bun.YAML.parse(readFileSync('.github/workflows/build.yml', 'utf8'));
const job = wf.jobs['db-architecture'];
const plan = wf.jobs['db-architecture-plan'];
const shards = wf.jobs['db-architecture-shards'];
const planSteps: any[] = plan.steps;

describe('db-architecture dedupe on release PRs', () => {
  test('the aggregate keeps the check name and states which ref is under test', () => {
    expect(job.name).toStartWith('DB architecture (real Postgres) · ');
    expect(job.name).toContain("'merge ref'");
    expect(job.name).toContain("'branch HEAD'");
  });

  test('the aggregate is never skipped for a plan or shard outcome (skipped would satisfy branch protection)', () => {
    // Only a cancelled part (a superseded dev push) leaves it unrun, as the
    // single job used to read: cancelled, not green.
    expect(job.if).toBe("always() && !contains(needs.*.result, 'cancelled')");
    expect(job.needs).toEqual(['db-architecture-plan', 'db-architecture-shards']);
  });

  test('the aggregate step is a summary gate, so red-check analysis names the shard', () => {
    expect(job.steps).toHaveLength(1);
    expect(job.steps[0].name).toMatch(/^All\b.*\bpassed$/);
    expect(job.steps[0].run).toContain('"$SHARDS" != "success"');
    expect(job.steps[0].run).toContain('"$SHARDS" = "skipped"');
  });

  test('dedupe step is limited to same-repo dev-head PRs and compares trees', () => {
    const d = planSteps.find((s) => s.id === 'dedupe');
    expect(d.if).toContain("github.head_ref == 'dev'");
    expect(d.if).toContain('pull_request');
    expect(d.run).toContain('HEAD^2');
    expect(d.run).toContain('event=push');
    expect(d.run).toContain('startswith("DB architecture (real Postgres)")');
  });

  test('a redundant run and the path filter both decide through the plan, and the shards obey it', () => {
    const decide = planSteps.find((s) => s.id === 'decide');
    expect(decide.env.REDUNDANT).toContain('steps.dedupe.outputs.redundant');
    expect(decide.run).toContain('scripts/ci/db-tests-needed.ts');
    expect(shards.needs).toBe('db-architecture-plan');
    expect(shards.if).toBe("needs.db-architecture-plan.outputs.run == 'true'");
    const names = shards.steps.map((s: any) => s.name ?? s.run ?? s.uses);
    expect(names).toContain('Run DB architecture tests');
    expect(names).toContain('Migrate');
    expect(names).toContain('Run spec acceptance tests (real Postgres)');
  });

  test('spec acceptance runs on one shard only', () => {
    const step = shards.steps.find((s: any) => s.name === 'Run spec acceptance tests (real Postgres)');
    expect(step.if).toBe('matrix.shard == 1');
    expect(step['continue-on-error']).toBe(true);
  });

  test('a dev push supersedes its shards; PR runs never cancel each other here', () => {
    expect(shards.concurrency.group).toContain("github.event_name == 'push' && github.ref || github.run_id");
    expect(shards.concurrency.group).toContain('matrix.shard');
    expect(shards.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'push' }}");
  });

  test('the plan needs actions: read to look up the push run', () => {
    expect(plan.permissions.actions).toBe('read');
  });
});

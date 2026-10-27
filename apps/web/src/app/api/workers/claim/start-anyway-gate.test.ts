import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { depsGate, dependenciesSatisfied } from './deps-gate';

// Start anyway (spec 36df686b r1): the claim predicate. Rendered SQL here; the
// builder also adds real-Postgres coverage under apps/web/tests/db because the
// claim predicate changes (spec: "real SQL evaluation").
const dialect = new PgDialect();
const render = (frag: ReturnType<typeof depsGate>) => dialect.sqlToQuery(frag).sql.replace(/\s+/g, ' ').trim();

describe('Start anyway: claim dependency gate', () => {
  it('AC-8: an unexpired human intent naming a declared edge admits the dependent for assessment', () => {
    const text = render(dependenciesSatisfied());
    expect(text).toContain(`"tasks"."context"->'forceStart'->'assessDependsOn' ? (dep_id::uuid)::text`);
    expect(text).toContain(`"tasks"."context"->'forceStart'->>'expiresAt'`);
  });

  it('R-3: the permanent global dependency bypass is gone; only the bounded intent remains', () => {
    const q = dialect.sqlToQuery(depsGate());
    expect(q.sql).not.toContain('bypassDepsGate');
    expect(q.params).not.toContain('bypassDepsGate');
  });

  it('AC-18: a claim without human intent still waits on an unfinished declared dependency', () => {
    const text = render(depsGate());
    // Satisfaction arms stay: the status arm is still required for every edge not named by an intent.
    expect(text.startsWith('(')).toBe(true);
    expect(text).toContain('NOT EXISTS');
    expect(text).toContain('t2.status IN');
    // The admission is conjunctive with the intent naming this exact edge, never an unconditional OR.
    expect(text).toMatch(/assessDependsOn' \? \(dep_id::uuid\)::text, FALSE\)/);
  });

  it('R-16: the intent never flips the edge to satisfied for automatic release (dependency_releases and status arms unchanged)', () => {
    const text = render(dependenciesSatisfied());
    expect(text).toContain('dependency_releases');
    expect(text).toContain("'assessDependsOn'");
    // Admission for assessment is a separate arm from satisfaction.
    expect(text).not.toMatch(/t2\.status IN \(\$\d+, \$\d+, \$\d+\)/);
  });
});

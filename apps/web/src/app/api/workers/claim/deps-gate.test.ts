import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DEP_SATISFYING_STATUSES, dependenciesSatisfied, dependencySatisfied, depsGate } from './deps-gate';
import { sql } from 'drizzle-orm';
import {
  DEP_SATISFYING_STATUSES as CONTRACT_STATUSES,
  DEP_UNBLOCKING_PR_LIFECYCLE,
  EARLY_RELEASE_SATISFYING_DECISIONS,
} from '@/lib/dep-gate-contract';

// The claim dependency gate is SQL-filtered in Postgres; `dependenciesSatisfied()`
// builds its `status IN (...)` list directly from DEP_SATISFYING_STATUSES, so this
// constant is the executable contract for which dependency statuses unblock a
// dependent task. (We assert the constant rather than rendering the SQL because
// the co-located route test globally mocks `drizzle-orm`, which would break any
// real SQL rendering during a full `bun test` run.)
describe('claim dependency gate — satisfying statuses', () => {
  const statuses = [...DEP_SATISFYING_STATUSES] as string[];

  it('treats a cancelled dependency as satisfied (non-blocking)', () => {
    // Regression: a pending task whose only dep is cancelled must become claimable.
    expect(statuses).toContain('cancelled');
  });

  it('treats a completed dependency as satisfied', () => {
    expect(statuses).toContain('completed');
  });

  it('does NOT treat a failed dependency as satisfied (still blocks)', () => {
    expect(statuses).not.toContain('failed');
  });

  it('does NOT treat pending / in_progress deps as satisfied (still block)', () => {
    expect(statuses).not.toContain('pending');
    expect(statuses).not.toContain('in_progress');
  });

  it('only completed and cancelled satisfy the gate — nothing else', () => {
    expect(statuses.sort()).toEqual(['cancelled', 'completed']);
  });
});

// docs/design/early-release.md "Data model": a dependency_releases row with one
// of these decisions unblocks a dependent ahead of the upstream's own status/PR
// state. `wait` is a recorded decision to keep the gate closed, not a release.
describe('early release — satisfying decisions', () => {
  const decisions = [...EARLY_RELEASE_SATISFYING_DECISIONS] as string[];

  it('treats start_now and start_stacked as satisfying', () => {
    expect(decisions).toContain('start_now');
    expect(decisions).toContain('start_stacked');
  });

  it('does NOT treat wait as satisfying', () => {
    expect(decisions).not.toContain('wait');
  });

  it('only start_now and start_stacked satisfy — nothing else', () => {
    expect(decisions.sort()).toEqual(['start_now', 'start_stacked']);
  });
});

// The open-PR guard in `dependenciesSatisfied()` also checks pr_lifecycle_status:
// a worker whose PR was closed without merging (prLifecycleStatus = 'closed')
// must NOT permanently block the dependent. The behavioural coverage lives in
// the path-overlap claim guard tests in route.test.ts, which mock out SQL and
// exercise the in-memory filtering of closed PRs before findBlockingPr() is called.

// ─── The emitted SQL ─────────────────────────────────────────────────────────
//
// The constant assertions above are the only thing that used to guard this
// module, and they left the entire SQL body unmeasured: flipping
// `w.merged_at IS NULL` to `IS NOT NULL`, turning the outer `NOT EXISTS` into
// `EXISTS`, or scoping the open-PR guard to `cancelled` instead of `completed`
// all kept the file green. Each of those is a total inversion of the gate —
// either every dependent task claims immediately (the 6-overlapping-PR burst,
// PRs #1044-1049) or none of them ever claims again.
//
// Rendering the fragment through PgDialect is safe here despite the note above
// about the route test mocking `drizzle-orm`: `bun test` runs one process per
// file (scripts/run-unit-tests.ts), so that mock cannot reach this file.

const dialect = new PgDialect();

/**
 * Render the gate to SQL text, strip the `--` explanatory comments (they quote
 * the very predicates under test, so a substring assertion would otherwise pass
 * on the prose alone) and collapse whitespace.
 */
function renderGate(): string {
  const { sql: text } = dialect.sqlToQuery(dependenciesSatisfied());
  return text
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderParams(): unknown[] {
  return dialect.sqlToQuery(dependenciesSatisfied()).params;
}

describe('dependenciesSatisfied() — emitted SQL', () => {
  it('is a NOT EXISTS over the task\'s own depends_on array', () => {
    // `EXISTS` instead of `NOT EXISTS` inverts the gate wholesale: tasks with
    // unsatisfied deps become the only claimable ones.
    const text = renderGate();
    expect(text.startsWith('NOT EXISTS (')).toBe(true);
    expect(text).toContain('jsonb_array_elements_text("tasks"."depends_on"::jsonb)');
    // Each dep id must be correlated to the dependency row it names.
    expect(text).toContain('t2.id = dep_id::uuid');
  });

  it('binds exactly the contract statuses to the IN (...) list', () => {
    // The status list is a bound-param list, so the constant assertions above
    // never proved it reached the query. Params are positional: the satisfying
    // statuses first, then the unblocking PR lifecycle, then the early-release
    // decisions.
    expect(renderGate()).toMatch(/t2\.status IN \(\$1, \$2\)/);
    expect(renderParams()).toEqual([
      ...CONTRACT_STATUSES,
      DEP_UNBLOCKING_PR_LIFECYCLE,
      ...EARLY_RELEASE_SATISFYING_DECISIONS,
    ]);
  });

  it('applies the open-PR guard ONLY to completed deps', () => {
    // Scoped to `cancelled` instead, a cancelled dep with any open PR would
    // block forever while a completed dep with an open PR would stop blocking —
    // exactly the burst the guard was added to prevent.
    expect(renderGate()).toMatch(/AND NOT \( t2\.status = 'completed' AND EXISTS \(/);
  });

  it('treats only an unmerged, still-open PR as blocking', () => {
    const text = renderGate();
    // A dep whose worker has no PR at all must not block.
    expect(text).toContain('w.pr_url IS NOT NULL');
    // `IS NOT NULL` here would mean only MERGED PRs block — i.e. the guard
    // would hold dependents behind work that has already landed, forever.
    expect(text).toContain('w.merged_at IS NULL');
    // The blocking worker must belong to the dependency, not to any task.
    expect(text).toContain('w.task_id = t2.id');
  });

  it('releases the guard when the PR was closed without merging', () => {
    // `!=` → `=` would invert the escape hatch: only closed PRs would block and
    // genuinely open ones would sail through.
    expect(renderGate()).toMatch(/COALESCE\(w\.pr_lifecycle_status, ''\) != \$3/);
    expect(renderParams()[2]).toBe(DEP_UNBLOCKING_PR_LIFECYCLE);
  });

  it('re-exports the ONE contract definition, not a local copy', () => {
    expect(DEP_SATISFYING_STATUSES).toBe(CONTRACT_STATUSES);
  });
});

// docs/design/early-release.md "Data model": the per-dependency predicate also
// accepts a dependency_releases row. Additive — it OR's onto the existing
// completed/no-open-PR check (proved above), never replaces it, so this arm's
// own SQL shape is the only thing that needs new coverage.
describe('dependencySatisfied() — early-release arm (dependency_releases)', () => {
  it('ORs a dependency_releases EXISTS onto the completed/no-open-PR check', () => {
    // `AND` instead of `OR` here would mean a release row is only honoured
    // when the upstream is ALSO already completed with no open PR — i.e. no
    // actual early release, since that path was already satisfied on its own.
    const text = renderGate();
    expect(text).toMatch(/\)\s*OR EXISTS \(/);
    expect(text).toContain('SELECT 1 FROM "dependency_releases" dr');
  });

  it('correlates the release row to THIS dependent and THIS dependency, not any pairing', () => {
    // Both sides of the pairing are bound to the correlated identifiers already
    // in scope: upstream_task_id to the one dep_id this call is evaluating, and
    // dependent_task_id to the outer task row depends_on belongs to. A release
    // row for a different (dependent, upstream) pair cannot satisfy this EXISTS,
    // which is what makes a release scoped to one dependency leave a second,
    // non-released dependency on the same task still blocking — the same
    // per-element correlation the "same predicate" test below proves for the
    // status check.
    const text = renderGate();
    expect(text).toContain('dr.dependent_task_id = "tasks"."id"');
    expect(text).toContain('dr.upstream_task_id = dep_id::uuid');
  });

  it('binds exactly the early-release decisions to the IN (...) list', () => {
    expect(renderGate()).toMatch(/dr\.decision IN \(\$4, \$5\)/);
    expect(renderParams().slice(3)).toEqual([...EARLY_RELEASE_SATISFYING_DECISIONS]);
  });

  it('excludes a revoked release row', () => {
    // A revoked row (revoked_at set) must not satisfy the EXISTS — `IS NULL`
    // flipped to `IS NOT NULL` would mean only revoked releases unblock, and
    // dropping the condition entirely would mean a revoked release keeps
    // unblocking forever instead of restoring the gate.
    expect(renderGate()).toContain('dr.revoked_at IS NULL');
  });
});

// Friction cad81659: the route's deps gate was
//   depends_on IS NULL OR depends_on = '[]' OR context->>'bypassDepsGate' = 'true' OR <satisfied>
// and the bypass arm is NULL when the key is absent, so a task with an
// unsatisfied dependency evaluated to NULL, not FALSE. The claim excluded it
// (correctly) and the explicit-claim probe, reading NULL as "not evaluated",
// said "unknown". Verified against real Postgres; here the SQL shape pins it.
describe('depsGate(): two-valued', () => {
  const text = () => dialect.sqlToQuery(depsGate()).sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');

  it('coalesces the force-start bypass so a missing key is FALSE', () => {
    expect(text()).toMatch(/COALESCE\("tasks"\."context"->>\$\d+, ''\) = 'true'/);
    expect(dialect.sqlToQuery(depsGate()).params).toContain('bypassDepsGate');
    expect(text()).not.toMatch(/"tasks"\."context"->>'bypassDepsGate' = 'true'/);
  });

  it('keeps the no-deps and empty-deps escapes and the satisfied check', () => {
    const t = text();
    expect(t).toContain('"tasks"."depends_on" is null');
    expect(t).toContain(`"tasks"."depends_on"::jsonb = '[]'::jsonb`);
    expect(t).toContain('jsonb_array_elements_text("tasks"."depends_on"::jsonb)');
  });
});

describe('dependencySatisfied(depId): the per-dependency predicate', () => {
  it('is the same predicate the whole-array gate applies to each element', () => {
    const one = dialect.sqlToQuery(dependencySatisfied(sql`dep_id::uuid`)).sql;
    expect(renderGate()).toContain(one.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim());
  });
});

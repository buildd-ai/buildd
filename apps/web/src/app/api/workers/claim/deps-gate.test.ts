import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DEP_SATISFYING_STATUSES, dependenciesSatisfied } from './deps-gate';
import {
  DEP_SATISFYING_STATUSES as CONTRACT_STATUSES,
  DEP_UNBLOCKING_PR_LIFECYCLE,
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
    // statuses first, then the unblocking PR lifecycle.
    expect(renderGate()).toMatch(/t2\.status IN \(\$1, \$2\)/);
    expect(renderParams()).toEqual([...CONTRACT_STATUSES, DEP_UNBLOCKING_PR_LIFECYCLE]);
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

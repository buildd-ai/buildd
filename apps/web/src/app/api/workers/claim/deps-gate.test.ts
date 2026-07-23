import { describe, it, expect } from 'bun:test';
import { DEP_SATISFYING_STATUSES } from './deps-gate';

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

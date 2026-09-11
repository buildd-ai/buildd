import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// ── Why this file exists separately from initiative-pulse.test.ts ────────────
//
// That file stubs `drizzle-orm` itself, which makes every SQL fragment an
// opaque `{ strings, values }` object — and therefore makes the *predicates*
// unobservable. The whole bug this file guards was a missing predicate: one
// aggregate in `loadInitiativeVerdictInputs` counted failing criteria across
// EVERY mission while the aggregate on the adjacent line excluded closed ones,
// so a single mission that failed a criterion once and then completed pinned
// its initiative at `losing` forever.
//
// So here `drizzle-orm` and the schema are REAL and only `db` is mocked: the
// select fields are captured and rendered with PgDialect, which is the only way
// an assertion can see a filter that is or is not there.

const dialect = new PgDialect();
function render(frag: unknown): string {
  return dialect.sqlToQuery(frag as never).sql.replace(/\s+/g, ' ').trim();
}

let capturedSelects: Array<Record<string, unknown>> = [];

const mockSelect = mock((fields?: Record<string, unknown>) => {
  if (fields) capturedSelects.push(fields);
  const chain: Record<string, unknown> = {};
  const rows: unknown[] = [];
  chain.from = () => chain;
  chain.innerJoin = () => chain;
  chain.leftJoin = () => chain;
  chain.where = () => chain;
  chain.groupBy = () => chain;
  chain.orderBy = () => chain;
  chain.limit = () => chain;
  // Thenable: the loader awaits some of these chains directly and calls
  // `.groupBy(...)` on others before awaiting.
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  chain.catch = (reject: (e: unknown) => unknown) => Promise.resolve(rows).catch(reject);
  return chain;
});

mock.module('@buildd/core/db', () => ({ db: { select: mockSelect } }));

import { loadInitiativeVerdictInputs } from './initiative-pulse';

/** The captured field map of the child-mission rollup query. */
async function missionRollupFields(): Promise<Record<string, unknown>> {
  await loadInitiativeVerdictInputs({ teamId: 'team-1' });
  const fields = capturedSelects.find((f) => 'criteriaFail' in f);
  expect(fields).toBeDefined();
  return fields!;
}

/** The status list inside a `NOT IN (...)` filter, or null when there is none. */
function excludedStatuses(fragment: string): string | null {
  return fragment.match(/not in \(([^)]*)\)/i)?.[1] ?? null;
}

describe('loadInitiativeVerdictInputs — the criteriaFail aggregate', () => {
  beforeEach(() => {
    capturedSelects = [];
  });

  it('excludes closed missions, so a completed mission cannot pin an arc at losing', async () => {
    const fields = await missionRollupFields();
    const failSql = render(fields.criteriaFail);

    expect(failSql).toMatch(/'fail'/);
    // The regression: this aggregate had no mission-status filter at all.
    expect(excludedStatuses(failSql)).not.toBeNull();
    expect(failSql.toLowerCase()).toContain('completed');
    expect(failSql.toLowerCase()).toContain('archived');
  });

  it('excludes exactly the statuses openMissions excludes — the two MUST NOT diverge', async () => {
    const fields = await missionRollupFields();

    // `openMissions` is the reference: `allTerminal` and `criteriaFail` are read
    // by adjacent rungs of the same ladder, so a mission that is terminal for
    // one and open for the other is a contradiction, not a nuance.
    expect(excludedStatuses(render(fields.criteriaFail))).toBe(
      excludedStatuses(render(fields.openMissions)),
    );
  });

  it('leaves verifiedMissions unfiltered — confidence asks whether anything ever checked', async () => {
    const fields = await missionRollupFields();

    // Deliberate asymmetry. `criteriaFail` feeds "are we losing *now*", which a
    // closed mission cannot answer; `verifiedMissions` feeds "did anything check
    // this outcome", which a closed mission answers permanently.
    expect(excludedStatuses(render(fields.verifiedMissions))).toBeNull();
  });

  it('reports when the last mission closed, so a KPI verdict can be dated against it', async () => {
    const fields = await missionRollupFields();
    expect(fields.lastMissionClosedAt).toBeDefined();

    const closedSql = render(fields.lastMissionClosedAt).toLowerCase();
    expect(closedSql).toContain('max');
    expect(closedSql).toContain('completed');
  });

  it('reads the KPI evaluation timestamp alongside the KPI verdict', async () => {
    await loadInitiativeVerdictInputs({ teamId: 'team-1' });
    const initiativeFields = capturedSelects.find((f) => 'kpiOverall' in f);
    expect(initiativeFields).toBeDefined();
    expect(initiativeFields!.kpiEvaluatedAt).toBeDefined();
    expect(render(initiativeFields!.kpiEvaluatedAt)).toMatch(/evaluatedAt/);
  });
});

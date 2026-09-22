import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { getTableColumns, getTableName } from 'drizzle-orm';

/**
 * Scope tests for the readout's cohort filters.
 *
 * WHY THESE ASSERTIONS RENDER SQL INSTEAD OF INSPECTING CALLS
 * ----------------------------------------------------------
 * An aggregation over the wrong cohort is the exact failure this readout
 * exists to prevent, and it is invisible to a test that mocks `db`: under a
 * mocked client the predicate builders return opaque objects, so which COLUMN
 * a filter is keyed on cannot be observed at all. A test could then prove the
 * arithmetic is right while the rows it ran on were pooled across policy
 * versions — which is precisely the contaminated analysis, reproduced by a
 * green test suite.
 *
 * So: no `drizzle-orm` mock and no `./db/schema` mock here (which rules out the
 * shared `_db-mock`, since it stubs the schema). Only the db *client* is
 * stubbed — nothing in this file executes a query — which lets the real drizzle
 * builders run and the real `PgDialect` render them to SQL text. Same technique
 * as `apps/web/src/lib/stale-workers-scope.test.ts`.
 */
/**
 * A stateful stand-in for the db client.
 *
 * Deliberately NOT a query engine: the WHERE clauses stay opaque here, which is
 * exactly why the scope tests above render them to SQL instead. What this fake
 * DOES model is the one thing a scope render cannot show — that
 * `ON CONFLICT (workspace_id, key) DO UPDATE` applied twice with the same key
 * leaves ONE row. It derives the conflict key from the target columns the
 * caller actually passed, so a target naming the wrong columns changes what
 * this fake collides on, and `artifacts_workspace_key_idx` is asserted
 * separately against the schema.
 */
interface FakeOp {
  op: string;
  arg?: any;
}

interface FakeState {
  /** Rows of `artifacts`, keyed by the conflict target the upsert declared. */
  artifactRows: Map<string, Record<string, any>>;
  /** INSERT statements that created a row, vs ones that updated one. */
  inserts: number;
  updates: number;
  /** Rows the next non-join SELECT on `artifacts` returns. */
  artifactSelect: Record<string, any>[];
  /** Rows the next joined SELECT (the modal-workspace query) returns. */
  joinSelect: Record<string, any>[];
  /** Rows the next SELECT on `system_cache` returns. */
  cacheSelect: Record<string, any>[];
  /** Whether the next claim insert wins the race. */
  claimWins: boolean;
  /** Every recorded statement, for asserting query SHAPE (joins, ordering). */
  statements: FakeOp[][];
}

const fake: FakeState = {
  artifactRows: new Map(),
  inserts: 0,
  updates: 0,
  artifactSelect: [],
  joinSelect: [],
  cacheSelect: [],
  claimWins: true,
  statements: [],
};

function resetFake(): void {
  fake.artifactRows.clear();
  fake.inserts = 0;
  fake.updates = 0;
  fake.artifactSelect = [];
  fake.joinSelect = [];
  fake.cacheSelect = [];
  fake.claimWins = true;
  fake.statements.length = 0;
}

mock.module('../db', () => {
  /** Map a column's DB name back to the object property `values()` uses. */
  function propFor(table: any, columnName: string): string | undefined {
    return Object.entries(getTableColumns(table)).find(
      ([, col]: [string, any]) => col.name === columnName,
    )?.[0];
  }

  function selectQuery(table: any) {
    const ops: FakeOp[] = [];
    fake.statements.push(ops);
    const builder: any = {
      then(resolve: any, reject: any) {
        const joined = ops.some(o => o.op === 'innerJoin');
        const name = getTableName(table);
        const rows =
          joined ? fake.joinSelect
          : name === 'artifacts' ? fake.artifactSelect
          : fake.cacheSelect;
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    for (const op of ['from', 'innerJoin', 'where', 'groupBy', 'orderBy', 'limit']) {
      builder[op] = (...args: any[]) => {
        ops.push({ op, arg: args.length > 1 ? args : args[0] });
        return builder;
      };
    }
    return builder;
  }

  return {
    db: {
      select: () => ({
        from: (table: any) => selectQuery(table).from(table),
      }),
      insert: (table: any) => ({
        values: (values: any) => {
          const name = getTableName(table);
          const applyUpsert = (target: any[], set: any) => {
            const cols = (Array.isArray(target) ? target : [target]) as any[];
            const conflictKey = cols
              .map(col => String(values[propFor(table, col.name) ?? col.name]))
              .join('|');
            const existing = fake.artifactRows.get(conflictKey);
            if (existing) {
              Object.assign(existing, set);
              fake.updates += 1;
              return existing;
            }
            const row = { id: `art-${fake.artifactRows.size + 1}`, ...values };
            fake.artifactRows.set(conflictKey, row);
            fake.inserts += 1;
            return row;
          };
          return {
            onConflictDoUpdate: ({ target, set }: any) => {
              const row = name === 'artifacts' ? applyUpsert(target, set) : { ...values };
              const result: any = {
                returning: async () => [row],
                then: (resolve: any, reject: any) => Promise.resolve(undefined).then(resolve, reject),
              };
              return result;
            },
            onConflictDoNothing: () => ({
              returning: async () => (fake.claimWins ? [{ key: values.key }] : []),
            }),
          };
        },
      }),
    },
  };
});

import * as source from '../memory-digest-readout-source';
import {
  boundArtifactWorkspaceId,
  claimVerdictNotification,
  cohortWorkspaceScope,
  compositionCohortScope,
  deliveredVerdictScope,
  findDeliveredVerdict,
  guardrailWindowScope,
  modalCohortWorkspaceId,
  notifiedKey,
  readoutArtifactKey,
  readoutArtifactScope,
  resolveReadoutArtifactWorkspaceId,
  sessionScope,
  upsertReadoutArtifact,
  READOUT_ARTIFACT_CONFLICT_TARGET,
  READOUT_ARTIFACT_KEY_PREFIX,
  READOUT_ARTIFACT_TYPE,
  READOUT_CACHE_KEY,
  READOUT_NOTIFIED_KEY_PREFIX,
  READOUT_WORKSPACE_ENV,
  RECALL_TOOL,
} from '../memory-digest-readout-source';
import { artifacts } from '../db/schema';
import {
  DESIGN_MDE,
  READOUT_POLICY_VERSION,
  computeReadout,
  formatReadoutText,
  requiredNPerArm,
  terminalNotificationKeys,
} from '../memory-digest-readout';
import { ARTIFACT_TYPES } from '@buildd/shared';

const dialect = new PgDialect();

/** Rendered SQL, whitespace-collapsed and lower-cased (meaning, not phrasing). */
function render(fragment: any): string {
  return dialect.sqlToQuery(fragment).sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

const TASK_IDS = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];

// ── Fixtures for the stateful half ──────────────────────────────────────────

beforeEach(() => {
  resetFake();
  // The placement override is read from the environment, so it has to be
  // cleared or one test's placement silently decides the next one's.
  delete process.env[READOUT_WORKSPACE_ENV];
});

const BOUNDARY = new Date('2026-01-15T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/**
 * A readout built by the REAL `computeReadout` from synthetic rows, so the
 * artifact is written from exactly the shape production hands it.
 */
function readout(kind: 'accruing' | 'powered'): ReturnType<typeof computeReadout> {
  const perArm = kind === 'powered' ? requiredNPerArm(DESIGN_MDE) : 3;
  const composition: any[] = [];
  const sessions: any[] = [];
  let n = 0;
  for (const era of [
    { base: new Date(BOUNDARY.getTime() - 10 * HOUR), marker: false },
    { base: BOUNDARY, marker: true },
  ]) {
    for (const arm of ['full', 'task_scoped'] as const) {
      for (let i = 0; i < perArm; i++) {
        const taskId = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
        const jitter = (i % 5) - 2;
        composition.push({
          taskId,
          workerId: `w-${n}`,
          buildIndex: 0,
          ts: new Date(era.base.getTime() + i * 1000),
          policyVersion: READOUT_POLICY_VERSION,
          arm,
          taskMatchDerivedBy: era.marker && i % 2 === 0 ? 'inferred_paths' : 'no_match',
          backend: 'claude',
          promptBytes: 10_000 + jitter * 100,
          memoryBlockBytes: 2_000,
          digestBytes: 2_000,
          digestBytesAvailable: 2_000,
          memoryShare: 0.2 + jitter * 0.001,
        });
        sessions.push({
          taskId,
          workerId: `w-${n}`,
          status: 'completed',
          turns: 10 + jitter,
          durationMs: 60_000 + jitter * 500,
          readCalls: 5 + jitter,
          shellCalls: 5 + jitter,
          calledRecall: false,
        });
      }
    }
  }
  return computeReadout({
    composition,
    sessions,
    policyVersion: READOUT_POLICY_VERSION,
    now: new Date(BOUNDARY.getTime() + 2 * HOUR),
  });
}


describe('compositionCohortScope', () => {
  const sql = render(compositionCohortScope('memory-digest-v4'));

  it('filters on policy_version — the predicate that must never be missing', () => {
    // Pooling two policy versions is not a noisier comparison, it is a
    // meaningless one: a bump redefines the arms AND re-randomises assignment.
    expect(sql).toContain('"policy_version"');
    expect(sql).toMatch(/"policy_version" = \$\d/);
  });

  it('reads from the prompt-composition table and nothing else', () => {
    expect(sql).toContain('worker_prompt_composition_events');
    expect(sql).not.toContain('worker_action_events');
    expect(sql).not.toContain('"workers"');
  });

  it('drops builds with no task id rather than counting them as observations', () => {
    expect(sql).toContain('"task_id" is not null');
  });

  it('does NOT filter backend in SQL — the exclusion has to stay countable', () => {
    // Segmented in the pure layer instead, so "how many rows had no backend
    // recorded" is a number on the readout rather than rows that vanished.
    expect(sql).not.toContain('"backend"');
  });

  it('binds the policy version as a parameter, never interpolated', () => {
    const { params } = dialect.sqlToQuery(compositionCohortScope('memory-digest-v4') as any);
    expect(params).toContain('memory-digest-v4');
    expect(render(compositionCohortScope('memory-digest-v4'))).not.toContain('memory-digest-v4');
  });
});

describe('guardrailWindowScope', () => {
  const start = new Date('2026-09-15T00:00:00.000Z');
  const now = new Date('2026-09-22T00:00:00.000Z');
  const sql = render(guardrailWindowScope(start, now, 'memory-digest-v4'));

  it('scopes to the shipped arm only, not the pre-flip randomised cohort', () => {
    expect(sql).toContain('"arm" = $');
    expect(sql).toContain('"propensity" = $');
    const { params } = dialect.sqlToQuery(guardrailWindowScope(start, now, 'memory-digest-v4') as any);
    expect(params).toContain('task_scoped');
    // Bound as '1', matching the shipped, unconditional-rendering rows — a
    // pre-flip randomised row (propensity 0.5) can never match this.
    expect(params).toContain('1');
  });

  it('bounds the window on both ends', () => {
    expect(sql).toMatch(/"ts" >= \$\d/);
    expect(sql).toMatch(/"ts" <= \$\d/);
  });

  it('still requires a task id and the given policy version, like the readout cohort', () => {
    expect(sql).toContain('"task_id" is not null');
    expect(sql).toContain('"policy_version" = $');
  });

  it('does NOT filter backend in SQL — same segmentation discipline as compositionCohortScope', () => {
    expect(sql).not.toContain('"backend"');
  });
});

describe('sessionScope', () => {
  const sql = render(sessionScope(TASK_IDS));

  it('scopes sessions to the cohort tasks', () => {
    expect(sql).toContain('"task_id" in');
    const { params } = dialect.sqlToQuery(sessionScope(TASK_IDS) as any);
    expect(params).toEqual(expect.arrayContaining(TASK_IDS));
  });

  it('excludes never-started workers, which would be fabricated observations', () => {
    // A never-started row is a claim-time bookkeeping artifact. Counted, it
    // adds a task with zero turns and zero reads to whichever arm it fell in.
    expect(sql).toContain('"started_at" is not null');
  });

  it('reads the workers table, not the event tables', () => {
    expect(sql).toContain('"task_id"');
    expect(sql).not.toContain('worker_prompt_composition_events');
  });
});

describe('recall is not sourced from worker_action_events', () => {
  it('exposes no action-table scope for recall, and names the tool it is counted under', () => {
    // `worker_action_events` records the bare action name off the `buildd` MCP
    // call. `recall` is a separate top-level tool, so it has never appeared
    // there — a scope filtering action='recall' returns zero rows in both arms
    // for ever and renders as a measured 0%. It is read off the session's tool
    // histogram instead, which keys on the fully-qualified name.
    expect(source).not.toHaveProperty('recallScope');
    expect(RECALL_TOOL).toBe('mcp__buildd__recall');
    expect(RECALL_TOOL).toContain('mcp__');
  });
});

describe('persistence keys', () => {
  it('keeps the readout row and the notification claim on separate keys', () => {
    // One row is a record that gets overwritten every run; the other is a
    // once-ever claim. Sharing a key would make each destroy the other.
    expect(notifiedKey('memory-digest-v4:powered')).not.toBe(READOUT_CACHE_KEY);
    expect(notifiedKey('memory-digest-v4:powered')).toStartWith(READOUT_NOTIFIED_KEY_PREFIX);
  });

  it('gives distinct verdicts distinct claims, so each pages once on its own', () => {
    expect(notifiedKey('memory-digest-v4:powered')).not.toBe(notifiedKey('memory-digest-v4:stalled'));
  });
});

// ── Retirement lookup ───────────────────────────────────────────────────────

describe('deliveredVerdictScope', () => {
  const sql = render(deliveredVerdictScope('memory-digest-v4'));

  it('looks up the claim rows by primary key, not by scanning a prefix', () => {
    // This runs before the readout on every tick for the rest of the job's
    // life, so it has to be the cheapest possible query. A LIKE on the prefix
    // would be a scan.
    expect(sql).toContain('"key" in');
    expect(sql).not.toContain('like');
  });

  it('matches exactly the keys a terminal verdict claims, and no others', () => {
    const { params } = dialect.sqlToQuery(deliveredVerdictScope('memory-digest-v4') as any);
    const expected = terminalNotificationKeys('memory-digest-v4').map(notifiedKey);
    expect(params).toEqual(expect.arrayContaining(expected));
    expect(params).toHaveLength(expected.length);
    // Retiring on `accruing` would stop reading a live experiment; retiring on
    // `indeterminate` would stop reading a broken collection path.
    expect(params).not.toContain(notifiedKey('memory-digest-v4:accruing'));
    expect(params).not.toContain(notifiedKey('memory-digest-v4:indeterminate:no-rows'));
  });

  it('is scoped to one policy version — a new version un-retires the job', () => {
    const { params } = dialect.sqlToQuery(deliveredVerdictScope('memory-digest-v9') as any);
    for (const p of params as string[]) expect(p).toContain('memory-digest-v9');
  });
});

describe('findDeliveredVerdict', () => {
  it('returns null when no terminal verdict has been claimed', async () => {
    fake.cacheSelect = [];
    expect(await findDeliveredVerdict(READOUT_POLICY_VERSION)).toBeNull();
  });

  it('reads the status, the claim time and the artifact link off the claim row', async () => {
    fake.cacheSelect = [
      {
        key: notifiedKey(`${READOUT_POLICY_VERSION}:stalled`),
        value: {
          notificationKey: `${READOUT_POLICY_VERSION}:stalled`,
          claimedAt: '2026-03-01T07:00:00.000Z',
          artifactId: 'art-1',
          artifactUrl: 'https://buildd.dev/app/artifacts/art-1',
        },
      },
    ];
    const delivered = await findDeliveredVerdict(READOUT_POLICY_VERSION);
    expect(delivered).toEqual({
      notificationKey: `${READOUT_POLICY_VERSION}:stalled`,
      status: 'stalled',
      claimedAt: '2026-03-01T07:00:00.000Z',
      artifactId: 'art-1',
      artifactUrl: 'https://buildd.dev/app/artifacts/art-1',
    });
  });

  it('derives the status from the key when the row predates the stored label', async () => {
    // Rows claimed by the version of this job that shipped before the claim
    // carried details. The key is authoritative; a null status would make a
    // retired job look like it retired for no reason.
    fake.cacheSelect = [{ key: notifiedKey(`${READOUT_POLICY_VERSION}:powered`), value: {} }];
    const delivered = await findDeliveredVerdict(READOUT_POLICY_VERSION);
    expect(delivered?.status).toBe('powered');
    expect(delivered?.notificationKey).toBe(`${READOUT_POLICY_VERSION}:powered`);
    expect(delivered?.artifactUrl).toBeNull();
  });
});

describe('claimVerdictNotification', () => {
  it('still returns true exactly once — details do not weaken the claim', async () => {
    fake.claimWins = true;
    expect(await claimVerdictNotification('k', { status: 'powered' })).toBe(true);
    fake.claimWins = false;
    expect(await claimVerdictNotification('k', { status: 'powered' })).toBe(false);
  });

  it('claims with no details at all', async () => {
    expect(await claimVerdictNotification('k')).toBe(true);
  });
});

// ── The artifact ────────────────────────────────────────────────────────────

describe('readout artifact identity', () => {
  it('keys on the policy version, so a version bump does not overwrite a verdict', () => {
    expect(readoutArtifactKey('memory-digest-v4')).toBe(`${READOUT_ARTIFACT_KEY_PREFIX}memory-digest-v4`);
    expect(readoutArtifactKey('memory-digest-v4')).not.toBe(readoutArtifactKey('memory-digest-v5'));
  });

  it('uses a type from the one shared vocabulary', () => {
    // A type outside ARTIFACT_TYPES is rejected by every route that persists an
    // artifact, so an invented one would fail only in production.
    expect(ARTIFACT_TYPES).toContain(READOUT_ARTIFACT_TYPE as any);
    expect(READOUT_ARTIFACT_TYPE).toBe('analysis');
  });

  it('does not collide with the system_cache claim namespace', () => {
    expect(readoutArtifactKey('memory-digest-v4')).not.toStartWith(READOUT_NOTIFIED_KEY_PREFIX);
    expect(readoutArtifactKey('memory-digest-v4')).not.toBe(READOUT_CACHE_KEY);
  });

  it('scopes the lookup to the key column', () => {
    const sql = render(readoutArtifactScope('memory-digest-v4'));
    expect(sql).toMatch(/"key" = \$\d/);
    const { params } = dialect.sqlToQuery(readoutArtifactScope('memory-digest-v4') as any);
    expect(params).toContain(readoutArtifactKey('memory-digest-v4'));
  });
});

describe('the upsert conflict target IS the unique index', () => {
  it('names exactly the columns of artifacts_workspace_key_idx', () => {
    // If these diverge the "upsert" is either a duplicate row per run or a
    // statement that throws. Read from the schema so a change to either side
    // fails here rather than in production at 07:00.
    const uniqueIndexes = getTableConfig(artifacts as any).indexes.filter(i => i.config.unique);
    const keyIndex = uniqueIndexes.find(i => i.config.name === 'artifacts_workspace_key_idx');
    expect(keyIndex).toBeDefined();
    expect(keyIndex!.config.columns.map((c: any) => c.name)).toEqual(
      READOUT_ARTIFACT_CONFLICT_TARGET.map(c => c.name),
    );
  });

  it('targets a column set that is actually unique', () => {
    // ON CONFLICT can only infer from a unique index; a non-unique column list
    // is a runtime error, not a slower query.
    const names = READOUT_ARTIFACT_CONFLICT_TARGET.map(c => c.name).join(',');
    const unique = getTableConfig(artifacts as any)
      .indexes.filter(i => i.config.unique)
      .map(i => i.config.columns.map((c: any) => c.name).join(','));
    expect(unique).toContain(names);
  });
});

describe('artifact placement', () => {
  it('prefers the configured workspace', async () => {
    process.env[READOUT_WORKSPACE_ENV] = 'ws-configured';
    fake.artifactSelect = [{ workspaceId: 'ws-bound' }];
    fake.joinSelect = [{ workspaceId: 'ws-modal', builds: 9 }];
    expect(await resolveReadoutArtifactWorkspaceId(READOUT_POLICY_VERSION)).toBe('ws-configured');
  });

  it('otherwise stays where the artifact already is', async () => {
    // The modal workspace moves as rows accrue. A placement that followed it
    // would leave one stale artifact per workspace it passed through.
    fake.artifactSelect = [{ workspaceId: 'ws-bound' }];
    fake.joinSelect = [{ workspaceId: 'ws-modal', builds: 9 }];
    expect(await resolveReadoutArtifactWorkspaceId(READOUT_POLICY_VERSION)).toBe('ws-bound');
  });

  it('falls back to the cohort’s modal workspace on the very first run', async () => {
    fake.artifactSelect = [];
    fake.joinSelect = [{ workspaceId: 'ws-modal', builds: 9 }];
    expect(await resolveReadoutArtifactWorkspaceId(READOUT_POLICY_VERSION)).toBe('ws-modal');
  });

  it('resolves to null when nothing can place it, rather than throwing', async () => {
    fake.artifactSelect = [];
    fake.joinSelect = [];
    expect(await resolveReadoutArtifactWorkspaceId(READOUT_POLICY_VERSION)).toBeNull();
    expect(await upsertReadoutArtifact(readout('accruing'))).toBeNull();
    expect(fake.inserts).toBe(0);
  });

  it('reads the oldest row when resolving where the artifact already is', async () => {
    fake.artifactSelect = [{ workspaceId: 'ws-bound' }];
    await boundArtifactWorkspaceId(READOUT_POLICY_VERSION);
    const ops = fake.statements.at(-1)!;
    expect(render(ops.find(o => o.op === 'orderBy')!.arg)).toContain('"created_at" asc');
    expect(ops.find(o => o.op === 'limit')!.arg).toBe(1);
  });

  it('breaks a modal tie deterministically', async () => {
    fake.joinSelect = [{ workspaceId: 'ws-modal', builds: 3 }];
    await modalCohortWorkspaceId(READOUT_POLICY_VERSION);
    const ops = fake.statements.at(-1)!;
    expect(ops.some(o => o.op === 'innerJoin')).toBe(true);
    // A bare column, not an SQL fragment — assert the column it names.
    expect((ops.find(o => o.op === 'groupBy')!.arg as any).name).toBe('workspace_id');
    // Most builds first, then the lowest id — never scan order.
    const orderArg = ops.find(o => o.op === 'orderBy')!.arg;
    const order = (Array.isArray(orderArg) ? orderArg : [orderArg]).map(render).join(', ');
    expect(order).toContain('desc');
    expect(order).toContain('"workspace_id" asc');
  });

  it('counts only builds whose workspace is known', () => {
    const sql = render(cohortWorkspaceScope('memory-digest-v4'));
    expect(sql).toMatch(/"policy_version" = \$\d/);
    expect(sql).toContain('"workspace_id" is not null');
  });
});

describe('upsertReadoutArtifact', () => {
  it('publishes the full readout text under the keyed artifact', async () => {
    process.env[READOUT_WORKSPACE_ENV] = 'ws-1';
    const r = readout('accruing');
    const written = await upsertReadoutArtifact(r);
    expect(written).toEqual({
      id: 'art-1',
      workspaceId: 'ws-1',
      key: readoutArtifactKey(r.policyVersion),
      type: 'analysis',
    });
    const row = [...fake.artifactRows.values()][0];
    // The rendered report verbatim, not a summary: the artifact is what the
    // push links to, so it has to be the whole thing. Fenced, because the
    // artifact page renders content as markdown and the report is
    // column-aligned monospace.
    expect(row.content).toContain(formatReadoutText(r));
    expect(row.content.startsWith('```')).toBe(true);
    expect(row.content.endsWith('```')).toBe(true);
    expect(row.content).toContain('VERDICT:');
    expect(row.title).toContain(r.verdict.status);
    expect((row.metadata as any).verdict).toBe(r.verdict.status);
    expect((row.metadata as any).scope).toBe('fleet');
  });

  it('UPDATES on a second run instead of adding a second row', async () => {
    process.env[READOUT_WORKSPACE_ENV] = 'ws-1';
    const first = readout('accruing');
    const second = readout('powered');

    const a = await upsertReadoutArtifact(first);
    const b = await upsertReadoutArtifact(second);

    expect(fake.artifactRows.size).toBe(1);
    expect(fake.inserts).toBe(1);
    expect(fake.updates).toBe(1);
    // Same row, same id: the link in a notification stays valid.
    expect(b!.id).toBe(a!.id);
    const row = [...fake.artifactRows.values()][0];
    expect(row.content).toContain(formatReadoutText(second));
    expect(row.content).not.toContain(formatReadoutText(first));
    expect(row.title).toContain(second.verdict.status);
  });

  it('keeps a different policy version on its own row', async () => {
    process.env[READOUT_WORKSPACE_ENV] = 'ws-1';
    await upsertReadoutArtifact(readout('accruing'));
    await upsertReadoutArtifact({ ...readout('accruing'), policyVersion: 'memory-digest-v99' } as any);
    expect(fake.artifactRows.size).toBe(2);
    expect(fake.inserts).toBe(2);
  });

  it('collides on the columns it declared as the conflict target', async () => {
    process.env[READOUT_WORKSPACE_ENV] = 'ws-1';
    await upsertReadoutArtifact(readout('accruing'));
    process.env[READOUT_WORKSPACE_ENV] = 'ws-2';
    await upsertReadoutArtifact(readout('accruing'));
    // Two workspaces, same key: (workspace_id, key) is the unique index, so
    // these are genuinely two rows — and this is why the placement is sticky.
    expect(fake.artifactRows.size).toBe(2);
  });
});

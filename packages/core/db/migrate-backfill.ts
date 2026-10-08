// Backfill verification for db/migrate.ts.
//
// `planMigrations` splits untracked migrations into two piles: `toRun` (newer
// than the __drizzle_migrations high-water mark — safe to execute blind) and
// `toBackfill` (older, so a missing row *might* mean "applied but the tracking
// insert was lost"). The original backfill loop acted on that "might" alone: it
// inserted a tracking row and never once looked at `migration.sql`. When the
// migration had actually never run — which is confirmed to have happened in
// production for 0021/0022 via the journal `when` high-water-mark skip — the
// deploy exited 0, the drift gate logged `[pending]`, and `applied.has(...)`
// then skipped that migration forever. Silent, permanent schema loss.
//
// This module makes the backfill prove its claim: derive checkable assertions
// from the migration's own SQL, compare them against live introspection, and
// only record a tracking row when the DDL is observed to already be there.
// Anything else fails the run loudly.
//
// Deliberately NOT done here: re-running the SQL of a contradicted migration.
// That is the tasks_source_external_idx incident (PR #1288) — replaying old DDL
// against a schema that has since moved on crashes or corrupts. A contradiction
// is a human decision (write a reconciliation migration, as 0074 did).
//
// One narrow exception, for a throwaway CI database only: the Visual QA prod
// clone (see CI_CLONE_APPLY_ABSENT_ENV below). There a contradicted migration
// whose DDL is WHOLLY absent is a branch's own migration that prod has never
// seen, and executing it is the ordinary forward path. Partially present DDL
// is still refused: that is the replay case above.

/**
 * Set to `1` by .github/workflows/visual-qa.yml, and nowhere else, on the
 * migrate step that runs a dispatched branch's migrations against a
 * copy-on-write clone of prod. A mission branch's own migration usually
 * predates dev's newest released one, so on that clone it sits below the
 * high-water mark with its DDL absent, and the prod rule refuses it. Under the
 * flag such a migration is executed in journal order instead. Only honoured in
 * GitHub Actions, so a stray value on a deploy does nothing.
 */
export const CI_CLONE_APPLY_ABSENT_ENV = 'MIGRATION_CI_CLONE_APPLY_ABSENT';

export function ciCloneApplyAbsentEnabled(env: Record<string, string | undefined>): boolean {
  return env[CI_CLONE_APPLY_ABSENT_ENV] === '1' && env.GITHUB_ACTIONS === 'true';
}

import type { MigrationFile } from './migrate-plan';

export interface DbShape {
  /** Table names in the `public` schema. */
  tables: Set<string>;
  /** `table.column` for every column in the `public` schema. */
  columns: Set<string>;
  /** Index names in the `public` schema. */
  indexes: Set<string>;
  /** `table.constraint` for every constraint in the `public` schema. */
  constraints: Set<string>;
}

export function emptyDbShape(): DbShape {
  return { tables: new Set(), columns: new Set(), indexes: new Set(), constraints: new Set() };
}

export type AssertionKind =
  | 'table_exists'
  | 'table_absent'
  | 'column_exists'
  | 'column_absent'
  | 'index_exists'
  | 'index_absent'
  | 'constraint_exists'
  | 'constraint_absent';

export interface Assertion {
  kind: AssertionKind;
  /** `table`, `table.column`, `index`, or `table.constraint` depending on kind. */
  target: string;
}

export interface DerivedAssertions {
  assertions: Assertion[];
  /** Statements no assertion could be derived from (data DML, ALTER COLUMN, ...). */
  opaque: string[];
}

const ID = '"?([A-Za-z0-9_]+)"?';
// A table reference. drizzle-kit writes `"tasks"`; the squashed baseline is a
// pg_dump, which writes `public.tasks` and `ALTER TABLE ONLY public.tasks`.
const TABLE = `(?:ONLY\\s+)?(?:"?public"?\\.)?${ID}`;

const PATTERNS: Array<{ re: RegExp; build: (m: RegExpExecArray) => Assertion[] }> = [
  {
    re: new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${TABLE}`, 'i'),
    build: (m) => [{ kind: 'table_exists', target: m[1]! }],
  },
  {
    re: new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${TABLE}`, 'i'),
    build: (m) => [{ kind: 'table_absent', target: m[1]! }],
  },
  {
    re: new RegExp(
      `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`,
      'i',
    ),
    build: (m) => [{ kind: 'index_exists', target: m[1]! }],
  },
  {
    re: new RegExp(`^DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?${ID}`, 'i'),
    build: (m) => [{ kind: 'index_absent', target: m[1]! }],
  },
  {
    re: new RegExp(
      `^ALTER\\s+TABLE\\s+${TABLE}\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`,
      'i',
    ),
    build: (m) => [{ kind: 'column_exists', target: `${m[1]}.${m[2]}` }],
  },
  {
    re: new RegExp(`^ALTER\\s+TABLE\\s+${TABLE}\\s+DROP\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?${ID}`, 'i'),
    build: (m) => [{ kind: 'column_absent', target: `${m[1]}.${m[2]}` }],
  },
  {
    re: new RegExp(`^ALTER\\s+TABLE\\s+${TABLE}\\s+RENAME\\s+COLUMN\\s+${ID}\\s+TO\\s+${ID}`, 'i'),
    build: (m) => [
      { kind: 'column_absent', target: `${m[1]}.${m[2]}` },
      { kind: 'column_exists', target: `${m[1]}.${m[3]}` },
    ],
  },
  {
    re: new RegExp(`^ALTER\\s+TABLE\\s+${TABLE}\\s+RENAME\\s+TO\\s+${ID}`, 'i'),
    build: (m) => [
      { kind: 'table_absent', target: m[1]! },
      { kind: 'table_exists', target: m[2]! },
    ],
  },
  {
    re: new RegExp(`^ALTER\\s+TABLE\\s+${TABLE}\\s+ADD\\s+CONSTRAINT\\s+${ID}`, 'i'),
    build: (m) => [{ kind: 'constraint_exists', target: `${m[1]}.${m[2]}` }],
  },
  {
    re: new RegExp(
      `^ALTER\\s+TABLE\\s+${TABLE}\\s+DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?${ID}`,
      'i',
    ),
    build: (m) => [{ kind: 'constraint_absent', target: `${m[1]}.${m[2]}` }],
  },
];

/**
 * Strip SQL line comments and collapse whitespace so the patterns above can be
 * anchored at the start of the statement.
 */
function normalize(statement: string): string {
  return statement
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Drizzle wraps every generated FK in
 *   DO $$ BEGIN ALTER TABLE ... ADD CONSTRAINT ...; EXCEPTION WHEN duplicate_object THEN null; END $$;
 * Unwrap it so those 100+ statements are checkable rather than opaque. Anything
 * else inside a DO block (procedural logic) stays opaque.
 */
function unwrapDoBlock(statement: string): string | null {
  const match = /^DO \$\$\s*BEGIN\s+(.*?)\s*(?:EXCEPTION\b.*)?END \$\$;?$/i.exec(statement);
  if (!match) return null;
  const body = match[1]!.trim();
  // Only a single simple ALTER TABLE is unwrapped; anything with more than one
  // statement or non-ALTER logic is left for the opaque bucket.
  if (!/^ALTER\s+TABLE\b/i.test(body)) return null;
  if (body.replace(/;$/, '').includes(';')) return null;
  return body;
}

export function deriveAssertions(statements: readonly string[]): DerivedAssertions {
  const assertions: Assertion[] = [];
  const opaque: string[] = [];

  for (const raw of statements) {
    const normalized = normalize(raw);
    if (normalized === '' || normalized === ';') continue; // comment-only / blank: nothing to prove

    const candidate = unwrapDoBlock(normalized) ?? normalized;
    const pattern = PATTERNS.find((p) => p.re.test(candidate));
    if (!pattern) {
      opaque.push(normalized.slice(0, 160));
      continue;
    }
    const match = pattern.re.exec(candidate)!;
    assertions.push(...pattern.build(match));
  }

  return { assertions, opaque };
}

function holds(assertion: Assertion, shape: DbShape): boolean {
  switch (assertion.kind) {
    case 'table_exists':
      return shape.tables.has(assertion.target);
    case 'table_absent':
      return !shape.tables.has(assertion.target);
    case 'column_exists':
      return shape.columns.has(assertion.target);
    case 'column_absent':
      return !shape.columns.has(assertion.target);
    case 'index_exists':
      return shape.indexes.has(assertion.target);
    case 'index_absent':
      return !shape.indexes.has(assertion.target);
    case 'constraint_exists':
      return shape.constraints.has(assertion.target);
    case 'constraint_absent':
      return !shape.constraints.has(assertion.target);
  }
}

export type BackfillVerdict = 'verified' | 'contradicted' | 'unverifiable' | 'inert';

export interface BackfillEvaluation {
  verdict: BackfillVerdict;
  /** How many assertions were actually compared against the DB. */
  checked: number;
  /** Human-readable assertion failures (empty unless `contradicted`). */
  failures: string[];
  opaque: string[];
  /**
   * Contradicted, and no assertion holds: none of this migration's checkable
   * DDL is in the database, so it never ran at all (as opposed to ran in part).
   */
  absent: boolean;
}

/**
 * Decide whether the DB already contains this migration's DDL.
 *
 * `verified` requires at least one assertion, all holding. Opaque statements
 * alongside satisfied assertions do not block: the observable DDL of the file is
 * present, which is the evidence available. A migration with NO checkable
 * statement at all is `unverifiable` — the caller decides whether to trust it.
 */
export function evaluateBackfill(
  statements: readonly string[],
  shape: DbShape,
): BackfillEvaluation {
  const { assertions, opaque } = deriveAssertions(statements);
  const failures = assertions
    .filter((a) => !holds(a, shape))
    .map((a) => `${a.kind} ${a.target}`);

  if (failures.length > 0) {
    const absent = failures.length === assertions.length;
    return { verdict: 'contradicted', checked: assertions.length, failures, opaque, absent };
  }
  if (assertions.length > 0) {
    return { verdict: 'verified', checked: assertions.length, failures: [], opaque, absent: false };
  }
  if (opaque.length > 0) {
    return { verdict: 'unverifiable', checked: 0, failures: [], opaque, absent: false };
  }
  return { verdict: 'inert', checked: 0, failures: [], opaque, absent: false };
}

export interface BackfillRequest {
  toBackfill: readonly MigrationFile[];
  shape: DbShape;
  /** Writes the __drizzle_migrations tracking row. */
  record: (migration: MigrationFile) => Promise<void>;
  /**
   * Permits recording migrations whose SQL yields no checkable assertion (pure
   * data DML, `ALTER COLUMN` only). Never permits recording a contradicted one.
   * Wired to MIGRATION_BACKFILL_ALLOW_UNVERIFIED=1 in db/migrate.ts.
   */
  allowUnverified?: boolean;
  /**
   * CI prod clone only (ciCloneApplyAbsentEnabled): return a contradicted
   * migration whose DDL is wholly absent in `toApply` for the caller to
   * execute, instead of refusing it. Partially present DDL is still refused.
   */
  applyAbsent?: boolean;
  log?: (message: string) => void;
}

export interface BackfillResult {
  recorded: number;
  /** Of `recorded`, how many were recorded without any DDL evidence. */
  unverified: number;
  /**
   * Under `applyAbsent` only: migrations to EXECUTE (not record), in the order
   * given. The caller records each after its SQL succeeds.
   */
  toApply: MigrationFile[];
}

export class BackfillContradictedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackfillContradictedError';
  }
}

/**
 * Record tracking rows for already-applied migrations — and only for those.
 *
 * Throws before writing anything if any migration in the batch is contradicted
 * (its DDL is provably missing) or unverifiable without the opt-in. Nothing is
 * recorded in that case: a partial backfill would leave the next run with a
 * different, harder-to-read state.
 */
export async function backfillTrackingRows(request: BackfillRequest): Promise<BackfillResult> {
  const {
    toBackfill,
    shape,
    record,
    allowUnverified = false,
    applyAbsent = false,
    log = () => {},
  } = request;
  if (toBackfill.length === 0) return { recorded: 0, unverified: 0, toApply: [] };

  const contradicted: string[] = [];
  const toApply: MigrationFile[] = [];
  const unverifiable: string[] = [];
  const plan: Array<{ migration: MigrationFile; evaluation: BackfillEvaluation }> = [];

  for (const migration of toBackfill) {
    const evaluation = evaluateBackfill(migration.sql, shape);
    plan.push({ migration, evaluation });

    if (evaluation.verdict === 'contradicted' && applyAbsent && evaluation.absent) {
      toApply.push(migration);
    } else if (evaluation.verdict === 'contradicted') {
      contradicted.push(
        `  ${migration.folderMillis}: ${evaluation.failures.join(', ')} ` +
          `(${evaluation.checked} assertion(s) checked` +
          (applyAbsent ? `; partially present, so not applied on this clone` : '') +
          `)`,
      );
    } else if (evaluation.verdict === 'unverifiable' && !allowUnverified) {
      unverifiable.push(`  ${migration.folderMillis}: ${evaluation.opaque[0] ?? '(no statements)'}`);
    }
  }

  if (contradicted.length > 0) {
    throw new BackfillContradictedError(
      `Refusing to backfill ${contradicted.length} migration(s): their DDL is NOT present in the database, ` +
        `so they never ran. Recording a tracking row would make the skip permanent.\n` +
        `${contradicted.join('\n')}\n` +
        `Fix: write a reconciliation migration that re-issues the equivalent idempotent DDL under ` +
        `current names ` +
        `and deploy that (git history before the migration squash has worked examples, e.g. ` +
        `0074_reconcile_missions_secret_refs_drift.sql). Do NOT hand-insert tracking rows.`,
    );
  }

  if (unverifiable.length > 0) {
    throw new Error(
      `Refusing to backfill ${unverifiable.length} migration(s) with unverifiable SQL: nothing in the ` +
        `file can be checked against information_schema, so "already applied" cannot be proven.\n` +
        `${unverifiable.join('\n')}\n` +
        `If you have confirmed out-of-band that these ran, re-run with ` +
        `MIGRATION_BACKFILL_ALLOW_UNVERIFIED=1 to record them.`,
    );
  }

  let recorded = 0;
  let unverified = 0;
  for (const { migration, evaluation } of plan) {
    if (toApply.includes(migration)) {
      log(
        `  [ci-clone apply] ${migration.folderMillis} DDL wholly absent ` +
          `(${evaluation.checked} assertion(s)); executing it on this CI clone`,
      );
      continue;
    }
    await record(migration);
    recorded++;
    if (evaluation.verdict === 'unverifiable') {
      unverified++;
      log(
        `  [UNVERIFIED BACKFILL] ${migration.folderMillis} recorded on operator opt-in with no DDL evidence`,
      );
    } else {
      log(
        `  [backfill] ${migration.folderMillis} verdict=${evaluation.verdict} ` +
          `proved ${evaluation.checked} assertion(s), ${evaluation.opaque.length} statement(s) unverifiable`,
      );
    }
  }

  return { recorded, unverified, toApply };
}

// The apply step for the drizzle v1 layout (db/migrate.ts, after
// planMigrationsV1 and the legacy backfill).
//
// Post-cutover migrations have no high-water mark. The mark existed because a
// file's DDL and its tracking insert were separate requests: a dropped
// connection between them left DDL applied with no row, and only "older than
// the newest row" could tell that apart from "never ran". Here the two commit
// together, in one `db.batch` (neon-http's non-interactive transaction; not
// `db.transaction()`, which that driver does not support), so the window is
// closed at the source.
//
// Two things the batch cannot carry run statement by statement instead, and
// such a migration must be idempotent (`IF NOT EXISTS`): statements Postgres
// refuses inside a transaction block, and `ALTER TYPE ... ADD VALUE` followed
// by a use of the new value in the same file.
//
// A post-cutover migration with no row can still meet DDL that is already
// there (that unbatched path, or a hand-applied fix). So before executing one
// it is checked against the live schema with the same evidence rules as the
// legacy backfill (evaluateBackfill), over its replay-sensitive statements
// only: DDL present -> record only; partly present -> refuse; absent or
// uncheckable -> execute. An idempotent statement (`IF [NOT] EXISTS`, a DO
// block that swallows duplicate_object) replays harmlessly whatever the schema
// holds, so its target already existing says nothing about whether this file
// ran: counting it would refuse every reconciliation migration that re-issues
// existing DDL alongside something new.

import { BackfillContradictedError, evaluateBackfill, type DbShape } from './migrate-backfill';
import { isCommentOnly, type TreeMigration } from './migrate-tree';

/** Statements with something to execute: blank and comment-only chunks dropped. */
export function executableStatements(statements: readonly string[]): string[] {
  return statements.filter((s) => !isCommentOnly([s]));
}

const stripComments = (s: string) =>
  s
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

/** Statements that would fail if replayed over their own effect (no IF [NOT] EXISTS guard). */
export function replaySensitiveStatements(statements: readonly string[]): string[] {
  return executableStatements(statements).filter((s) => {
    const body = stripComments(s);
    if (/\bIF\s+(?:NOT\s+)?EXISTS\b/i.test(body)) return false;
    if (/^\s*DO\s+\$\$[\s\S]*\bEXCEPTION\b/i.test(body)) return false;
    return true;
  });
}

/** Why `statements` cannot run inside one transaction, or null if they can. */
export function needsUnbatched(statements: readonly string[]): string | null {
  const bodies = statements.map(stripComments);
  for (const body of bodies) {
    if (/\bCONCURRENTLY\b/i.test(body)) return 'CONCURRENTLY cannot run inside a transaction block';
    if (/^\s*VACUUM\b/im.test(body)) return 'VACUUM cannot run inside a transaction block';
    if (/\bALTER\s+SYSTEM\b/i.test(body)) return 'ALTER SYSTEM cannot run inside a transaction block';
    if (/\b(?:CREATE|DROP)\s+DATABASE\b/i.test(body)) return 'CREATE/DROP DATABASE cannot run inside a transaction block';
  }
  for (let i = 0; i < bodies.length; i++) {
    const added = /\bALTER\s+TYPE\b[^;]*?\bADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?('(?:[^']|'')*')/i.exec(bodies[i]!);
    if (!added) continue;
    const literal = added[1]!;
    const usedLater =
      bodies.slice(i + 1).some((b) => b.includes(literal)) ||
      bodies[i]!.slice(added.index + added[0].length).includes(literal);
    if (usedLater) return `ALTER TYPE ... ADD VALUE ${literal} is used later in the same file`;
  }
  return null;
}

export interface ApplyV1Deps {
  /** Execute one statement on its own (unbatched path). */
  execute(statement: string): Promise<void>;
  /** Execute `statements` and the migration's tracking insert as ONE transaction. */
  executeAtomic(statements: string[], migration: TreeMigration): Promise<void>;
  /** Write the migration's tracking row. */
  record(migration: TreeMigration): Promise<void>;
  /** Live schema introspection, for the evidence check. */
  readShape(): Promise<DbShape>;
  log(message: string): void;
}

export interface ApplyV1Input {
  /** In order: legacy (above the legacy mark, or handed back by the CI clone flag), then post-cutover. */
  toExecute: readonly TreeMigration[];
  /** Post-cutover, comment-only: record without executing. */
  toRecordOnly: readonly TreeMigration[];
  legacyNames: ReadonlySet<string>;
}

export interface ApplyV1Result {
  executed: string[];
  recordedOnly: string[];
  /** Post-cutover migrations recorded because their DDL was already present. */
  recordedPresent: string[];
}

async function execute(migration: TreeMigration, deps: ApplyV1Deps): Promise<void> {
  const statements = executableStatements(migration.sql);
  if (statements.length === 0) {
    await deps.record(migration);
    return;
  }
  const unbatched = needsUnbatched(statements);
  if (unbatched) {
    deps.log(`  [unbatched] ${migration.name}: ${unbatched}; running statement by statement`);
    for (const statement of statements) await deps.execute(statement);
    // Recorded only after every statement succeeded; a failure above leaves no
    // row and the (idempotent) file runs again next time.
    await deps.record(migration);
    return;
  }
  await deps.executeAtomic(statements, migration);
}

export async function applyV1(input: ApplyV1Input, deps: ApplyV1Deps): Promise<ApplyV1Result> {
  const result: ApplyV1Result = { executed: [], recordedOnly: [], recordedPresent: [] };

  for (const migration of input.toRecordOnly) {
    await deps.record(migration);
    result.recordedOnly.push(migration.name);
    deps.log(`Recorded (comment-only, nothing to execute): ${migration.name}`);
  }

  for (const migration of input.toExecute) {
    if (!input.legacyNames.has(migration.name)) {
      // Fresh shape per migration: the ones before it in this run changed it.
      const evaluation = evaluateBackfill(replaySensitiveStatements(migration.sql), await deps.readShape());
      if (evaluation.verdict === 'verified') {
        await deps.record(migration);
        result.recordedPresent.push(migration.name);
        deps.log(
          `Recorded without executing: ${migration.name} has no tracking row but its DDL is already ` +
            `present (${evaluation.checked} assertion(s) hold)`
        );
        continue;
      }
      if (evaluation.verdict === 'contradicted' && !evaluation.absent) {
        throw new BackfillContradictedError(
          `Refusing ${migration.name}: it has no tracking row and its DDL is PARTLY present ` +
            `(${evaluation.failures.join(', ')} do not hold; the rest do). Replaying it could fail or ` +
            `corrupt; recording it would hide the missing part. Write a reconciliation migration ` +
            `that re-issues the missing DDL idempotently. Do NOT hand-insert tracking rows.`
        );
      }
    }
    await execute(migration, deps);
    result.executed.push(migration.name);
    deps.log(`Applied: ${migration.name} (${executableStatements(migration.sql).length} statement(s))`);
  }

  return result;
}

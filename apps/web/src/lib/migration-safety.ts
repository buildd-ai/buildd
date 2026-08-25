export type OperationClass = 'EXPAND' | 'CONTRACT';

export type MigrationSafety =
  | { safe: true; operationClass: 'EXPAND' }
  | { safe: false; reason: string; operationClass: 'CONTRACT' };

const MIGRATION_PATH = /(?:^|\/)drizzle\/(\d{4})_[^/]+\.sql$/;

export function isGeneratedMigrationPath(filename: string): boolean {
  return MIGRATION_PATH.test(filename);
}

export function getMigrationNumber(filename: string): string | null {
  return MIGRATION_PATH.exec(filename)?.[1] ?? null;
}

function identifier(value: string): string {
  return value.replaceAll('"', '');
}

function compact(statement: string): string {
  return statement.replace(/\s+/g, ' ').trim();
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');
}

function statements(sql: string): string[] {
  return stripComments(sql)
    .split(/-->\s*statement-breakpoint|;/)
    .map(compact)
    .filter(Boolean);
}

/**
 * Conservatively classify generated Postgres migration SQL.
 *
 * Returns EXPAND for purely additive, reversible changes.
 * Returns CONTRACT for any destructive or irreversible statement.
 * Unknown statements fail closed: CONTRACT.
 */
export function classifyMigrationSql(sql: string): MigrationSafety {
  const parsed = statements(sql);
  if (parsed.length === 0) {
    return { safe: false, operationClass: 'CONTRACT', reason: 'generated migration contains no SQL statements' };
  }

  for (const statement of parsed) {
    let match: RegExpExecArray | null;

    match = /^DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+("?[a-zA-Z_][\w$]*"?)/i.exec(statement);
    if (match) return { safe: false, operationClass: 'CONTRACT', reason: `drops table ${identifier(match[1])}` };

    match =
      /^ALTER\s+TABLE\s+(?:ONLY\s+)?("?[a-zA-Z_][\w$]*"?)\s+DROP\s+COLUMN(?:\s+IF\s+EXISTS)?\s+("?[a-zA-Z_][\w$]*"?)/i.exec(
        statement,
      );
    if (match) {
      return {
        safe: false,
        operationClass: 'CONTRACT',
        reason: `drops column ${identifier(match[1])}.${identifier(match[2])}`,
      };
    }

    match =
      /^ALTER\s+TABLE\s+("?[a-zA-Z_][\w$]*"?)\s+RENAME\s+COLUMN\s+("?[a-zA-Z_][\w$]*"?)\s+TO\s+("?[a-zA-Z_][\w$]*"?)/i.exec(
        statement,
      );
    if (match) {
      return {
        safe: false,
        operationClass: 'CONTRACT',
        reason: `renames column ${identifier(match[1])}.${identifier(match[2])} to ${identifier(match[3])}`,
      };
    }

    match =
      /^ALTER\s+TABLE\s+("?[a-zA-Z_][\w$]*"?)\s+RENAME\s+TO\s+("?[a-zA-Z_][\w$]*"?)/i.exec(
        statement,
      );
    if (match) {
      return {
        safe: false,
        operationClass: 'CONTRACT',
        reason: `renames table ${identifier(match[1])} to ${identifier(match[2])}`,
      };
    }

    match =
      /^ALTER\s+TABLE\s+("?[a-zA-Z_][\w$]*"?)\s+ALTER\s+COLUMN\s+("?[a-zA-Z_][\w$]*"?)\s+(?:SET\s+DATA\s+)?TYPE\b/i.exec(
        statement,
      );
    if (match) {
      return {
        safe: false,
        operationClass: 'CONTRACT',
        reason: `changes type of ${identifier(match[1])}.${identifier(match[2])}`,
      };
    }

    match =
      /^ALTER\s+TABLE\s+("?[a-zA-Z_][\w$]*"?)\s+ALTER\s+COLUMN\s+("?[a-zA-Z_][\w$]*"?)\s+SET\s+NOT\s+NULL\b/i.exec(
        statement,
      );
    if (match) {
      return {
        safe: false,
        operationClass: 'CONTRACT',
        reason: `adds NOT NULL constraint to existing column ${identifier(match[1])}.${identifier(match[2])}`,
      };
    }

    match = /^(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+("?[a-zA-Z_][\w$]*"?)/i.exec(
      statement,
    );
    if (match) {
      return {
        safe: false,
        operationClass: 'CONTRACT',
        reason: `runs data migration ${match[1].split(/\s/)[0].toUpperCase()} on ${identifier(match[2])}`,
      };
    }

    if (/^CREATE\s+TABLE\b/i.test(statement)) continue;
    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement)) continue;

    match =
      /^ALTER\s+TABLE\s+("?[a-zA-Z_][\w$]*"?)\s+ADD\s+COLUMN\s+("?[a-zA-Z_][\w$]*"?)\s+([\s\S]+)$/i.exec(
        statement,
      );
    if (match) {
      const definition = match[3];
      if (/\bNOT\s+NULL\b/i.test(definition) && !/\bDEFAULT\b/i.test(definition)) {
        return {
          safe: false,
          operationClass: 'CONTRACT',
          reason: `adds NOT NULL column without default ${identifier(match[1])}.${identifier(match[2])}`,
        };
      }
      continue;
    }

    // Constraints added after their table/column are still additive. Database
    // validation remains CI's job; this classifier is about irreversibility.
    if (/^ALTER\s+TABLE\b[\s\S]*\bADD\s+CONSTRAINT\b/i.test(statement)) continue;

    return {
      safe: false,
      operationClass: 'CONTRACT',
      reason: `ambiguous migration statement: ${statement.slice(0, 120)}`,
    };
  }

  return { safe: true, operationClass: 'EXPAND' };
}

export interface PullRequestMigrationFile {
  filename: string;
  content?: string;
}

export function classifyPullRequestMigrations(
  files: PullRequestMigrationFile[],
  openPullRequestMigrationPaths: string[],
): MigrationSafety {
  const migrations = files.filter((file) => isGeneratedMigrationPath(file.filename));
  const touchesSchema = files.some((file) => file.filename === 'packages/core/db/schema.ts');

  if (touchesSchema && migrations.length === 0) {
    return { safe: false, operationClass: 'CONTRACT', reason: 'schema changed without a generated SQL migration' };
  }

  const results: MigrationSafety[] = [];

  for (const migration of migrations) {
    const number = getMigrationNumber(migration.filename)!;
    const collision = openPullRequestMigrationPaths.find(
      (path) => getMigrationNumber(path) === number,
    );
    if (collision) {
      return {
        safe: false,
        operationClass: 'CONTRACT',
        reason: `migration number collision: ${migration.filename.split('/').at(-1)} conflicts with open PR migration ${collision.split('/').at(-1)}`,
      };
    }

    if (migration.content === undefined) {
      return {
        safe: false,
        operationClass: 'CONTRACT',
        reason: `could not inspect generated migration ${migration.filename}`,
      };
    }

    results.push(classifyMigrationSql(migration.content));
  }

  const firstContract = results.find((r): r is Extract<MigrationSafety, { safe: false }> => !r.safe);
  const hasExpand = results.some((r) => r.safe);

  // Reject PRs that mix EXPAND and CONTRACT migrations. Each operation class must
  // travel in its own PR: land additive changes first, then the destructive cleanup
  // once no code reads the old column/table.
  if (firstContract && hasExpand) {
    return {
      safe: false,
      operationClass: 'CONTRACT',
      reason:
        `PR mixes EXPAND and CONTRACT migrations — split into two PRs: ship additive changes first, then land the destructive ones separately once nothing reads the old columns. Triggered by: ${firstContract.reason}`,
    };
  }

  if (firstContract) return firstContract;

  return { safe: true, operationClass: 'EXPAND' };
}

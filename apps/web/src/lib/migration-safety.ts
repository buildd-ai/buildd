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

/**
 * Split on `;` and drizzle's `--> statement-breakpoint`, but never inside a
 * dollar-quoted body (`$$ ... $$`, `$fn$ ... $fn$`), so a DO block or function
 * stays one statement instead of being cut at its inner semicolons.
 */
function statements(sql: string): string[] {
  const text = stripComments(sql);
  const out: string[] = [];
  let current = '';
  let i = 0;
  while (i < text.length) {
    const tag = /^\$[a-zA-Z_]*\$/.exec(text.slice(i))?.[0];
    if (tag) {
      const close = text.indexOf(tag, i + tag.length);
      const end = close === -1 ? text.length : close + tag.length;
      current += text.slice(i, end);
      i = end;
      continue;
    }
    const breakpoint = /^-->\s*statement-breakpoint/.exec(text.slice(i))?.[0];
    if (breakpoint || text[i] === ';') {
      out.push(current);
      current = '';
      i += breakpoint ? breakpoint.length : 1;
      continue;
    }
    current += text[i];
    i += 1;
  }
  out.push(current);
  return out.map(compact).filter(Boolean);
}

/**
 * drizzle-kit wraps FK/enum creation as
 *   DO $$ BEGIN <stmt>; EXCEPTION WHEN duplicate_object THEN null; END $$
 * purely to make it idempotent. Return <stmt> so it is classified on its own
 * merits; any other DO block is procedural and stays ambiguous.
 */
function unwrapIdempotentDoBlock(statement: string): string | null {
  const match =
    /^DO\s+\$\$\s*BEGIN\s+([\s\S]+?);?\s*EXCEPTION\s+WHEN\s+duplicate_object\s+THEN\s+null;?\s*END\s*\$\$$/i.exec(
      statement,
    );
  if (!match || match[1].includes(';')) return null;
  return compact(match[1]);
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

  for (const raw of parsed) {
    const statement = unwrapIdempotentDoBlock(raw) ?? raw;
    let match: RegExpExecArray | null;

    match = /^DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+("?[a-zA-Z_][\w$]*"?)/i.exec(statement);
    if (match) return { safe: false, operationClass: 'CONTRACT', reason: `drops table ${identifier(match[1])}` };

    match = /^DROP\s+INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+EXISTS)?\s+("?[a-zA-Z_][\w$.]*"?)/i.exec(statement);
    if (match) return { safe: false, operationClass: 'CONTRACT', reason: `drops index ${identifier(match[1])}` };

    match = /^DROP\s+TYPE(?:\s+IF\s+EXISTS)?\s+("?[a-zA-Z_][\w$]*"?(?:\."?[a-zA-Z_][\w$]*"?)?)/i.exec(statement);
    if (match) return { safe: false, operationClass: 'CONTRACT', reason: `drops type ${identifier(match[1])}` };

    match =
      /^ALTER\s+TABLE\s+(?:ONLY\s+)?("?[a-zA-Z_][\w$]*"?)\s+DROP\s+CONSTRAINT(?:\s+IF\s+EXISTS)?\s+("?[a-zA-Z_][\w$]*"?)/i.exec(
        statement,
      );
    if (match) {
      return {
        safe: false,
        operationClass: 'CONTRACT',
        reason: `drops constraint ${identifier(match[1])}.${identifier(match[2])}`,
      };
    }

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
    // New enum types and new enum values: additive, nothing reads them yet.
    if (/^CREATE\s+TYPE\b[\s\S]*\bAS\s+ENUM\b/i.test(statement)) continue;
    if (/^ALTER\s+TYPE\b[\s\S]*\bADD\s+VALUE\b/i.test(statement)) continue;
    if (/^CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\b/i.test(statement)) continue;
    // Default changes are catalog-only; DROP NOT NULL only relaxes a constraint.
    if (
      /^ALTER\s+TABLE\s+(?:ONLY\s+)?"?[a-zA-Z_][\w$]*"?\s+ALTER\s+COLUMN\s+"?[a-zA-Z_][\w$]*"?\s+(?:SET\s+DEFAULT\b|DROP\s+DEFAULT$|DROP\s+NOT\s+NULL$)/i.test(
        statement,
      )
    ) {
      continue;
    }

    match =
      /^ALTER\s+TABLE\s+("?[a-zA-Z_][\w$]*"?)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[a-zA-Z_][\w$]*"?)\s+([\s\S]+)$/i.exec(
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

  // schema.ts touched with zero generated migrations is NOT a destructive schema
  // change — it covers TS-only edits ($type<>() union widening, JSONB-shaped
  // interface fields, type aliases) that alter no table shape. Falls through to
  // the EXPAND default below. The `schema-drift` CI job is what catches a real
  // structural change whose migration was never generated — this classifier is
  // about irreversibility, not about whether `bun db:generate` was run.
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

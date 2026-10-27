import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { helperRunSql, helperHostTaskSql } from './helper-run-sql';

const dialect = new PgDialect();

describe('helper-run-sql', () => {
  it('helperRunSql renders the helper markers', () => {
    const { sql: text } = dialect.sqlToQuery(helperRunSql());
    expect(text).toContain("like '[surface audit]%'");
    expect(text).toContain("'specCriterionCheck'");
    expect(text).toContain("'finalVerification'");
  });

  it('helperHostTaskSql resolves a subject, a filer or an attempt parent', () => {
    const { sql: text } = dialect.sqlToQuery(helperHostTaskSql());
    expect(text).toContain("'subjectTaskId'");
    expect(text).toContain("'filedBy'");
    expect(text).toContain('"parent_task_id"');
  });
});

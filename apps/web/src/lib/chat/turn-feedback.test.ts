import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ownAssistantMessageScope } from './turn-feedback';

const dialect = new PgDialect();

describe('ownAssistantMessageScope', () => {
  it('matches only an assistant message in a conversation the user created', () => {
    const q = dialect.sqlToQuery(ownAssistantMessageScope('m-1', 'u-1')!);
    const sql = q.sql.replace(/\s+/g, ' ').toLowerCase();
    expect(sql).toContain('"conversation_messages"."id" = $1');
    expect(sql).toContain('"conversation_messages"."role" = $2');
    expect(sql).toContain('"conversations"."created_by_user_id" = $3');
    expect(q.params).toEqual(['m-1', 'assistant', 'u-1']);
  });
});

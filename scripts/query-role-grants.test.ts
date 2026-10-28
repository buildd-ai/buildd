import { describe, expect, it } from 'bun:test';
import { DATABASE_QUERY_ROLE, DATABASE_QUERY_TABLES } from '../apps/web/src/lib/capability-database-query';
import { queryRoleSql } from './query-role-grants';

describe('queryRoleSql', () => {
  const sql = queryRoleSql();

  it('grants SELECT on exactly the allowlist, after revoking everything', () => {
    const grants = sql.split('\n').filter(l => l.startsWith('GRANT SELECT'));
    expect(grants).toEqual(DATABASE_QUERY_TABLES.map(t => `GRANT SELECT ON public.${t} TO ${DATABASE_QUERY_ROLE};`));
    expect(sql.indexOf('REVOKE ALL ON ALL TABLES')).toBeLessThan(sql.indexOf('GRANT SELECT'));
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL|TRUNCATE)/);
  });

  it('makes the role read-only by default and drops neon_superuser', () => {
    expect(sql).toContain(`ALTER ROLE ${DATABASE_QUERY_ROLE} SET default_transaction_read_only = on;`);
    expect(sql).toContain(`REVOKE neon_superuser FROM ${DATABASE_QUERY_ROLE}`);
    expect(sql).toContain('NOSUPERUSER');
  });

  it('holds no password: it comes from a psql variable', () => {
    expect(sql).toContain(":'query_role_password'");
    expect(sql).not.toMatch(/PASSWORD '/);
  });

  it('refuses a name that is not a plain identifier', () => {
    expect(() => queryRoleSql('ro; drop table tasks', ['tasks'])).toThrow();
    expect(() => queryRoleSql(DATABASE_QUERY_ROLE, ['tasks"; --'])).toThrow();
  });
});

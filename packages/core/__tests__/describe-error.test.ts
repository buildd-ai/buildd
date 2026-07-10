import { describe, it, expect } from 'bun:test';
import { describeError } from '../describe-error';

describe('describeError', () => {
  it('surfaces the neon driver cause instead of the giant "Failed query" message', () => {
    // Mirrors how the neon-http Drizzle driver throws: a generic outer message
    // with the real NeonDbError (SQLSTATE code, constraint, detail) on .cause.
    const cause = Object.assign(new Error('insert or update on table "tasks" violates foreign key constraint'), {
      code: '23503',
      constraint: 'tasks_workspace_id_workspaces_id_fk',
      detail: 'Key (workspace_id)=(abc) is not present in table "workspaces".',
    });
    const outer = new Error('Failed query: insert into "tasks" (...) values ($1, $2, ...) returning "id"');
    (outer as { cause?: unknown }).cause = cause;

    const result = describeError(outer);

    expect(result).toContain('violates foreign key constraint');
    expect(result).toContain('(23503)');
    expect(result).toContain('[constraint tasks_workspace_id_workspaces_id_fk]');
    expect(result).toContain('is not present in table');
    // The useless outer "Failed query" SQL dump must not be the whole message.
    expect(result).not.toContain('Failed query');
  });

  it('falls back to the outer message when there is no Error cause', () => {
    expect(describeError(new Error('plain failure'))).toBe('plain failure');
  });

  it('appends a string cause when present', () => {
    const err = new Error('outer');
    (err as { cause?: unknown }).cause = 'timeout';
    expect(describeError(err)).toBe('outer: timeout');
  });

  it('stringifies non-Error throwables', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError(42)).toBe('42');
  });
});

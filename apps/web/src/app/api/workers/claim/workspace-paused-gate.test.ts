import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { appliesWorkspacePausedGate, workspaceNotPausedGate } from './workspace-paused-gate';

const NOW = new Date('2030-01-01T12:00:00.000Z');

// Pins the rendered shape so a refactor cannot quietly drop the time bound.
describe('workspaceNotPausedGate SQL', () => {
  it('excludes tasks whose workspace pauses new starts past now', () => {
    const { sql, params } = new PgDialect().sqlToQuery(workspaceNotPausedGate(NOW));
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('"workspaces"');
    expect(sql).toContain('"tasks"."workspace_id"');
    expect(sql).toContain('new_starts_paused_until >');
    expect(params).toContain(NOW.toISOString());
  });
});

describe('who the pause applies to', () => {
  it('a runner poll and a runner explicit claim are paused', () => {
    expect(appliesWorkspacePausedGate({ interactive: false, force: false })).toBe(true);
  });
  it('a person\'s interactive session is never paused', () => {
    expect(appliesWorkspacePausedGate({ interactive: true, force: false })).toBe(false);
  });
  it('an admin force claim lifts it, like the other workspace gates', () => {
    expect(appliesWorkspacePausedGate({ interactive: false, force: true })).toBe(false);
  });
});

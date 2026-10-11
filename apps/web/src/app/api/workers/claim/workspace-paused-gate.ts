import { sql, type SQL } from 'drizzle-orm';
import { tasks, workspaces } from '@buildd/core/db/schema';

/**
 * Claim gate: TRUE when the task's workspace is not pausing new starts.
 * A workspace with `new_starts_paused_until` in the future keeps its pending
 * tasks waiting; nothing already running is touched, and it resumes on its own
 * once that time passes. Two-valued (NOT EXISTS), so the explicit-claim probe
 * can name it.
 */
export function workspaceNotPausedGate(now: Date): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${workspaces} ws_p
    WHERE ws_p.id = ${tasks.workspaceId}
    AND ws_p.new_starts_paused_until > ${now.toISOString()}
  )`;
}

/**
 * Runner claims are paused; a person's interactive session never is (the owner
 * rule from task 69f5b7cd: an interactive session can always claim), and an
 * admin force claim lifts it like the other workspace gates.
 */
export function appliesWorkspacePausedGate(opts: { interactive: boolean; force: boolean }): boolean {
  return !opts.interactive && !opts.force;
}

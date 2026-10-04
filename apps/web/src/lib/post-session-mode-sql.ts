import { workspaces } from '@buildd/core/db/schema';
import { sql } from 'drizzle-orm';

/**
 * SQL twin of `resolvePostSessionQualityMode`: only an explicit 'off' opts a
 * workspace out. Every post-session queue (collect, triage, analyse) filters on
 * it, so switching a workspace off stops the loop at whatever stage its runs
 * are in. Requires `workspaces` in the FROM clause.
 */
export const WORKSPACE_NOT_OFF = sql`coalesce(${workspaces.gitConfig}->'postSessionQuality'->>'mode', '') <> 'off'`;

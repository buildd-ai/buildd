import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { migrationLog } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateMigration, isTeamAdmin } from '@/lib/migrate-access';
import {
  collectMigrationSnapshot, classifyMigration, executeMigrationPhases, MigrationPhaseError,
} from '@/lib/workspace-migration';

/**
 * POST /api/workspaces/[id]/migrate/repair  (spec BT-11)
 *
 * Body: { runId }
 *
 * Resumes a partially-applied migration. `executeMigrationPhases` skips any phase already marked
 * `completed` in the `migration_log` for this runId, so re-invoking with the same runId re-runs
 * only from the first non-completed phase. Requires admin on the destination team (the workspace
 * has already moved there for any run that got past phase 1).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authenticateMigration(req);
  if (!auth || auth.type === 'denied') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (auth.type === 'dev') return NextResponse.json({ ok: false });

  let body: { runId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.runId) {
    return NextResponse.json({ error: 'runId is required' }, { status: 400 });
  }

  const rows = await db.query.migrationLog.findMany({ where: eq(migrationLog.runId, body.runId) });
  if (rows.length === 0) {
    return NextResponse.json({ error: 'Migration run not found' }, { status: 404 });
  }
  const ledger = rows[0];
  if (ledger.workspaceId !== id) {
    return NextResponse.json({ error: 'Migration run does not belong to this workspace' }, { status: 400 });
  }

  const { sourceTeamId, destinationTeamId } = ledger;
  if (!auth.teamIds.includes(destinationTeamId)) {
    return NextResponse.json({ error: 'Destination team not found' }, { status: 404 });
  }
  if (auth.type === 'session' && !(await isTeamAdmin(auth.userId, destinationTeamId))) {
    return NextResponse.json({ error: 'You must be an admin on the destination team to repair a migration.' }, { status: 403 });
  }

  if (rows.every((r) => r.status === 'completed')) {
    return NextResponse.json({ ok: true, runId: body.runId, alreadyComplete: true });
  }

  // Recompute the report against current state (identity moves are idempotent; deletes key on
  // workspaceId), so remaining phases have the context they need.
  const snapshot = await collectMigrationSnapshot(id, destinationTeamId);
  if (!snapshot) {
    return NextResponse.json({ error: 'Workspace or destination team not found' }, { status: 404 });
  }
  const migratedAt = new Date().toISOString();
  const report = classifyMigration(snapshot, migratedAt);

  try {
    const { outcomes, checklistArtifactId } = await executeMigrationPhases({
      runId: body.runId, workspaceId: id, sourceTeamId, destinationTeamId, report, migratedAt,
    });
    return NextResponse.json({ ok: true, runId: body.runId, resumed: true, outcomes, checklistArtifactId });
  } catch (err) {
    if (err instanceof MigrationPhaseError) {
      console.error(`[migrate repair] run ${body.runId} failed again at ${err.phase}`, err.cause);
      return NextResponse.json({ error: 'migration_failed', phase: err.phase, runId: body.runId, message: err.message }, { status: 500 });
    }
    console.error(`[migrate repair] run ${body.runId} unexpected failure`, err);
    return NextResponse.json({ error: 'migration_failed', runId: body.runId }, { status: 500 });
  }
}

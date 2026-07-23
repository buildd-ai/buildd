import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateMigration, isTeamAdmin } from '@/lib/migrate-access';
import {
  collectMigrationSnapshot, classifyMigration, verifyDryRunToken,
  executeMigrationPhases, MigrationPhaseError,
} from '@/lib/workspace-migration';

/**
 * POST /api/workspaces/[id]/migrate/execute  (spec BT-3…BT-10)
 *
 * Body: { destinationTeamId, dryRunToken, confirmedItems[] }
 *
 * Validates the actor (admin on both teams), the freshness/binding of the dry-run token, and that
 * every NEEDS_RE_ENTRY / NEEDS_RE_AUTH / WILL_BREAK item is acknowledged, then runs the entity
 * moves in the safe order under a `migration_log` ledger. The report is recomputed server-side —
 * the client cannot shrink the required acknowledgments.
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

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { id: true, teamId: true },
  });
  if (!ws || !auth.teamIds.includes(ws.teamId)) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  const sourceTeamId = ws.teamId;

  let body: { destinationTeamId?: string; dryRunToken?: string; confirmedItems?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { destinationTeamId, dryRunToken, confirmedItems } = body;
  if (!destinationTeamId || !dryRunToken) {
    return NextResponse.json({ error: 'destinationTeamId and dryRunToken are required' }, { status: 400 });
  }
  if (destinationTeamId === sourceTeamId) {
    return NextResponse.json({ error: 'same_team' }, { status: 400 });
  }
  if (!auth.teamIds.includes(destinationTeamId)) {
    return NextResponse.json({ error: 'Destination team not found' }, { status: 404 });
  }

  if (auth.type === 'session') {
    const [srcAdmin, dstAdmin] = await Promise.all([
      isTeamAdmin(auth.userId, sourceTeamId),
      isTeamAdmin(auth.userId, destinationTeamId),
    ]);
    if (!srcAdmin || !dstAdmin) {
      return NextResponse.json(
        { error: 'You must be an admin on both teams to migrate a workspace.' },
        { status: 403 },
      );
    }
  }

  const token = verifyDryRunToken(dryRunToken, id, destinationTeamId, Date.now());
  if (!token.valid) {
    return NextResponse.json({ error: 'invalid_token', reason: token.reason }, { status: 400 });
  }

  // Recompute the report server-side — the confirmation gate is checked against the ground truth,
  // never against client-supplied dispositions.
  const snapshot = await collectMigrationSnapshot(id, destinationTeamId);
  if (!snapshot) {
    return NextResponse.json({ error: 'Workspace or destination team not found' }, { status: 404 });
  }
  const migratedAt = new Date().toISOString();
  const report = classifyMigration(snapshot, migratedAt);

  if (report.precheck.status === 'FAIL') {
    return NextResponse.json({ error: 'precheck_failed', precheck: report.precheck }, { status: 409 });
  }

  const confirmed = new Set(confirmedItems ?? []);
  const missing = report.requiredAcks.filter((k) => !confirmed.has(k));
  if (missing.length > 0) {
    return NextResponse.json({ error: 'unconfirmed_items', missing }, { status: 400 });
  }

  const runId = randomUUID();
  try {
    const { outcomes, checklistArtifactId } = await executeMigrationPhases({
      runId, workspaceId: id, sourceTeamId, destinationTeamId, report, migratedAt,
    });
    return NextResponse.json({
      ok: true,
      runId,
      workspaceId: id,
      sourceTeamId,
      destinationTeamId,
      outcomes,
      checklistArtifactId,
    });
  } catch (err) {
    if (err instanceof MigrationPhaseError) {
      console.error(`[migrate execute] run ${runId} failed at ${err.phase}`, err.cause);
      return NextResponse.json(
        { error: 'migration_failed', phase: err.phase, runId, message: err.message },
        { status: 500 },
      );
    }
    console.error(`[migrate execute] run ${runId} unexpected failure`, err);
    return NextResponse.json({ error: 'migration_failed', runId }, { status: 500 });
  }
}

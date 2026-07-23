import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces, artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateMigration, isTeamAdmin } from '@/lib/migrate-access';
import { collectMigrationSnapshot, classifyMigration, signDryRunToken } from '@/lib/workspace-migration';

/**
 * POST /api/workspaces/[id]/migrate/precheck  (spec BT-2)
 *
 * Read-only. Validates the actor is admin on both the source and destination teams, runs the
 * GitHub-App gate, and returns the dry-run report (per-entity dispositions) plus a signed
 * `dryRunToken` the execute endpoint requires. No mutations beyond an audit artifact.
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
  if (auth.type === 'dev') return NextResponse.json({ report: null });

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
    columns: { id: true, teamId: true },
  });
  if (!ws || !auth.teamIds.includes(ws.teamId)) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  let body: { destinationTeamId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const destinationTeamId = body.destinationTeamId;
  if (!destinationTeamId) {
    return NextResponse.json({ error: 'destinationTeamId is required' }, { status: 400 });
  }
  if (destinationTeamId === ws.teamId) {
    return NextResponse.json({ error: 'same_team' }, { status: 400 });
  }
  if (!auth.teamIds.includes(destinationTeamId)) {
    return NextResponse.json({ error: 'Destination team not found' }, { status: 404 });
  }

  if (auth.type === 'session') {
    const [srcAdmin, dstAdmin] = await Promise.all([
      isTeamAdmin(auth.userId, ws.teamId),
      isTeamAdmin(auth.userId, destinationTeamId),
    ]);
    if (!srcAdmin || !dstAdmin) {
      return NextResponse.json(
        { error: 'You must be an admin on both teams to migrate a workspace.' },
        { status: 403 },
      );
    }
  }

  const snapshot = await collectMigrationSnapshot(id, destinationTeamId);
  if (!snapshot) {
    return NextResponse.json({ error: 'Workspace or destination team not found' }, { status: 404 });
  }

  const report = classifyMigration(snapshot, new Date().toISOString());
  const dryRunToken = signDryRunToken(id, destinationTeamId, Date.now());

  // Best-effort audit trail on the source workspace. Never block the dry run on this.
  try {
    await db.insert(artifacts).values({
      workspaceId: id,
      type: 'report',
      title: `Migration dry-run → ${report.destinationTeamName}`,
      content: JSON.stringify(report, null, 2),
      metadata: { kind: 'workspace-migration-dry-run', destinationTeamId },
    });
  } catch (err) {
    console.error('[migrate precheck] failed to persist dry-run artifact', err);
  }

  return NextResponse.json({ report, dryRunToken });
}

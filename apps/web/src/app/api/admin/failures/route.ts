import { NextRequest, NextResponse } from 'next/server';
import { beginAdminRead } from '@/lib/admin/scope';
import { viewFailures } from '@/lib/admin/tenant-privacy';

/**
 * GET /api/admin/failures — platform owner only (404 otherwise).
 *
 * Failure triage internals: ranked failure signatures, the family of
 * signatures sharing errorPrefix when given, and stalled knowledge ingest.
 * Query: window, teamId?, workspaceId?, errorPrefix?.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const errorPrefix = read.params.get('errorPrefix')?.trim().slice(0, 200) || null;
  const data = await viewFailures(read.viewer, { window: read.scope.window, errorPrefix });
  return NextResponse.json({ ...read.scope, since: read.scope.since.toISOString(), errorPrefix, ...data });
}

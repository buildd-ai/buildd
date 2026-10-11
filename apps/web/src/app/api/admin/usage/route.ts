import { NextRequest, NextResponse } from 'next/server';
import type { GroupDimension } from '@/lib/usage-stats';
import { beginAdminRead } from '@/lib/admin/scope';
import { loadUsage } from '@/lib/admin/data';

const GROUP_DIMENSIONS: GroupDimension[] = ['role', 'workspace', 'creationSource', 'none', 'executor'];

/**
 * GET /api/admin/usage — platform owner only (404 otherwise).
 *
 * The get_usage_stats rollup (tokens, cost, turns, tools per task) over any
 * scope, platform-wide by default. Query: window, teamId?, workspaceId?,
 * groupBy=role|workspace|creationSource|executor|none (default workspace).
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const groupBy = (read.params.get('groupBy') ?? 'workspace') as GroupDimension;
  if (!GROUP_DIMENSIONS.includes(groupBy)) {
    return NextResponse.json({ error: `groupBy must be one of ${GROUP_DIMENSIONS.join(', ')}` }, { status: 400 });
  }
  const usage = await loadUsage({ workspaceIds: read.workspaceIds, since: read.scope.since, groupBy });
  return NextResponse.json({ ...read.scope, since: read.scope.since.toISOString(), ...usage });
}

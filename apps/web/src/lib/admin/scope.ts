import { NextRequest, NextResponse } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { notFound, requirePlatformOwner } from './owner-gate';
import { resolveScopeWorkspaces } from './data';

export const ADMIN_WINDOWS = { '24h': 1, '7d': 7, '30d': 30 } as const;
export type AdminWindow = keyof typeof ADMIN_WINDOWS;

/**
 * What a platform-owner read covers. `teamId` and `workspaceId` are optional
 * narrowings; with neither, the read covers every workspace on the platform.
 */
export interface AdminScope {
  window: AdminWindow;
  since: Date;
  teamId: string | null;
  workspaceId: string | null;
}

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

export function parseAdminScope(params: URLSearchParams, now = Date.now()): { scope: AdminScope } | { response: NextResponse } {
  const window = params.get('window') ?? '7d';
  if (!(window in ADMIN_WINDOWS)) return { response: badRequest(`window must be one of ${Object.keys(ADMIN_WINDOWS).join(', ')}`) };
  const teamId = params.get('teamId');
  const workspaceId = params.get('workspaceId');
  if (teamId !== null && !isUuid(teamId)) return { response: badRequest('teamId must be a UUID') };
  if (workspaceId !== null && !isUuid(workspaceId)) return { response: badRequest('workspaceId must be a UUID') };
  return {
    scope: {
      window: window as AdminWindow,
      since: new Date(now - ADMIN_WINDOWS[window as AdminWindow] * 86_400_000),
      teamId,
      workspaceId,
    },
  };
}

type Owner = NonNullable<Awaited<ReturnType<typeof requirePlatformOwner>>['account']>;
export type AdminRead = { account: Owner; scope: AdminScope; workspaceIds: string[]; params: URLSearchParams };

/**
 * Gate, then scope: the owner check runs first, so a non-owner gets the same
 * 404 whatever query string they sent. A team or workspace that does not
 * exist is a 404 too.
 */
export async function beginAdminRead(req: NextRequest): Promise<AdminRead | { response: NextResponse }> {
  const gate = await requirePlatformOwner(req);
  if (gate.response) return { response: gate.response };
  const params = req.nextUrl.searchParams;
  const parsed = parseAdminScope(params);
  if ('response' in parsed) return parsed;
  const resolved = await resolveScopeWorkspaces(parsed.scope);
  if (!resolved) return { response: notFound() };
  return { account: gate.account, scope: parsed.scope, workspaceIds: resolved.workspaceIds, params };
}

/** Bounded integer query param. */
export function intParam(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const n = Number.parseInt(params.get(name) ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

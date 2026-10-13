import { NextRequest, NextResponse } from 'next/server';
import { RECOVERY_FILTERS, type RecoveryFilter } from '@buildd/shared';
import { beginAdminRead } from '@/lib/admin/scope';
import { loadRecoveryCause, loadRecoveryQueue } from '@/lib/admin/data';
import { viewOperator } from '@/lib/admin/tenant-privacy';
import { requirePlatformOwner } from '@/lib/admin/owner-gate';

const CAUSE_KEY_RE = /^c1:[0-9a-f]{20}$/;

/**
 * GET /api/admin/operator — platform owner only (404 otherwise).
 *
 * The Health → Operator panels not served by another admin route: delegated
 * subagent time, error-trace pattern cost, and PRs buildd cannot resolve.
 * A panel whose read failed is null. Query: window, teamId?, workspaceId?.
 *
 * The recovery queue (operator console recovery spec §7.1) is opt-in, so
 * existing callers get the same response:
 *  - `recovery=1` adds `recovery`, the ranked causes across the scope.
 *  - `recoveryInclude=recovered` adds causes recovered in the last 7 days.
 *  - `recoveryFilter=<metric>` narrows `recovery.causes` to one §10.3 metric.
 *  - `recoveryCause=<causeKey>` adds `recoveryCause`, the drill-down.
 * A team or workspace scope only ever reads that scope's incidents, so a
 * scoped read never names another team.
 */
export async function GET(req: NextRequest) {
  const read = await beginAdminRead(req);
  if ('response' in read) return read.response;
  const { params, scope } = read;

  const wantsRecovery = params.get('recovery') === '1';
  const include = params.get('recoveryInclude');
  if (include !== null && include !== 'recovered') return NextResponse.json({ error: 'recoveryInclude must be recovered' }, { status: 400 });
  const filter = params.get('recoveryFilter');
  if (filter !== null && !(RECOVERY_FILTERS as readonly string[]).includes(filter)) {
    return NextResponse.json({ error: `recoveryFilter must be one of ${RECOVERY_FILTERS.join(', ')}` }, { status: 400 });
  }
  const causeKey = params.get('recoveryCause');
  if (causeKey !== null && !CAUSE_KEY_RE.test(causeKey)) return NextResponse.json({ error: 'recoveryCause must be a cause key (c1:<20 hex>)' }, { status: 400 });

  const recoveryOpts = { workspaceIds: read.workspaceIds, platformWide: !scope.teamId && !scope.workspaceId, window: scope.window };
  const logged = (panel: string) => (err: unknown) => {
    console.error(`[admin/operator] ${panel} read failed`, err instanceof Error ? err.message : err);
    return null;
  };
  const [data, recovery, recoveryCause] = await Promise.all([
    viewOperator(read.viewer, scope.since),
    wantsRecovery || include || filter
      ? loadRecoveryQueue({ ...recoveryOpts, includeRecovered: include === 'recovered', filter: (filter ?? undefined) as RecoveryFilter | undefined }).catch(logged('recovery'))
      : Promise.resolve(undefined),
    causeKey ? loadRecoveryCause({ ...recoveryOpts, causeKey }).catch(logged('recoveryCause')) : Promise.resolve(undefined),
  ]);
  return NextResponse.json({
    ...scope,
    since: scope.since.toISOString(),
    ...data,
    ...(recovery !== undefined ? { recovery } : {}),
    ...(recoveryCause !== undefined ? { recoveryCause } : {}),
  });
}

/**
 * POST /api/admin/operator — platform owner only (404 otherwise, nothing
 * written). One owner recovery action (operator-recovery spec §7.2): body
 * `{ capability, target, evidenceRevision, params?, reason }`, header
 * `X-Admin-Operator: <login>` recorded as the operator label (never trusted
 * for authorization). 200 applied or duplicate; 409 stale, with the fresh row;
 * 422 rejected (precondition, budget, paused, not_supported), with the fresh
 * row; 400 for anything outside the closed set.
 */
export async function POST(req: NextRequest) {
  const gate = await requirePlatformOwner(req);
  if (gate.response) return gate.response;
  const body = await req.json().catch(() => null);
  const label = req.headers.get('x-admin-operator')?.trim() || null;
  const operatorLabel = label && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(label) ? label : null;
  try {
    const [{ handleOperatorRecoveryAction }, { productionOperatorActionDeps }] = await Promise.all([
      import('./recovery-action'), import('./recovery-action-deps'),
    ]);
    const out = await handleOperatorRecoveryAction(await productionOperatorActionDeps(), { accountId: gate.account.id, operatorLabel }, body);
    return NextResponse.json(out.body, { status: out.status });
  } catch (err) {
    console.error('[admin/operator] POST failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

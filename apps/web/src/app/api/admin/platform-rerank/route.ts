import { NextRequest, NextResponse } from 'next/server';
import { authorizePlatformAdmin } from '@/lib/platform-admin';
import { recordPlatformAdminAudit } from '@/lib/admin/audit';
import { readPlatformRerankRow, setPlatformRerankEnabled } from '@buildd/core/platform-rerank-switch';

/**
 * GET / PUT /api/admin/platform-rerank
 *
 * The platform switch for reranking with the platform's Voyage key
 * (packages/core/platform-rerank-switch.ts). Default OFF; a missing or unreadable
 * value is OFF. While OFF, retrieval returns the fused (BM25 + vector) order with
 * no Voyage rerank call. A team's own key is not affected.
 *
 * GET -> 200 { enabled: boolean, defaultEnabled: false, stored: boolean }
 * PUT body { "enabled": true | false } -> 200 { enabled, previous }
 *   400 when the body is not an explicit boolean; nothing is written.
 *
 * Auth: platform admin API key only (BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS, see
 * lib/platform-admin.ts). Every PUT writes one platform_admin_audit_events row
 * (actor account, time, before and after). A write whose audit row fails
 * answers 500.
 *
 * Other processes pick a change up within the 60s cache TTL.
 */

const SETTING_TARGET_ID = 'rerank_on_platform_key';

export async function GET(req: NextRequest) {
  const gate = await authorizePlatformAdmin(req);
  if (gate.response) return gate.response;

  const row = await readPlatformRerankRow();
  return NextResponse.json({
    enabled: row?.enabled ?? false,
    defaultEnabled: false,
    stored: row !== null,
  });
}

export async function PUT(req: NextRequest) {
  const gate = await authorizePlatformAdmin(req);
  if (gate.response) return gate.response;

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'body must be { "enabled": true | false }' }, { status: 400 });
  }

  const { before, after } = await setPlatformRerankEnabled(enabled);
  try {
    await recordPlatformAdminAudit({
      actorAccountId: gate.account.id,
      action: 'platform_setting.update',
      targetType: 'platform_setting',
      targetId: SETTING_TARGET_ID,
      teamId: null,
      before: { enabled: before },
      after: { enabled: after },
    });
  } catch (err) {
    console.error('[platform-rerank] write landed but its audit row failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'audit write failed; the switch was changed, retry to confirm' }, { status: 500 });
  }

  return NextResponse.json({ enabled: after, previous: before });
}

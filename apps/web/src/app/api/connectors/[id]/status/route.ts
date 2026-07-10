import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectors, secrets } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';

async function authenticateRequest(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await authenticateApiKey(apiKey);
    if (account) {
      if (account.level !== 'admin') return { type: 'denied' as const };
      return { type: 'api' as const, account };
    }
  }

  if (process.env.NODE_ENV !== 'development') {
    const user = await getCurrentUser();
    if (user) return { type: 'session' as const, user };
  } else {
    return { type: 'dev' as const };
  }

  return null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authenticateRequest(req);
  if (!auth || auth.type === 'denied') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (auth.type === 'dev') {
    return NextResponse.json({ status: 'not_connected' });
  }

  const teamIds = auth.type === 'api' ? [auth.account.teamId] : await getUserTeamIds(auth.user.id);

  const connector = await db.query.connectors.findFirst({
    where: eq(connectors.id, id),
    columns: { id: true, teamId: true },
  });
  if (!connector || !teamIds.includes(connector.teamId)) {
    return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
  }

  const secret = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.teamId, connector.teamId),
      eq(secrets.purpose, 'mcp_connector_credential'),
      eq(secrets.label, id),
    ),
    columns: { tokenExpiresAt: true },
  });

  if (!secret) {
    return NextResponse.json({ status: 'not_connected' });
  }

  const now = new Date();
  if (secret.tokenExpiresAt && secret.tokenExpiresAt < now) {
    return NextResponse.json({ status: 'expired', expiresAt: secret.tokenExpiresAt });
  }

  return NextResponse.json({
    status: 'connected',
    ...(secret.tokenExpiresAt ? { expiresAt: secret.tokenExpiresAt } : {}),
  });
}

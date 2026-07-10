import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { connectors, secrets } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { authenticateApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { getSecretsProvider } from '@buildd/core/secrets';

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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await authenticateRequest(req);
  if (!auth || auth.type === 'denied') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (auth.type === 'dev') {
    return NextResponse.json({ success: true });
  }

  const teamIds = auth.type === 'api' ? [auth.account.teamId] : await getUserTeamIds(auth.user.id);

  const connector = await db.query.connectors.findFirst({
    where: eq(connectors.id, id),
    columns: { id: true, teamId: true },
  });
  if (!connector || !teamIds.includes(connector.teamId)) {
    return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
  }

  try {
    const secretRows = await db.query.secrets.findMany({
      where: and(
        eq(secrets.teamId, connector.teamId),
        eq(secrets.purpose, 'mcp_connector_credential'),
        eq(secrets.label, id),
      ),
      columns: { id: true },
    });

    if (secretRows.length === 0) {
      return NextResponse.json({ success: true, alreadyDisconnected: true });
    }

    const provider = getSecretsProvider();
    await Promise.all(secretRows.map(s => provider.delete(s.id)));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Disconnect error:', error);
    return NextResponse.json({ error: 'Failed to disconnect connector' }, { status: 500 });
  }
}

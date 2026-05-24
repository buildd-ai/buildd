import { NextResponse } from 'next/server';
import { getIssuer, getResourceUrl, OAUTH_SCOPES } from '@/lib/oauth/config';

export const dynamic = 'force-dynamic';

// RFC 9728: protected-resource metadata. Clients fetch this URL (advertised via
// the WWW-Authenticate `resource_metadata` hint) to learn which authorization
// server issues tokens for this resource and which scopes it accepts.
//
// Encoded with the workspace in the path so each workspace can serve its own
// metadata pointing at its own workspace-scoped resource URL.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ workspace: string }> },
) {
  const { workspace } = await params;
  return NextResponse.json({
    resource: getResourceUrl(workspace),
    authorization_servers: [getIssuer()],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ['header'],
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}

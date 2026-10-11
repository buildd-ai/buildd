import { NextResponse } from 'next/server';
import { getAccountResourceUrl, getIssuer } from '@/lib/oauth/config';
import { ACCOUNT_SCOPES_SUPPORTED } from '@/lib/oauth/account-consent';

export const dynamic = 'force-dynamic';

// RFC 9728 protected-resource metadata for the account-level MCP resource
// (`<issuer>/api/mcp`). A client that requests a token for this resource goes
// through the account consent page and gets a token bound to a grant over the
// workspaces the person chose, not to one workspace. The per-workspace
// metadata at ./mcp-oauth/[workspace] is unchanged.
export async function GET() {
  return NextResponse.json({
    resource: getAccountResourceUrl(),
    authorization_servers: [getIssuer()],
    scopes_supported: ACCOUNT_SCOPES_SUPPORTED,
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

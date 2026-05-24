import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/oauth/storage';

export const dynamic = 'force-dynamic';

// RFC 7591: Dynamic Client Registration. claude.ai (and any compliant MCP
// client) POSTs here to obtain a client_id before kicking off the OAuth flow.
// We accept public clients only (PKCE-protected, no client_secret).
const RegisterSchema = z.object({
  redirect_uris: z.array(z.string().url()).min(1),
  client_name: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_client_metadata' }, { status: 400 });
  }
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_client_metadata', error_description: parsed.error.message },
      { status: 400 },
    );
  }

  const { clientId } = await createClient({
    clientName: parsed.data.client_name,
    redirectUris: parsed.data.redirect_uris,
  });

  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: parsed.data.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_name: parsed.data.client_name,
    },
    { status: 201 },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, authorization',
    },
  });
}

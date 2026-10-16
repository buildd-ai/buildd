import { createHash } from 'crypto';
import { incrWindow } from '@/lib/redis';
import { reservedNameAllowed } from '@/lib/oauth/client-policy';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, isSafeRedirectUri } from '@/lib/oauth/storage';

const REGISTER_LIMIT = 10;
const WINDOW_SECONDS = 3600;

export const dynamic = 'force-dynamic';

// RFC 7591: Dynamic Client Registration. claude.ai (and any compliant MCP
// client) POSTs here to obtain a client_id before kicking off the OAuth flow.
// We accept public clients only (PKCE-protected, no client_secret).
const RegisterSchema = z.object({
  redirect_uris: z
    .array(
      z
        .string()
        .url()
        .refine(isSafeRedirectUri, {
          message: 'Use HTTPS or loopback HTTP without credentials or fragments',
        }),
    )
    .min(1),
  client_name: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

export async function POST(req: NextRequest) {
  // Vercel overwrites x-forwarded-for at the trusted ingress. Do not use
  // caller-controlled real-ip headers as an alternative bucket identity.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const window = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  const key = createHash('sha256').update(ip).digest('hex');
  const count = await incrWindow(`oauth:register:${window}:${key}`, WINDOW_SECONDS);
  // Open registration stays public, but must not bypass its shared limit
  // during a Redis outage.
  if (count === null) {
    return NextResponse.json({ error: 'temporarily_unavailable' }, {
      status: 503, headers: { 'Retry-After': '60' },
    });
  }
  if (count > REGISTER_LIMIT) {
    const retryAfter = WINDOW_SECONDS - Math.floor(Date.now() / 1000) % WINDOW_SECONDS;
    return NextResponse.json({ error: 'rate_limit_exceeded' }, {
      status: 429, headers: { 'Retry-After': String(Math.max(1, retryAfter)) },
    });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_client_metadata' }, { status: 400 });
  }
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues.some(issue => issue.path[0] === 'redirect_uris')
          ? 'invalid_redirect_uri' : 'invalid_client_metadata',
        error_description: parsed.error.message,
      },
      { status: 400 },
    );
  }

  if (!reservedNameAllowed(parsed.data.client_name, parsed.data.redirect_uris)) {
    return NextResponse.json({
      error: 'invalid_client_metadata',
      error_description: 'This app name is reserved for its known redirect hosts.',
    }, { status: 400 });
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

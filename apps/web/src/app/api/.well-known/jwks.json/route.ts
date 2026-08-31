// GET /api/.well-known/jwks.json
//
// Returns the buildd JWKS document (RFC 7517) containing the public key(s)
// used to verify assertion JWTs. Resource servers MUST cache this response
// for at least max-age (1 hour) and MUST re-fetch on unknown kid.
//
// On first call (no signing keys exist), generates an Active keypair and
// returns it immediately so the endpoint is always ready.

import { NextResponse } from 'next/server';
import { getAllPublicKeys, createActiveSigningKey } from '@/lib/signing-keys';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    let keys = await getAllPublicKeys();

    // Bootstrap: generate an Active key if none exist.
    if (keys.length === 0) {
      await createActiveSigningKey(new Date());
      keys = await getAllPublicKeys();
    }

    const jwks = {
      keys: keys.map(({ kid, publicKeyJwk }) => ({
        kty: publicKeyJwk.kty,
        crv: (publicKeyJwk as { crv?: string }).crv,
        kid,
        use: 'sig',
        alg: 'ES256',
        x: (publicKeyJwk as { x?: string }).x,
        y: (publicKeyJwk as { y?: string }).y,
      })),
    };

    // Never cache an unusable document. An empty set (failed/raced bootstrap) or
    // a row without key material serialises to something that still looks like a
    // JWKS — JSON.stringify drops the undefined members — and a 200 would pin
    // that failure in caches for an hour, including the RFC-mandated re-fetch on
    // unknown kid.
    const usable = jwks.keys.length > 0 && jwks.keys.every(
      k => Boolean(k.kty) && Boolean(k.crv) && Boolean(k.kid) && Boolean(k.x) && Boolean(k.y),
    );
    if (!usable) {
      console.error(
        `[JWKS] Refusing to publish an unusable key set (${jwks.keys.length} entr${jwks.keys.length === 1 ? 'y' : 'ies'})`,
      );
      return NextResponse.json({ error: 'jwks_unavailable' }, {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    return NextResponse.json(jwks, {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
      },
    });
  } catch (err) {
    console.error('[JWKS] Failed to serve JWKS:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

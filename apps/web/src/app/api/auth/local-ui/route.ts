import { NextRequest, NextResponse } from 'next/server';

// Redirect to the generalized CLI auth endpoint with client=local-ui
// This maintains backward compatibility for existing local-ui installations
export async function GET(req: NextRequest) {
  const url = new URL('/api/auth/cli', req.url);

  // Forward all existing query params
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  // Set client=local-ui (unless already set)
  if (!url.searchParams.has('client')) {
    url.searchParams.set('client', 'local-ui');
  }

  return NextResponse.redirect(url);
}

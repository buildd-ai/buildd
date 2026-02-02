import { NextRequest, NextResponse } from 'next/server';

export function proxy(request: NextRequest) {
  const hostname = request.headers.get('host') || '';
  const pathname = request.nextUrl.pathname;

  // app.* subdomain (prod: app.buildd.dev, dev: app.localhost:*)
  const isAppDomain = hostname.startsWith('app.');

  // API routes work on both domains
  if (pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Static assets - skip
  if (pathname.startsWith('/_next/') || pathname.includes('.')) {
    return NextResponse.next();
  }

  if (isAppDomain) {
    // Rewrite to /app/* for app subdomain
    if (!pathname.startsWith('/app')) {
      return NextResponse.rewrite(new URL(`/app${pathname}`, request.url));
    }
  } else {
    // Marketing domain - block /app/* access
    if (pathname.startsWith('/app')) {
      return NextResponse.redirect(new URL('/', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png).*)'],
};

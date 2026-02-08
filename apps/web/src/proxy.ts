import { NextRequest, NextResponse } from 'next/server';

export function proxy(request: NextRequest) {
  const hostname = request.headers.get('host') || '';

  // www.* subdomain → redirect to root domain
  if (hostname.startsWith('www.')) {
    const rootDomain = hostname.replace(/^www\./, '');
    const url = new URL(request.url);
    url.host = rootDomain;
    return NextResponse.redirect(url, 301);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png).*)'],
};

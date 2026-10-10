/**
 * The slice of `next/server` the execution handlers use, on the Workers
 * runtime: NextRequest (a Request with nextUrl), NextResponse (Response with
 * json/redirect) and after() (ctx.waitUntil of the current request).
 */
import { currentWaitUntil } from './request-context';

export class NextRequest extends Request {
  readonly nextUrl: URL;
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input as RequestInfo, init);
    this.nextUrl = new URL(this.url);
  }
}

export class NextResponse extends Response {
  static json(body: unknown, init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new NextResponse(JSON.stringify(body), { ...init, headers });
  }
  static redirect(url: string | URL, init?: number | ResponseInit): NextResponse {
    const status = typeof init === 'number' ? init : (init?.status ?? 307);
    const headers = new Headers(typeof init === 'object' ? init.headers : undefined);
    headers.set('location', String(url));
    return new NextResponse(null, { status, headers });
  }
  static next(): NextResponse { return new NextResponse(null, { status: 200 }); }
}

export function after(task: Promise<unknown> | (() => unknown)): void {
  const waitUntil = currentWaitUntil();
  if (!waitUntil) throw new Error('after() called outside a request scope');
  waitUntil(Promise.resolve().then(() => (typeof task === 'function' ? task() : task)));
}

export function userAgent(): { ua: string } { return { ua: '' }; }

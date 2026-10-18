/**
 * Render a protected page's server component the way a request runs it, for
 * the budget tests (Living Spec "Fast at any size": R-14, R-15, R-30, AC-3).
 *
 * `installPageRenderMocks()` must run at the top of a test file, before the
 * page is imported. It signs a user in, gives React's `cache()` a request
 * scope (`requestScopedReact`), collects after() work without running it, and
 * makes the GitHub client fail on any call while saying GitHub is configured,
 * so no caller skips it for want of credentials. `render()` also fails any
 * fetch that is not the database's, and reports every outside call it saw.
 */
import { mock } from 'bun:test';
import { requestScopedReact } from './budget-harness';

/** Pure helpers of lib/github: they never reach GitHub, so they stay real. */
const PURE_GITHUB = new Set(['githubAppBotLogin', 'getGitHubAppConfig', 'retryAfterFromHeaders', 'isOwnPrReviewRefusal', 'checkSuitesAllPassed', 'dropSupersededSuites', 'verifyWebhookSignature']);

export interface PageRender<T> {
  /** Hosts fetched that are not the database, and GitHub client calls (`github:<fn>`). */
  outside: string[];
  /** console.error calls during the render, first argument and the error's message. */
  errors: string[];
  tree: T;
}

export async function installPageRenderMocks() {
  let signedIn: string | null = null;
  mock.module('../../src/auth', () => ({ auth: async () => (signedIn ? { user: { id: signedIn } } : null) }));
  mock.module('next/headers', () => ({
    cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
    headers: async () => new Headers(),
  }));
  const deferred: Array<() => unknown> = [];
  const nextServer = await import('next/server');
  mock.module('next/server', () => ({ ...nextServer, after: (fn: () => unknown) => { deferred.push(fn); } }));
  const react = requestScopedReact(await import('react'));
  mock.module('react', () => react.mod);
  const githubCalls: string[] = [];
  const github = await import('../../src/lib/github');
  mock.module('../../src/lib/github', () => Object.fromEntries(Object.entries(github).map(([name, value]) => {
    if (name === 'isGitHubAppConfigured') return [name, () => true];
    if (typeof value !== 'function' || PURE_GITHUB.has(name)) return [name, value];
    return [name, (..._args: unknown[]) => { githubCalls.push(name); throw new Error(`GitHub called while rendering: ${name}`); }];
  })));

  return {
    deferred,
    /** A new request as `userId`, whose layout already ran `layoutReads`. */
    async newRequest(userId: string, layoutReads: () => Promise<unknown> = async () => {}): Promise<void> {
      react.reset();
      deferred.length = 0;
      signedIn = userId;
      await layoutReads();
    },
    async render<T>(page: () => Promise<T>): Promise<PageRender<T>> {
      githubCalls.length = 0;
      const outside: string[] = [];
      const errors: string[] = [];
      const realFetch = globalThis.fetch;
      const dbHost = new URL(process.env.NEON_LOCAL_FETCH_ENDPOINT!).host;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.host === dbHost) return realFetch(input, init);
        outside.push(url.host);
        throw new Error(`outside call while rendering: ${url.host}`);
      }) as typeof fetch;
      const realError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(a => (a instanceof Error ? `${a.message} cause: ${String((a as { cause?: unknown }).cause)}` : String(a))).join(' ').slice(0, 400));
      };
      try {
        const tree = await page();
        return { outside: [...outside, ...githubCalls.map(c => `github:${c}`)], errors, tree };
      } finally {
        globalThis.fetch = realFetch;
        console.error = realError;
      }
    },
  };
}

/** The rendered element tree as text: props and strings, no functions, React's own bookkeeping or cycles. */
export function treeText(tree: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(tree, (k, v) => {
    if (typeof v === 'function' || typeof v === 'symbol' || k === '_owner' || k === '_store' || k === '_debugInfo' || k === '_debugStack' || k === '_debugTask') return undefined;
    if (v && typeof v === 'object') {
      if (seen.has(v)) return undefined;
      seen.add(v);
    }
    return v;
  });
}

export const isWrite = (operation: string) => ['insert', 'update', 'delete', 'merge'].includes(operation);

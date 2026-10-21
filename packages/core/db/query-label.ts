/**
 * Every Neon query names the loader that made it.
 *
 * neon-http sends each query (and each `db.batch`) as one POST through
 * `neonConfig.fetchFunction`. @vercel/otel's fetch instrumentation turns that
 * POST into the "Neon query span", already carrying its duration and the
 * response's byte length, and it copies `init.opentelemetry.attributes` onto
 * the span. So one hook at the fetch covers Drizzle everywhere (select,
 * relational query, execute, insert/update, batch) with no per-call change:
 *
 *   buildd.db.loader         `withLoaderLabel('home.missions', fn)`'s label, else
 *                            the first app frame on the stack (`file:line fn`),
 *                            else 'unlabelled'
 *   buildd.db.loader_source  label | stack | none
 *   db.query.summary         a short normalized SQL head: literals replaced by
 *                            `?`, `$n` placeholders kept, never a bound value
 *   db.operation.name        select | insert | update | delete | with | ...
 *   db.collection.name       the statement's top-level table, when it has one
 *   db.operation.batch.size  statements in the POST (1 unless a batch)
 *
 * Params are never read: the summary comes from the `query` text only.
 *
 * The stack fallback needs async stack frames, which Node (production) keeps
 * through the driver and Bun does not, so under Bun an unlabelled query reads
 * 'unlabelled'. Label loaders explicitly where grouping matters.
 *
 * `recordNeonQueries(fn)` is the test side (apps/web/tests/db budget tests):
 * it counts the POSTs and statements `fn` makes and the bytes Neon returned.
 * Only a recording scope buffers a response body; production never does.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { neonConfig } from '@neondatabase/serverless';

export interface RecordedQuery {
  label: string;
  operation: string;
  table: string | null;
  head: string;
  statements: number;
  bytes: number;
  durationMs: number;
}

export interface QueryRecording<T> {
  result: T;
  /** Round trips to Neon (a batch is one). */
  count: number;
  /** SQL statements across those round trips. */
  statements: number;
  /** Response body bytes Neon returned, summed. */
  bytes: number;
  queries: RecordedQuery[];
  byLabel: Record<string, { count: number; bytes: number }>;
}

interface Scope {
  label?: string;
  recorder?: RecordedQuery[];
}

const scope = new AsyncLocalStorage<Scope>();

/**
 * Run `fn` with every Neon query it makes (transitively) labelled `label`.
 *
 * A Drizzle or neon query is a lazy thenable that runs only when awaited, so
 * `fn` may return one un-run: it is started here, inside the scope, rather
 * than by the caller's `await` outside it.
 */
export function withLoaderLabel<T>(label: string, fn: () => T | PromiseLike<T>): Promise<T> {
  return scope.run({ ...scope.getStore(), label }, () => {
    const out = fn();
    return new Promise<T>((resolve, reject) => {
      if (out && typeof (out as PromiseLike<T>).then === 'function') (out as PromiseLike<T>).then(resolve, reject);
      else resolve(out as T);
    });
  });
}

export function currentLoaderLabel(): string | undefined {
  return scope.getStore()?.label;
}

/** True inside `recordNeonQueries`: a nested recording would take its queries. */
export function isRecordingNeonQueries(): boolean {
  return Boolean(scope.getStore()?.recorder);
}

/** Run `fn`, recording every Neon round trip it makes. */
export async function recordNeonQueries<T>(fn: () => Promise<T>): Promise<QueryRecording<T>> {
  const recorder: RecordedQuery[] = [];
  const result = await scope.run({ ...scope.getStore(), recorder }, fn);
  // Work still in flight (after(), fire-and-forget writes) lands in `recorder`
  // later; the recording is what `fn` had done when it resolved.
  const queries = recorder.slice();
  const byLabel: QueryRecording<T>['byLabel'] = {};
  for (const q of queries) {
    const b = (byLabel[q.label] ??= { count: 0, bytes: 0 });
    b.count += 1;
    b.bytes += q.bytes;
  }
  return {
    result,
    count: queries.length,
    statements: queries.reduce((n, q) => n + q.statements, 0),
    bytes: queries.reduce((n, q) => n + q.bytes, 0),
    queries,
    byLabel,
  };
}

const HEAD_MAX = 120;
// How much of the query text is read for the summary. A relational query's
// select list can be long; the top-level FROM is usually inside this.
const SCAN_MAX = 4000;

/** Operation, top-level table and a literal-free head of one SQL statement. */
export function summarizeSql(query: string): { operation: string; table: string | null; head: string } {
  const text = query.slice(0, SCAN_MAX)
    .replace(/'(?:[^']|'')*'?/g, '?')
    .replace(/(?<![\w$."])\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
  const operation = /^\(?\s*([a-z]+)/i.exec(text)?.[1]?.toLowerCase() ?? 'unknown';
  return { operation, table: topLevelTable(text, operation), head: text.replace(/"/g, '').slice(0, HEAD_MAX) };
}

function topLevelTable(text: string, operation: string): string | null {
  const keyword = operation === 'update' ? 'update' : operation === 'insert' ? 'into' : 'from';
  const re = new RegExp(`\\b${keyword}\\s+((?:"[^"]+"|[\\w]+)(?:\\.(?:"[^"]+"|[\\w]+))?)`, 'gi');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (depthAt(text, m.index) === 0) return m[1].replace(/"/g, '');
  }
  return null;
}

function depthAt(text: string, index: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < index; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
  }
  return depth;
}

// The first JSON string value after `"query":"` in a Neon request body, read
// without parsing the body (it carries the params, which can be large).
function firstQueryText(body: string): string {
  const start = body.indexOf('"query":"');
  if (start < 0) return '';
  const from = start + '"query":"'.length;
  const limit = Math.min(body.length, from + SCAN_MAX * 2);
  let end = from;
  while (end < limit && body[end] !== '"') end += body[end] === '\\' ? 2 : 1;
  let literal = body.slice(from, Math.min(end, limit));
  // Truncated mid-escape: drop the partial escape so it still decodes.
  literal = literal.replace(/\\(u[0-9a-fA-F]{0,3})?$/, '');
  try {
    return JSON.parse(`"${literal}"`);
  } catch {
    return '';
  }
}

function countStatements(body: string): number {
  if (!body.startsWith('{"queries"')) return 1;
  // Inside a JSON string a quote is escaped, so this sequence is structural.
  let n = 0;
  for (let i = body.indexOf('{"query":"'); i >= 0; i = body.indexOf('{"query":"', i + 1)) n++;
  return n;
}

export type LoaderSource = 'label' | 'stack' | 'none';

export function neonQueryAttributes(body: string, loader: { label: string; source: LoaderSource }) {
  const summary = summarizeSql(firstQueryText(body));
  const attrs: Record<string, string | number> = {
    'db.system.name': 'postgresql',
    'buildd.db.loader': loader.label,
    'buildd.db.loader_source': loader.source,
    'db.query.summary': summary.head,
    'db.operation.name': summary.operation,
    'db.operation.batch.size': countStatements(body),
  };
  if (summary.table) attrs['db.collection.name'] = summary.table;
  return attrs;
}

// Frames that are the driver or this module, never the caller.
const SKIP_FRAME = /node_modules|\/packages\/core\/db\/|^node:|\(node:|native|<anonymous>/;

/** `file:line fn` of the first application frame in `stack`. */
export function callerSiteFromStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  for (const line of stack.split('\n').slice(1)) {
    const m = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line);
    if (!m) continue;
    const [, fn, file] = m;
    if (SKIP_FRAME.test(file) || SKIP_FRAME.test(line)) continue;
    const short = file
      .replace(/^file:\/\//, '')
      .replace(/^.*?\/((?:apps|packages)\/.*)$/, '$1')
      .replace(/^.*?\/(\.next\/.*)$/, '$1');
    const name = fn?.replace(/^(?:Object|Module)\./, '');
    return `${short}:${m[3]}${name ? ` ${name}` : ''}`;
  }
  return undefined;
}

function resolveLoader(store: Scope | undefined): { label: string; source: LoaderSource } {
  if (store?.label) return { label: store.label, source: 'label' };
  const site = callerSiteFromStack(new Error().stack);
  return site ? { label: site, source: 'stack' } : { label: 'unlabelled', source: 'none' };
}

type FetchLike = (url: any, init?: any) => Promise<Response>;

/**
 * A `neonConfig.fetchFunction` that labels the request for the fetch span and,
 * inside `recordNeonQueries`, measures it. `base` defaults to the global fetch
 * looked up per call, so the instrumented one is used once OTel registers.
 */
export function labelledFetch(base?: FetchLike): FetchLike {
  return async (url, init = {}) => {
    const doFetch = base ?? (globalThis.fetch as FetchLike);
    const store = scope.getStore();
    const body = typeof init.body === 'string' ? init.body : '';
    const loader = resolveLoader(store);
    const attributes = neonQueryAttributes(body, loader);
    const started = performance.now();
    const res = await doFetch(url, {
      ...init,
      opentelemetry: { ...init.opentelemetry, attributes: { ...init.opentelemetry?.attributes, ...attributes } },
    });
    if (!store?.recorder) return res;
    const buf = await res.arrayBuffer();
    store.recorder.push({
      label: loader.label,
      operation: String(attributes['db.operation.name']),
      table: (attributes['db.collection.name'] as string | undefined) ?? null,
      head: String(attributes['db.query.summary']),
      statements: Number(attributes['db.operation.batch.size']),
      bytes: buf.byteLength,
      durationMs: performance.now() - started,
    });
    return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

let installed = false;

/** Route every neon-http query through `labelledFetch`. Idempotent. */
export function installNeonQueryLabels(): void {
  if (installed) return;
  neonConfig.fetchFunction = labelledFetch(neonConfig.fetchFunction ?? undefined);
  installed = true;
}

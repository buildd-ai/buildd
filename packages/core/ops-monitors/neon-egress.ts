/**
 * The database-egress alert (Living Spec "Fast at any size", R-28, R-42):
 * the owner is paged when Neon sends out more than 1 GB in an hour.
 *
 * It is an Axiom monitor on dataset `buildd-traces`, not code that runs here:
 * the data is the response size on every Neon query span (`neon-http` POSTs to
 * `*.neon.tech/sql`, instrumented by @vercel/otel), and the loader that made
 * the query rides on the same span (`buildd.db.loader`, packages/core/db/query-label.ts).
 * This module is the recorded definition, so the monitor can be recreated
 * and so a test pins its field names to the ones the code emits. Create it with
 * `POST /v2/monitors` (or in the Axiom UI) and attach the owner's email and
 * Pushover notifiers; notifier ids are per Axiom org and are not recorded here.
 */

export const NEON_EGRESS_LIMIT_BYTES = 1024 ** 3;
export const NEON_EGRESS_DATASET = 'buildd-traces';
/** Uncompressed body size, set by the fetch instrumentation on every Neon client span. */
export const NEON_BYTES_FIELD = "['attributes.custom']['http.response_content_length_uncompressed']";
export const NEON_LOADER_FIELD = "['attributes.custom']['buildd.db.loader']";
/** A Neon client span: the SQL-over-HTTP endpoint, in production only. */
const NEON_SPAN_FILTER = `['resource.custom']['node.env'] == "production" and kind == "client" and tostring(['attributes.custom']['http.url']) has "neon.tech"`;

/** The monitor: one value `v`, bytes sent out in the last hour. */
export const NEON_EGRESS_MONITOR = {
  name: 'Database data sent out above 1 GB in an hour',
  description:
    'Neon response bytes over the last hour. When it fires, run NEON_EGRESS_BY_LOADER over the same hour: it names the page and loader responsible.',
  type: 'Threshold',
  operator: 'Above',
  threshold: NEON_EGRESS_LIMIT_BYTES,
  intervalMinutes: 15,
  rangeMinutes: 60,
  alertOnNoData: false,
  aplQuery: `['${NEON_EGRESS_DATASET}'] | where ${NEON_SPAN_FILTER} | summarize v = sum(tolong(${NEON_BYTES_FIELD}))`,
} as const;

/**
 * Which page and loader: Neon bytes by loader, then by the page's request.
 * Run it for the hour the alert names. A client span's parent is the page's
 * `GET <route>` server span, so the join gives the route; `loader` is the
 * `withLoaderLabel` name, or `file:line fn` of the first app frame.
 */
export const NEON_EGRESS_BY_LOADER = `['${NEON_EGRESS_DATASET}'] | where ${NEON_SPAN_FILTER} | extend loader = tostring(${NEON_LOADER_FIELD}), bytes = tolong(${NEON_BYTES_FIELD}) | join kind=inner (['${NEON_EGRESS_DATASET}'] | where kind == "server" and name startswith "GET " | project trace_id, route = name) on trace_id | summarize total_bytes = sum(bytes), queries = count(), max_query_bytes = max(bytes) by route, loader | order by total_bytes desc | take 20`;

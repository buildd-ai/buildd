# @buildd/dispatch

The Dispatch transport: a Cloudflare Worker (`buildd-dispatch`) that holds a
producer's delivery intents after handoff and delivers them. It owns the
durable queue, timers, retry and backoff, collapse on `dedupeKey`, the
adapter contract, and delivery status.

It is transport only. buildd stays the authority for state, routing policy,
eligibility and claims: a route is chosen by buildd at publish time, every
privileged decision comes back through the signed `resolve` callback, and the
claim route remains the only thing that assigns work. Dispatch never reads
`labels` or `subject`, and never stores a tenant or platform secret.

Design: `knowledge-base: buildd/design/cloudflare-dispatch-transport.md`.
Wire contract: [`packages/dispatch-contract`](../../packages/dispatch-contract).

## Layout

| File | What it is |
|---|---|
| `src/index.ts` | Worker entry: `fetch` handler, re-exports `ScopeQueue` |
| `src/http.ts` | Routes, signature check, publish fan-out by scope. Runtime-free |
| `src/scope-queue.ts` | `ScopeQueue` SQLite DO: wires storage, alarm and secrets into the engine |
| `src/engine.ts` | The queue: publish/merge, alarm loop, retries, receipts, prune. Runtime-free |
| `src/producer.ts` | Signed callbacks to buildd: resolve, relay, receipts |
| `src/adapters/` | `http`, `github-repository-dispatch`, `runner-wake` |
| `src/config.ts` | Fail-closed config checks, `DRY_RUN_TYPES` |

The runtime-free files are what the Bun tests cover (`bun run test`). The
engine runs over `bun:sqlite` behind the same `exec(...).toArray()` interface
as `ctx.storage.sql`. `src/imports.test.ts` fails if `src/` imports anything
but the contract, `cloudflare:*` or its own files.

## Endpoints

Every `/v1` route is signed with the `PUBLISH_SECRET` ring (contract
`signRequest`: `Dispatch-Key-Id`, `Dispatch-Timestamp`, `Dispatch-Signature`,
±300 s skew). A bad or missing signature is `401`; missing config is `503`.

A **scope key** is `${source.system}:${source.scope}`, e.g.
`buildd:workspace:<id>`. It names the ScopeQueue DO, and every route outside
the envelope takes it, because each scope's state lives only in its own DO.

- `GET /health`: unsigned. `{ ok, configured }`.
- `POST /v1/envelopes` `{ envelopes }` (≤ 100): `202` with `results` in input
  order, each `accepted`, `duplicate` (id already known), `merged { into }`
  (collapsed into a queued intent with the same `dedupeKey`), or
  `rejected { why }`. `why: queue_unavailable` is retryable; anything else is
  a malformed envelope or an unknown `source.system`. An ack is sent only
  after the DO's storage write returns.
- `GET /v1/intents?scope=<key>&ids=a,b` (≤ 100): `{ known: [{id, state,
  attempt, mergedInto?}], unknown: [ids] }`. For the producer's repair floor.
- `GET /v1/intents/:id?scope=<key>`: state, next due, attempts, and the last
  outcome and error per target. No payload.
- `GET /v1/scopes/:key`: counts by state, paused, pending receipts, next due.
- `POST /v1/scopes/:key/pause` and `/resume`: a paused scope accepts publishes
  and flushes receipts, but delivers nothing.
- `PUT /v1/scopes/:key/targets/:id` `{ type, options }`: register a target.
  `options` are non-secret (`timeoutMs`); credential-looking keys are refused.

## Delivery

One alarm per scope, set to the earliest due intent (or receipt flush).

- `first` steps run in order until one delivers or skips. A decline moves to
  the next step. If every `first` step declines, the intent closes as
  `skipped`, receipt `delivered via skipped:all_declined`: a policy answer
  will not change on retry, and this matches today's terminal broadcast.
- `also` steps run on the first attempt only; their outcome never changes
  the intent's state.
- A throw is retryable: `next_due = now + retryDelayMs(attempt)` (contract),
  an `attempted` receipt, and the retry resumes at the step that threw. After
  `MAX_DELIVERY_ATTEMPTS`, a `failed` receipt.
- `resolve` (`resolve: true`, and always for `http` and
  `github-repository-dispatch`): `deliver` (payload + grant), `decline`,
  `skip` (closes, `skipped:<why>`), or `reschedule` (re-arm, no attempt
  counted, at least 15 s out). A grant is held in memory for that one step,
  never written to SQLite, receipts or logs.
- `notBefore` is never delivered early; `expiresAt` closes an undelivered
  intent as `expired`.
- At most 4 outbound deliveries in flight and 50 intents per alarm run.
- Receipts are written with the state change and flushed signed to
  `{BUILDD_SERVER}/api/dispatch/v1/receipts` when 25 are queued or the oldest
  is 10 s old; kept and retried after 30 s on a non-2xx.
- Terminal intents are pruned after 14 days. A re-publish of a pruned id is
  accepted again.
- One log line per step attempt: `{event: 'dispatch_attempt', id, scope,
  target, outcome, latencyMs, latenessMs}`.

Target type: a registered target wins, else the id's last `:` segment
(`webhook` → `http`, `github-actions` → `github-repository-dispatch`,
`runner-wake`). Anything else declines `unknown_target`.

`DRY_RUN_TYPES` (default `http,github-repository-dispatch`, the P1 shadow):
those types call resolve and record `dry-run:<type>:<decision>` without
POSTing. An absent var keeps the default; `""` turns dry-run off.

## Config

| Name | Kind | |
|---|---|---|
| `BUILDD_SERVER` | var | Callback base URL. No default; unset fails closed |
| `PUBLISH_SECRET` | secret | Key ring verifying producer → Dispatch |
| `CALLBACK_SECRET` | secret | Key ring signing Dispatch → producer |
| `DRY_RUN_TYPES` | var | See above |

Key rings use the contract's `parseKeyRing`: `keyId:secret[,keyId:secret]`.
Put the new key first to rotate (outbound signing uses the first entry), keep
the old one until the producer has switched.

## Local development

```bash
cd apps/dispatch
bunx wrangler dev --local \
  --var BUILDD_SERVER:http://127.0.0.1:3000 \
  --var PUBLISH_SECRET:k1:dev-publish --var CALLBACK_SECRET:k1:dev-callback
curl localhost:8787/health
```

## Owner setup

1. Bind a wrangler profile to this directory (no `account_id` in
   `wrangler.jsonc`): `bunx wrangler auth activate personal apps/dispatch`.
2. Secrets, one value per ring (`openssl rand -hex 32`):
   `bunx wrangler secret put PUBLISH_SECRET` and
   `bunx wrangler secret put CALLBACK_SECRET`. buildd gets the same values
   (Doppler `prd` first, then Vercel).
3. Set `BUILDD_SERVER` per deployment (dashboard, `--var` or an env block).
4. Add a custom domain or route. `workers.dev` is blocked on the owner's
   network.
5. Deploy: `bun run deploy`. The CI deploy token lives in Doppler `dev_ci` →
   GitHub Actions only, never Vercel.

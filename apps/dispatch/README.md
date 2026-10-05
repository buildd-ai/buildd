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
| `BUILDD_SERVER` | var | Callback base URL. Set in `wrangler.jsonc` (production Buildd); unset or invalid fails closed |
| `PUBLISH_SECRET` | secret | Key ring verifying producer → Dispatch |
| `CALLBACK_SECRET` | secret | Key ring signing Dispatch → producer |
| `DRY_RUN_TYPES` | var | See above |

Vars live in `wrangler.jsonc`, never the dashboard: `wrangler deploy` replaces
dashboard-set vars with the file's `vars`. Local `wrangler dev` overrides them
via `.dev.vars` or `--var`.

Key rings use the contract's `parseKeyRing`: `keyId:secret[,keyId:secret]`.
Always store the explicit form, `k1:<hex>`, on both sides. Signing uses the
first entry; verifying accepts any.

### Rotation

Each ring has one signer and one verifier:

- `PUBLISH`: Buildd signs (`DISPATCH_PUBLISH_SECRET`), the Worker verifies
  (`PUBLISH_SECRET`).
- `CALLBACK`: the Worker signs (`CALLBACK_SECRET`), Buildd verifies
  (`DISPATCH_CALLBACK_SECRET`).

Rotate in three steps, finishing each before the next:

1. Verifier adds the new key: `k2:<new>,k1:<old>`.
2. Signer switches to `k2:<new>`.
3. Verifier drops the old key: `k2:<new>`.

On the Buildd side, change Doppler `prd` first, push to Vercel, then redeploy.
A Vercel env change does not reach a running deployment.

### Where the values live

- Doppler `buildd/prd` is the only escrow for the Worker's secrets. `wrangler
  secret` values are write-only, so a value not in Doppler is lost.
- Never create `DISPATCH_*` directly in Vercel. A Sensitive var there silently
  halts the whole Doppler → Vercel sync.
- Preview (`stg`) has no `DISPATCH_*` on purpose: the transport is off on
  previews.
- The deploy token is `CF_DISPATCH_API_TOKEN` / `CF_DISPATCH_ACCOUNT_ID` in
  Doppler `buildd/dev_ci`, pushed to GitHub Actions repo secrets with
  `gh-secret-push`. Never Vercel, and never Actions variables: Actions logs
  in this repo are world-readable. See [Deploy](#deploy).

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
2. Secrets, one `k1:<hex>` value per ring (`openssl rand -hex 32`). Store them
   in Doppler `prd` as `DISPATCH_PUBLISH_SECRET` / `DISPATCH_CALLBACK_SECRET`
   first, then `bunx wrangler secret put PUBLISH_SECRET` and
   `bunx wrangler secret put CALLBACK_SECRET` with the same values. Push
   Doppler to Vercel and redeploy.
3. Add a custom domain or route, and set `DISPATCH_URL` to it in Doppler
   `prd`. `workers.dev` is blocked on the owner's network.
4. Push the deploy token to GitHub (see [Deploy](#deploy)), then let CI
   deploy.

## Deploy

CI deploys it: `.github/workflows/deploy-dispatch.yml`.

- **On release.** A push to `main` that touches `apps/dispatch/**` or
  `packages/dispatch-contract/**` deploys, so the Worker ships with the
  release that contains its change, like the web app. Merges to `dev` deploy
  nothing.
- **Manually.** `gh workflow run deploy-dispatch.yml --ref main`, optionally
  `-f ref=<tag-or-sha>` to deploy (or roll back to) a specific commit.

The job runs the Worker tests and `tsc`, runs `wrangler deploy` with
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from the repo secrets
`CF_DISPATCH_API_TOKEN` / `CF_DISPATCH_ACCOUNT_ID`, then fails unless
`/health` answers `"configured":true`. It fails first, by name, if either
secret is missing. It never sets `PUBLISH_SECRET` or `CALLBACK_SECRET`; a
deploy keeps the Worker's existing secrets.

The secrets come from Doppler `buildd/dev_ci`, pushed with
`~/infrastructure/scripts/gh-secret-push.mjs` (dry run by default; `--apply`
writes every name on its `buildd` allowlist).

A local deploy still works: `bunx wrangler deploy` here uses the `personal`
profile bound in Owner setup. The binding lives in your wrangler user config,
not the repo, and a `CLOUDFLARE_API_TOKEN` in the shell takes precedence over
it, so unset that first if you mean the profile.

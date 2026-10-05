# model-policy

A small Cloudflare Worker that answers one question: for this **surface**
(`chat | coding`) and **tier** (`premium-plus | premium | standard | budget`),
which provider, model and effort? The policy logic is
`@builddai/ai-kit/policy`, the same code an app can run locally with no service.

```
POST /v1/resolve    { surface, tier, app?, workspaceId? }  → { provider, model, effort, policyVersion, planId, surface, tier, source, experiment? }
POST /v1/outcomes   { planId, surface, observations: [...typed] } → 202
GET  /health        → { ok, policyVersion }
```

Resolve-only: the service never sees prompts or replies, never holds a provider
key, and never needs a buildd login. The app calls the provider itself with its
own credentials.

## Configuration

- `POLICY_TOKENS` (secret): `id:token[,id:token]`, each token ≥ 24 characters.
  Authorises `/v1/*` only. Empty or malformed: every `/v1` route answers 503.
- `MODEL_POLICY`: the policy document, JSON (`ModelPolicy`). Missing or invalid:
  `/v1/resolve` answers 503 and clients serve their own fallback.

Nothing else. Adding a provider key or a buildd credential here is a design
change (`src/handler.test.ts` pins the env).

## Run locally

```bash
cd apps/model-policy
bunx wrangler dev --var POLICY_TOKENS:dev:$(openssl rand -hex 16) --var MODEL_POLICY:'{"version":"1","tiers":{}}'
```

## Deploy

`.github/workflows/deploy-model-policy.yml` deploys on a push to `main` that
touches this Worker or the policy protocol, and on `workflow_dispatch`. It
serves `https://policy.buildd.dev` (Custom Domain in `wrangler.jsonc`) and
fails if `/health` is not `ok: true` afterwards.

Everything below is a credential, so it is the manual part, done once:

1. **Deploy token.** Repo secrets `CF_MODEL_POLICY_API_TOKEN` and
   `CF_MODEL_POLICY_ACCOUNT_ID` (Doppler `buildd/dev_ci`, pushed with
   gh-secret-push). Unset, the workflow uses Dispatch's `CF_DISPATCH_*`; that
   token needs Workers Scripts: Edit and Workers Routes: Edit on the
   `buildd.dev` zone.
2. **Worker secrets.** Policy tokens, one per consumer (`id:token`, each ≥24
   characters), and the policy document:
   ```bash
   cd apps/model-policy
   bunx wrangler auth activate <profile> apps/model-policy   # once per machine
   printf 'buildd:%s' "$(openssl rand -hex 24)" | bunx wrangler secret put POLICY_TOKENS
   bunx wrangler secret put MODEL_POLICY < policy.json       # a ModelPolicy document
   ```
   Then run the workflow (`gh workflow run deploy-model-policy.yml --ref main`).
3. **buildd as a consumer.** On the web app's Vercel project (production),
   `BUILDD_MODEL_POLICY_URL=https://policy.buildd.dev` and
   `BUILDD_MODEL_POLICY_TOKEN=<the buildd token from step 2>`. Unset, buildd
   runs on its registry and the bundled policy, exactly as before.

What `MODEL_POLICY` should say for buildd: only what a team has not pinned.
buildd resolves a team's registry rows first (they are the policy document's
overrides, surfaces and tiers), and asks this service only for a tier the
team leaves unset. Its answer replaces buildd's catalog/bundled default for
that tier, and carries the planId buildd reports coding outcomes against
(CI, review verdict, merge, duration, cost). Start with
`{"version":"1","tiers":{}}` (every tier unset: the service answers
`bundled` and buildd keeps its own default), then add tiers or experiments.

A service outage never takes buildd down: a failed resolve backs off for 30s
and serves the last good answer (no planId), then buildd's own default.

## Client side

```ts
import { createPolicyClient, remotePolicy, DEFAULT_MODEL_POLICY } from '@builddai/ai-kit/policy';
const policy = createPolicyClient({ policy: remotePolicy({ endpoint, token }), fallback: DEFAULT_MODEL_POLICY });
```

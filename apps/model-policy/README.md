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

## Run and deploy

```bash
cd apps/model-policy
bunx wrangler dev --var POLICY_TOKENS:dev:$(openssl rand -hex 16) --var MODEL_POLICY:'{"version":"1","tiers":{}}'
bunx wrangler auth activate <profile> apps/model-policy   # once per machine
bunx wrangler secret put POLICY_TOKENS
bunx wrangler secret put MODEL_POLICY
bunx wrangler deploy
```

Not deployed yet and no public route; add a Custom Domain in `wrangler.jsonc`
when there is a first consumer.

Client side:

```ts
import { createPolicyClient, remotePolicy, DEFAULT_MODEL_POLICY } from '@builddai/ai-kit/policy';
const policy = createPolicyClient({ policy: remotePolicy({ endpoint, token }), fallback: DEFAULT_MODEL_POLICY });
```

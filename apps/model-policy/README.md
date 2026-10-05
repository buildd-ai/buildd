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
```

Deploy with the Cloudflare credential stored in buildd, which never comes to
your machine (docs/specs/deployment-actions.md). The script builds the bundle
with `wrangler deploy --dry-run` (no credential) and buildd uploads it:

```bash
# A person with an admin buildd key:
BUILDD_API_KEY=bld_… POLICY_TOKENS=… MODEL_POLICY=… \
  bun apps/model-policy/scripts/deploy.ts --workspace <id> --credential-ref cloudflare \
  --secret POLICY_TOKENS --secret MODEL_POLICY

# A Platform Operator task: write the request, then pass it to the `deploy`
# MCP action. buildd checks the workspace's Operator grant for
# cloudflare / model-policy / <environment> / <credential ref>.
bun apps/model-policy/scripts/deploy.ts --emit /tmp/model-policy-deploy.json [--environment staging]
```

`--environment` other than `production` deploys the Worker
`model-policy-<environment>`. Secrets set separately survive a code upload.

Without a credential in buildd, wrangler still works directly:

```bash
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

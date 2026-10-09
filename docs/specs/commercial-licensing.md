---
title: Commercial Licensing Foundation
status: draft
owner: builder
last_verified: 2026-10-09
summary: The public core MUST verify a signed license offline and answer scoped capability checks for future commercial modules, denying only the premium capability and never core features or data.
domain: billing
surfaces: [packages/core/license/verify.ts, packages/core/license/capability.ts]
related: [managed-runner-entitlements, team-permissions]
keywords: [BUILDD_LICENSE, BUILDD_LICENSE_FILE, Ed25519, license key, self-host, enterprise edition, grace period, kid, commercial capability]
verified_by: [packages/core/__tests__/license.test.ts]
---

# Commercial Licensing Foundation

Strategy: `knowledge-base: buildd/plans/self-hosted-licensing-2027.md` (proposal; owner decision 2026-10-09).
This spec covers only the small verification foundation in public core.

## Current licenses vs. a prospective Enterprise module

| | State |
|---|---|
| `apps/web`, `packages/core` and everything not listed below: FSL-1.1-ALv2, each release converting to Apache-2.0 two years after it ships | **Current, unchanged** |
| `apps/runner`, `packages/shared`, `packages/ai-kit`, `packages/dispatch-contract`: Apache-2.0 | **Current, unchanged** |
| A separately distributed, privately licensed Enterprise module package | **Proposed, does not exist.** No code, notice or EULA for it is in this repository |
| Commercial EULA text, ownership, contributor terms, distribution | **Requires legal counsel** before anything is published or sold |

Nothing here relicenses, restricts or retroactively revokes anything already
published. Existing public capabilities stay free in the public tree.

## What the verifier is not

**The license check is not protection for source-available code.** It lives in
the FSL tree, which licensees may modify for internal use; they can edit it out.
It is an entitlement signal and the enforcement point for a future, separately
licensed module's loader. Real protection comes from code outside the FSL tree
under its own terms, contract and support. Do not describe this code as a
proprietary moat.

## Contract

**Capability statement**: A deployment's license status MUST be derived locally
from a signed token with no network call, and a capability check MUST deny only
the requested premium capability when the license is absent, invalid or lapsed.

**Invariants**:

- Token: `base64url(header).base64url(payload).base64url(signature)`, Ed25519 over `"<header>.<payload>"`. Header `alg` must be exactly `EdDSA`, `typ` `buildd-license`, `kid` selects the verifier key. Anything else is `invalid`.
- Payload v1: `jti`, `customer{id,name?}`, `edition` (`team`|`enterprise`), `features[]`, `limits.maxSeats`, `iat`, `nbf?`, `exp`, `graceDays?`, `kind`, optional `deployment.id`, optional `crit[]`. Unknown edition, wrong issuer/version, bad field types, or a `crit` entry this build does not know reject the token. Unknown non-critical fields are ignored.
- Code gates on `features` claims, never on `edition`.
- Verifier keys: `BUILT_IN_PUBLIC_KEYS` is **empty** in this repo; operators add keys (and rotate) with `BUILDD_LICENSE_PUBKEYS` (JSON `kid -> base64url raw public key`). The private signing key, any issuer, and any keygen endpoint are NOT in this repository.
- Time: ±10 minute skew (hard cap 1 hour). Grace after `exp` is an explicit, overridable **policy proposal** (default 30 days, `BUILDD_LICENSE_GRACE_DAYS`, `0` disables, token `graceDays` capped by policy max). It is not a contractual promise.
- Deployment binding is optional: a token with `deployment.id` is valid only when `BUILDD_DEPLOYMENT_ID` matches.
- Status vocabulary: `absent | active | grace | expired | not_yet_valid | invalid(reason)`. Reasons are a fixed set and never contain token bytes; the redacted summary excludes the token, signature and key material.
- Verification is for the control-plane backend only; runners and clients never receive or check the token.

## One resolver shape, three separate questions

`checkCommercialCapability(claim, scope)` returns `{allowed, claim, source: stripe|license|default}` or a typed denial (`license_required`, `license_expired`, `license_invalid`, `license_not_yet_valid`, `capability_not_licensed`, `not_in_plan`) with a message.

- **Entitlement** (this module): hosted source is the Stripe-derived `teams.plan` (only when `BILLING_ENFORCED`; off = allowed, as today); self-host source is the signed license.
- **Authorization**: who may act. Untouched.
- **Physical runner capacity / managed-runner metering**: `resolveManagedRunnerEntitlement` and account/workspace concurrency caps. Untouched; a license never sets managed-runner caps.

Today nothing calls the resolver. `entitlements()` and the managed-runner plans are unchanged; no member, SSO, task, mission or GitHub behaviour is gated. A future module's API/MCP/worker entry calls the resolver and returns the denial; a UI-only check is not a gate. Reserved claim ids (`collab`, `sso`, `scim`, `audit_export`) are names, not implemented features.

## Decisions for a human

1. Counsel review of the Enterprise EULA/terms and the FSL interaction before any private package is distributed.
2. Whether the 30-day grace is offered, and its length (D7 in the strategy plan).
3. Private packaging: recommended next task is a **new private repository** for the module (its own commercial notice), loaded via the module composition root. Do not place proprietary-notice code in this FSL tree.
4. Paid-seat definition (D6), which claims belong to Team vs Enterprise (D3), and recording the boundary commit/date.
5. Adding the production verifier public key to `BUILT_IN_PUBLIC_KEYS` once the issuer exists.

## Follow-ups (not in this change)

Admin read-only status endpoint (use `redactedLicenseSummary`), license reload, seat accounting, UI banners, high-water-mark clock-rewind guard.

## Code surface

`packages/core/license/verify.ts`, `capability.ts`, `index.ts`; export `@buildd/core/license`; tests `packages/core/__tests__/license.test.ts` (test-only signer in `__tests__/fixtures/`).

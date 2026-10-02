---
title: Private Tuning Loader
status: active
owner: max
last_verified: 2026-10-02
summary: Tuning values MUST load at runtime from an optional private git source, validated and clamped, and MUST fall back to a fully functional public default on any failure without throwing.
domain: integrations
surfaces: [packages/core/tuning/index.ts, packages/core/tuning/loader.ts, packages/core/tuning/github-source.ts, apps/web/src/lib/tuning.ts]
related: [credential-isolation]
keywords: [BUILDD_TUNING_SOURCE, tuning bundle, role prompts, policy thresholds, public default]
verified_by: [packages/core/__tests__/tuning.test.ts, packages/core/__tests__/tuning-github-source.test.ts, packages/core/__tests__/tuning-server-only.test.ts, apps/web/src/lib/tuning.test.ts]
assertions:
  - id: get-tuning
    type: symbol
    name: getTuning
    path: packages/core/tuning/index.ts
  - id: load-tuning-bundle
    type: symbol
    name: loadTuningBundle
    path: packages/core/tuning/index.ts
  - id: tuning-diagnostics
    type: symbol
    name: getTuningDiagnostics
    path: packages/core/tuning/index.ts
  - id: tuning-loader
    type: symbol
    name: createTuningLoader
    path: packages/core/tuning/loader.ts
  - id: github-fetcher
    type: symbol
    name: createGitHubTuningFetcher
    path: packages/core/tuning/github-source.ts
  - id: clamped-int
    type: symbol
    name: clampedInt
    path: packages/core/tuning/validators.ts
  - id: web-token-provider
    type: symbol
    name: tuningInstallationToken
    path: apps/web/src/lib/tuning.ts
---
# Private Tuning Loader

Hard-won tuning (role prompt bodies, merge and retry thresholds) is separable
from the code. The public repository ships a deliberately weaker, fully
functional default for every tuned value; an operator can point a deployment at
a private git path that overrides them. A self-hosted or forked copy works out
of the box and simply does not inherit the owner's tuning.

This spec covers the loader and its contract only. Which keys exist, and what
the public defaults are, belong to the call sites that adopt it.

## Capability statement

`getTuning(key, publicDefault, validate)` MUST resolve to the private value for
`key` when a private source is configured, reachable, carries the key, and the
value passes `validate`; in every other case it MUST resolve to `publicDefault`
and MUST NOT throw.

## Source and bundle format

- `BUILDD_TUNING_SOURCE` is `owner/repo@ref:path`, for example
  `example-org/example-private@main:tuning`. Unset or malformed means private
  tuning is off and no network call is made.
- The path is a flat directory. A file named `<namespace>.<name>.md` or
  `<namespace>.<name>.json` is the entry `<namespace>:<name>`, for example
  `role.builder.md` is `role:builder` and `policy.ci-retry.json` is
  `policy:ci-retry`. Markdown entries are strings; JSON entries are parsed.
- Files are read through the buildd GitHub App installation that covers the
  repo (`installationIdForRepo` then `getInstallationToken`), pinned to one
  commit sha so a bundle is never a mix of refs.

## Invariants

- Tuning is configuration, not a credential: there is no table and no `secrets`
  purpose for it. Only a short-lived installation token is minted per fetch.
- Loaded values are never returned by a public API route and never reach a
  client bundle. Nothing under `packages/core/tuning` is imported from a
  `'use client'` file.
- Every call supplies a validator. `clampedInt` and `clampedNumber` bring an
  out-of-range value into range; wrong types and non-finite numbers are invalid
  and fall back to the default.
- Logs and diagnostics carry the key name, a reason class, and the bundle
  version only: never a value, a validation message, the source repo, or a token.
- At most one warning per key per process.
- The bundle is cached for `TUNING_TTL_MS` (5 minutes). A failed refresh keeps
  serving the previous bundle (stale-on-error) and is retried no sooner than
  `TUNING_RETRY_AFTER_FAILURE_MS`. Concurrent callers share one in-flight fetch.

## Acceptance criteria

- AC-1: GIVEN `BUILDD_TUNING_SOURCE` is unset WHEN `getTuning` is called THEN it returns `publicDefault` and performs no fetch.
- AC-2: GIVEN the source fetch fails WHEN `getTuning` is called THEN it returns `publicDefault`, does not throw, and logs one warning for that key.
- AC-3: GIVEN the private value fails `validate` or is malformed JSON WHEN `getTuning` is called THEN it returns `publicDefault`.
- AC-4: GIVEN a private integer of 10000 and a `clampedInt(0, 5)` validator WHEN `getTuning` is called THEN it returns 5.
- AC-5: GIVEN a loaded bundle older than the TTL and a failing source WHEN `getTuning` is called THEN it returns the previously loaded value.
- AC-6: GIVEN a loaded bundle WHEN `getTuningDiagnostics` is called THEN the result contains the version and key count and no values.
- AC-7: GIVEN any file with a `'use client'` directive WHEN the repo is scanned THEN none imports `packages/core/tuning`.

## Code surface

- `packages/core/tuning/loader.ts` (`createTuningLoader`, cache, TTL, warn-once)
- `packages/core/tuning/github-source.ts` (`createGitHubTuningFetcher`)
- `packages/core/tuning/source.ts` (`parseTuningSource`, file-name to key mapping)
- `packages/core/tuning/validators.ts` (`clampedInt`, `clampedNumber`, `markdownPrompt`)
- `packages/core/tuning/index.ts` (`getTuning`, `loadTuningBundle`, `setTuningTokenProvider`)
- `apps/web/src/lib/tuning.ts` (token provider; web callers import from here)

## Out of scope

- Which keys exist and their public defaults; wiring role prompts and policy
  thresholds to the loader.
- Writing or editing the private source, and a dashboard for it.
- Runners: a process with no token provider registered always gets defaults.

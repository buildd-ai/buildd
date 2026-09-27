# @buildd/ai-kit changelog

Independent semver, not buildd's release version. Consumers pin exact versions.
Breaking changes to `/chat/contract` or to the tool-group declaration are major
bumps; new optional data parts are minor.

## Unreleased

- `/models`: the model-plan client. `createModelsClient` (`plan`, `recordUsage`,
  `flush`, `stats`) against buildd's `POST /api/ai/plan` and `/api/ai/usage`:
  60s plan cache with a pluggable `PlanStore`, 800ms deadline, 24h stale
  window then fixed `defaults`, `PlanDeniedError` on deny, allowlisted and
  batched receipts with one retry. `toCallConfig` for OpenRouter / Anthropic /
  OpenAI. Replaces the P0 `/models` placeholder types (`createModelClient`,
  `ModelPlan`, `UsageReport`, `report`): none were implemented or imported.
- `/decide` (P2 of `docs/design/shared-ai-kit.md`): question builders
  (`choice`, `score`, `noul`); `decide`, the transport over
  `@typesafe-ai/sdk` to OpenRouter (never throws, one deadline, retries on
  408/429/5xx, pinned `JEV_MODEL`); `runDecisionPool` for fan-out;
  `defineDecision` with `shadow | gated | live` modes, per-question thresholds,
  `version` and `fingerprint`; `expectDecisionPinned`; `runDecisionEval` /
  `summarizeDecisionEval`; metadata-only `DecisionReceipt`s and
  `toModelsUsage` for `/models`' `recordUsage`. buildd's
  `decisionCall` now uses this transport and these types.
- `/models` receipts take an optional `kind` (`chat` | `inference` |
  `decision`, `USAGE_KINDS`), and a `decision` receipt may omit `plan.tier`.
  `/decide`'s `toModelsUsage` now sends `kind: 'decision'` with no tier
  (was `tier: 'budget'`), so buildd reports decision spend apart from chat.
- Relative imports in the source are extensionless and the build rewrites
  them to `.js`, so the kit is consumable from source by Next/Turbopack with
  no consumer config, and `dist/` stays valid Node ESM. No change to the
  published entry points.
- Breaking for `/decide` type users: the P0 placeholder `DecisionDefinition`
  is replaced by `DecisionConfig` / `Decision`.

## 0.0.1

First release (P0 of `docs/design/shared-ai-kit.md`).

- `/chat/contract`: message and tool-part types, object refs, the `data-step`,
  `data-handoff` and `data-event` parts, approval previews, tool-permission rows.
  buildd's own chat reads these from here.
- `/chat/server`: `defineToolGroups` and the pure Allow enforcement
  (`skipCardVerdict` / `canSkipCard`, `contentInContext`, `toolOutputInHistory`).
  buildd's chat enforces Allow through this function.
- `/chat/theme.css`: the `--kit-*` custom properties.
- `/models`, `/decide`, `/chat/react`, `/surfaces`: types only. Implementations
  land in later phases.

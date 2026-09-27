# @buildd/ai-kit changelog

Independent semver, not buildd's release version. Consumers pin exact versions.
Breaking changes to `/chat/contract` or to the tool-group declaration are major
bumps; new optional data parts are minor.

## 0.1.0 — 2026-09-27

First published release. (`0.0.1` was the in-repo P0 version and was never
published to npm; its placeholder `/models` and `/decide` types are gone.)

- `/chat/contract` (P0 of `docs/design/shared-ai-kit.md`): message and
  tool-part types, object refs, the `data-step`, `data-handoff` and
  `data-event` parts, approval previews, tool-permission rows. buildd's own
  chat reads these from here.
- `/chat/server`: `defineToolGroups` and the pure Allow enforcement
  (`skipCardVerdict` / `canSkipCard`, `contentInContext`,
  `toolOutputInHistory`). buildd's chat enforces Allow through this function.
- `/chat/theme.css`: the `--kit-*` custom properties.
- `/models`: the model-plan client. `createModelsClient` (`plan`,
  `recordUsage`, `flush`, `stats`) against buildd's `POST /api/ai/plan` and
  `/api/ai/usage`: 60s plan cache with a pluggable `PlanStore`, 800ms
  deadline, 24h stale window then fixed `defaults`, `PlanDeniedError` on deny,
  allowlisted and batched receipts with one retry. `toCallConfig` for
  OpenRouter / Anthropic / OpenAI.
- `/models` receipts take an optional `kind` (`chat` | `inference` |
  `decision`, `USAGE_KINDS`), and a `decision` receipt may omit `plan.tier`,
  so buildd reports decision spend apart from chat.
- `/decide` (P2): question builders (`choice`, `score`, `noul`); `decide`,
  the transport over `@typesafe-ai/sdk` to OpenRouter (never throws, one
  deadline, retries on 408/429/5xx, pinned `JEV_MODEL`); `runDecisionPool`
  for fan-out; `defineDecision` (`DecisionConfig` / `Decision`) with
  `shadow | gated | live` modes, per-question thresholds, `version` and
  `fingerprint`; `expectDecisionPinned`; `runDecisionEval` /
  `summarizeDecisionEval`; metadata-only `DecisionReceipt`s and
  `toModelsUsage` (sends `kind: 'decision'`, no tier) for `/models`'
  `recordUsage`. buildd's `decisionCall` uses this transport and these types.
- Relative imports in the source are extensionless and the build rewrites
  them to `.js`, so the kit is consumable from source by Next/Turbopack with
  no consumer config, and `dist/` is valid Node ESM.
- `/chat/react`, `/surfaces`: types only. Implementations land in later
  phases.

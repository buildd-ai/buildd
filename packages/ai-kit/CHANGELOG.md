# @buildd/ai-kit changelog

Independent semver, not buildd's release version. Consumers pin exact versions.
Breaking changes to `/chat/contract` or to the tool-group declaration are major
bumps; new optional data parts are minor.

## Unreleased

- `/decide` (P2 of `docs/design/shared-ai-kit.md`): question builders
  (`choice`, `score`, `noul`); `decide`, the transport over
  `@typesafe-ai/sdk` to OpenRouter (never throws, one deadline, retries on
  408/429/5xx, pinned `JEV_MODEL`); `runDecisionPool` for fan-out;
  `defineDecision` with `shadow | gated | live` modes, per-question thresholds,
  `version` and `fingerprint`; `expectDecisionPinned`; `runDecisionEval` /
  `summarizeDecisionEval`; metadata-only `DecisionReceipt`s. buildd's
  `decisionCall` now uses this transport and these types.
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

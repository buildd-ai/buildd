---
title: Settings Copy
status: active
owner: max
last_verified: 2026-10-12
summary: Settings index descriptions MUST be one short fragment stating what the page manages, with no team-policy conditions, trailing filler or em dashes; the voice authority stays design-system section 5 and copy-rules.
domain: surfaces
surfaces: [packages/core/copy-rules.ts, apps/web/src/lib/settings-nav.ts, apps/web/src/lib/copy-review.ts, scripts/copy-check.ts]
related: [settings-models, team-permissions]
keywords: [Settings copy, voice, descriptions, copy rules, copy:check, copyReview, conditional policy, em dash]
verified_by: [scripts/copy-check.test.ts, apps/web/src/lib/settings-nav.test.ts]
supersedes: []
assertions:
  - id: "description-checker"
    type: "symbol"
    name: "settingsDescriptionProblems"
    path: "packages/core/copy-rules.ts"
  - id: "violations-checker"
    type: "symbol"
    name: "copyViolations"
    path: "packages/core/copy-rules.ts"
  - id: "nav-items"
    type: "symbol"
    name: "SETTINGS_ITEMS"
    path: "apps/web/src/lib/settings-nav.ts"
---

# Settings Copy

This spec holds no voice rules of its own. The voice contract is
`docs/design/design-system.md` section 5, enforced by the rules in
`packages/core/copy-rules.ts`, `bun run copy:check` and the
`gitConfig.copyReview` gate (`apps/web/src/lib/copy-review.ts`). It states what
must stay true of Settings copy.

## Requirements

- Every Settings index description MUST pass `settingsDescriptionProblems`:
  one sentence fragment, at most 14 words, ending in a full stop.
- A description MUST NOT condition a setting on team policy ("when the team
  lets…", "if admins allow…", "the team decides"). Rule `conditional-policy`.
- A description MUST NOT trail off ("and more", "etc."). Rule `trailing-filler`.
- Rendered copy MUST NOT contain an em dash. Rule `em-dash`.
- A key or token MUST NOT pay or spend. Rule `object-pays`.
- New hits MUST NOT raise `scripts/copy-check.baseline.json`.

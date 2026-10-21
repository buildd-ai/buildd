# Local Product Language experiment

Reuse/gap inventory, written before implementation:

| Capability | Existing | Missing / choice |
| --- | --- | --- |
| Terminology | `packages/shared/src/terms.ts`, totality tests, generated `docs/design/terms.md` | Read the catalog; never copy its state mapping. |
| Copy lint | `packages/core/copy-rules.ts`, `scripts/copy-check.ts` AST and ratchet | Add conservative changed-subject extraction; current flattening of expressions to N cannot prove state. |
| Delivery review | `apps/web/src/lib/copy-review.ts`, `reviewer.ts`, `gitConfig.copyReview` | Preserve the independent PR gate. No hook installation. |
| Decisions | `packages/ai-kit/src/decide`, core decision kinds/policy/client, ledger, measurements | No authorized local workspace route established. Semantic model execution unsupported; no alternate transport or implicit use of keys. |
| Evidence | `packages/core/verification-check.ts`, Quality Scout adapters | Adapt findings to existing check results; no persistence or lifecycle. |
| Missions | `mission-sections.ts` SECTION_META, MissionGrid SectionView, delivery/start projections | Fixtures only. PR #5359 owns production caption/Next removal; do not duplicate its changes. Scheduled context is absent from the list projection and must be supplied. |

Authority: approved Product voice revision 6 (hash
`6edfd5f059cc452f9470d5157b545a422868bfb987c17d678a757161d153b980`),
R-14/R-16/R-21/R-22/R-23, and `docs/design/design-system.md` section 5.
Living Specs checking-work revision 1 requires independent evidence; tests are
not a builder's final spec verdict. Decision Kinds keeps spend, routing,
measurement and recording in the existing platform. No spec amendments here.

Plan: first failing extractor/policy/command tests, then source-located TSX
adapter + versioned policy data + local CLI, then independent rendered fixtures
using actual section sorting, focused regressions and repository checks.

The PoC deliberately does not claim complete AST data flow, universal copy
quality, automatic state understanding or production enforcement.

## Run locally

From the repository root (Bun and locked workspace dependencies required):

```sh
bun run scripts/project-policy/cli.ts --input=scripts/project-policy/negative.json
# exit 1: deterministic state mismatch and custom action rule; caption advice
bun run scripts/project-policy/cli.ts --input=scripts/project-policy/positive.json
# exit 0: deterministic recheck passed; semantic evaluation remains unsupported
bun run scripts/project-policy/cli.ts --staged --stage=commit
bun run scripts/project-policy/cli.ts --input=scripts/project-policy/negative.json --stage=agent
# advisory authoring invocation: exit 0, same structured findings
bun run scripts/run-unit-tests.ts scripts/project-policy/project-policy.test.ts scripts/project-policy/cli.test.ts scripts/project-policy/rendered.test.tsx
bunx tsc --project scripts/project-policy/tsconfig.json --noEmit
bun run scripts/project-policy/fixtures.tsx /absolute/path/to/fixture.html
```

The CLI emits JSON with file/line/offsets, before/after, role/provenance,
policy version, reason, repair, evaluator, fingerprint, and the existing
`VerificationResult`. Exit 1 means a deterministic violation; 2 means malformed
input or execution failure. Exit 0 does **not** certify semantic quality. Nothing
installs hooks. `--stage` records an invocation mode; it does not prove a hook or
CI ran. Agent hook, pre-commit hook and CI integration remain **not integrated**.
The existing PR copyReview gate is unchanged.

Supplied JSON contains `changes: [{file, before, after, patch?, contexts?}]` and
optional `customRules`. `patch` is a per-file unified diff matching the full
new-side TSX snapshot. `--staged` reads HEAD/index blobs, never unstaged contents,
and handles renamed files as delete/add. Deletions introduce no new strings.
Context is keyed by new-side line and includes a provenance `source`; supply
`prop`, `component` or `start` to disambiguate multiple subjects on one line.
Context is a caller assertion, not automatic state discovery. Each supplied
state uses the catalog's `InternalRef`. No context means no state inference.

Policy data lives in `product-language.json`; it references the shared catalogs
instead of copying their rules. The supplied examples demonstrate a configurable
action-only workspace rule. The sort-caption heuristic is deliberately advisory,
restricted to a known section-subtitle purpose. It generalizes beyond the two
reported strings, but cannot establish semantic user value or interpret an
approved exception. `gold.json` includes redundant, useful and unclear controls;
these are development labels, not a held-out calibration or a measured threshold.

Model/provider/version, latency and cost are **not exercised**. No key lookup,
custom HTTP transport, provider fallback, database write, or decision-ledger row
is fabricated. A production semantic adapter should use a new opt-in capability
and `runBuilddDecision` in explicit shadow mode; the platform's implicit Jev
measurement behavior is insufficient calibration for a new copy question.
Only bounded strings, roles and relevant clauses may enter that adapter, never
whole diffs, source files, telemetry, secrets or unrelated context.

## Limits and smallest next slices

- TSX only; no Vue, Svelte, MDX, translations or cross-file constant/data flow.
  The actual SECTION_META-to-MissionGrid flow is demonstrated by a render fixture,
  not resolved statically. Supplied snapshots must represent the actual edit.
- Native JSX and common visible props are extracted. Custom component contracts,
  hidden elements, rich inline sentence joining, spread props, runtime templates
  and conditional visibility need further work. Unknown dynamics/roles abstain.
  Before values pair by component/prop occurrence; reordering can make that pairing
  approximate. Locations and new-side filtering remain source based.
- Deterministic checks use current shared rules; their existing false positives
  remain possible. This is an experiment, not approved production enforcement.
- Render tests assert actual React HTML, state/date and unchanged real sort order.
  They do not certify a full browser layout or implement the production scheduled
  projection missing from the current Missions list.
- Extend existing components: retain this small adapter under scripts, then
  share strict AST subjects with copy-review/copy-check, register the opt-in shadow
  semantic kind/ledger path, collect independent gold labels and measurements,
  and only then add explicit agent/pre-commit/CI adapters under measured policy.
  No new package, evidence store, or lifecycle is warranted yet.

Architectural references inspected: [Chock](https://github.com/open-coder-ai/chock)
(policy entry-point coverage), [Abide](https://github.com/coldteadotai/abide)
(semantic edit feedback), [Reflex](https://github.com/ursuciprian/reflex)
(rules first, model fallback/escalation). None is installed as a dependency.

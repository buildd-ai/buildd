# Binding buildd-docs to docs/specs

**Status:** Proposed
**Related:**
- `docs/specs/SPEC-FORMAT.md` — the spec contract this binds against
- `scripts/check-specs.ts` — the code→spec gate (symbol liveness, `verified_by`, surface coverage)
- `docs/SPEC.md` §11 — the current maintenance chain (code → SPEC.md → docs/site)
- `.claude/skills/spec-sync/SKILL.md` — the semantic drift loop this complements
- `docs/reports/doc-drift-punchlist.md` — where drift is recorded by hand today
- `buildd-ai/buildd-docs` — Fumadocs site at `docs.buildd.dev` (sibling repo)

---

## Problem

`docs.buildd.dev` can be wrong for months and nothing says so.

The chain in `docs/SPEC.md` §11 is *code → `docs/SPEC.md` → buildd-docs*, reconciled
"never the reverse". Every arrow in it is a human promise:

- **buildd-docs has no CI at all.** No `.github/workflows/` directory exists in that
  repo. Its 33 `.mdx` pages carry `title` and `description` and nothing else — no
  pointer to the behaviour they describe, no record of when that behaviour was last
  checked. A page documenting a removed flag is indistinguishable from a correct one.
- **The drift audit is on-demand and LLM-judged.** The `spec-sync` skill's pipeline
  (ingest → retrieve → judge) is good at *discovering* unknown drift, and its own
  docs warn that scores "SURFACE; they do NOT decide". But it runs when a person
  remembers to run it, and its corpus refresh depends on a knowledge-ingest workflow
  that no longer exists in `.github/workflows/` — so `knowledge-eval.yml:18`'s
  `workflow_run: workflows: ["Knowledge Ingest"]` trigger cannot fire.
- **`docs/reports/doc-drift-punchlist.md` is a snapshot**, and `docs/reports/README.md`
  says so: rebuildable, may be stale, never a source of truth.

Meanwhile the *other* two arrows just got mechanical. `scripts/check-specs.ts` now
checks that a spec's named symbols exist, that an `active` spec names the tests
asserting its invariants, and which modules no spec claims. Code→spec is enforced;
spec→docs is still a promise.

## Current state

| Link | Enforcement today |
|---|---|
| code → `docs/specs/*` | `specs:lint` in `build.yml` + `.githooks/pre-commit`: frontmatter, path existence, dup titles, referential integrity, symbol liveness, `verified_by` |
| code → `docs/SPEC.md` | none (convention: update §2/§4 in the same PR) |
| `docs/specs/*` → buildd-docs | none |
| discovery of unknown drift | `spec-sync` skill, manual, semantic |

`docs/specs/` frontmatter is already machine-readable — `title`, `status`, `domain`,
`summary`, `surfaces`, `related`, `keywords`, `last_verified` — and `INDEX.md` is
already generated from it. That existing structure is the joint this design uses.

## Proposal

Make the spec corpus a **published interface** and have the docs repo bind to it by
slug, so doc rot becomes a failing inequality instead of a judgment call.

Three parts.

### 1. Publish `docs/specs/specs.json`

`scripts/check-specs.ts` gains one more generated output next to `INDEX.md`: a stable
JSON manifest, one entry per spec.

```json
{
  "generated_from": "docs/specs",
  "specs": [
    {
      "slug": "scheduled-task-merge-policy",
      "title": "Scheduled-task merge policy override",
      "status": "active",
      "domain": "tasks",
      "summary": "A task schedule MUST be able to declare a MergePolicy that overrides...",
      "last_verified": "2026-08-27",
      "user_facing": true
    }
  ]
}
```

`user_facing` is a new optional frontmatter boolean, default `false` — a no-op on
merge. It answers "does a person outside the team need a page about this?" Internal
contracts (`worker-sandbox-isolation`, `migration-execution`) stay `false`; anything
a user configures (`scheduled-task-merge-policy`, `artifacts-and-sharing`) is `true`.

### 2. Docs pages declare their contract

Two new optional keys in each `.mdx` frontmatter:

```yaml
---
title: Task Schedules
description: Create recurring tasks that run on a schedule using cron expressions
spec: scheduled-task-merge-policy
spec_verified: 2026-08-27
---
```

`spec` names the slug the page renders. `spec_verified` is the spec's `last_verified`
value **copied at the moment a human last checked this page against that spec**.

That copied stamp is the whole mechanism: when behaviour changes, the spec's
`last_verified` moves, and `page.spec_verified < spec.last_verified` becomes true.
The page hasn't changed, but it is now provably unreviewed.

### 3. One CI job in buildd-docs

A new `docs-spec-check.yml` fetches `specs.json` from the buildd default branch
(public repo, no token needed) and asserts four things:

| Check | Failure means |
|---|---|
| every `spec:` names a slug in the manifest, not `superseded` | page points at a retired or misspelled contract |
| `page.spec_verified >= spec.last_verified` | the contract moved after this page was last reviewed |
| every `user_facing: true` spec has ≥1 page binding it | shipped, contracted, undocumented |
| pages with no `spec:` | advisory list only — tutorials and concept pages legitimately have none |

Only the first two fail a docs PR. The third fails the *buildd* side (see sketch
step 4) so the debt lands on whoever changed behaviour, not on whoever happened to
edit an unrelated page.

### Crux

**The stamp must be copied by a human review, never written by a bot.**

If any automation bumps `spec_verified` — a formatter, a "sync" job, a merge queue —
the check inverts from "someone confirmed this page" to "something touched this page",
and it silently reports green forever. That is the same failure as `last_verified`
being self-asserted, one level down. A bot may open the PR, quote the spec diff, and
even draft the prose; a person must be the one to move the date.

If that holds, doc rot is bounded by the review latency on bot PRs. If it doesn't,
this design is decoration.

## Implementation sketch

1. **`specs.json` generation** (buildd, ~30 lines in `check-specs.ts`). Same
   write/`--check` treatment as `INDEX.md`, so a stale manifest fails CI. Add
   `user_facing` to the `Frontmatter` interface and to `SPEC-FORMAT.md`. Ship with
   every spec defaulting to `false`: no behaviour change until someone opts in.
2. **Mark the user-facing specs** (buildd). Judgment call per spec, one PR. From the
   current corpus the likely `true` set is auth boundaries, mission/task lifecycle,
   scheduled-task merge policy, MCP action contracts, MCP connectors & roles,
   artifacts & sharing, human-in-the-loop, work-tracker integration, release flow.
3. **Backfill `spec:` on the docs pages** (buildd-docs). 33 pages, most map to one
   spec or to none. This is the only genuinely manual step; do it as one PR per
   docs section so review stays honest. Set `spec_verified` to the spec's current
   `last_verified` **only** where the reviewer actually read both.
4. **`docs-spec-check.yml`** (buildd-docs) + the reverse check in `specs:lint`
   (buildd): a `user_facing` spec with no binding page fails the buildd build. The
   buildd side needs the page list, so the job fetches `content/**/*.mdx` frontmatter
   from the docs repo — or, cheaper and stateless, the docs job posts its binding map
   back as a generated `docs/reports/docs-bindings.json` PR. Prefer the fetch; a
   generated file in `reports/` is explicitly "never a source of truth".
5. **Bot PR on contract change** (buildd → buildd-docs). When a push to the default
   branch changes `last_verified` on a `user_facing` spec, open a PR in buildd-docs
   that updates nothing but the body: the spec diff, the bound pages, and the
   checklist item "re-read, then bump `spec_verified`". The failing check is the
   stick; this is the prompt.
6. **Keep the semantic loop for discovery.** The `spec-sync` skill stays exactly as
   it is, aimed at what the binding cannot see: capabilities with no spec, and pages
   describing behaviour that was never contracted. Fix its dead
   `workflow_run: ["Knowledge Ingest"]` trigger separately — a discovery loop whose
   corpus never refreshes reports false-green, which is worse than not running.

Steps 1–2 are inert on their own. The gate turns on at step 4.

## Open questions

- **Multiple specs per page.** `spec:` as a single slug keeps the inequality trivial;
  a list needs a per-slug stamp map (`spec_verified: {slug: date}`), which is more
  honest and more annoying. I lean single-slug plus a `spec_also: [slugs]` that is
  existence-checked but not stamp-checked, and splitting any page that genuinely
  renders two contracts.
- **`content/memory/*` (13 pages).** The memory service is a separate repo
  (`buildd-ai/memory`) with its own deploy. Binding those pages needs specs that
  live there, not here. I lean excluding `content/memory/**` from the reverse check
  until that repo has a `docs/specs/` of its own.
- **Where the reverse check runs.** Step 4 offers a fetch or a generated file. The
  fetch couples buildd's CI to the docs repo's default branch; a docs PR that adds a
  binding won't turn buildd green until it merges. Acceptable, but it means the
  buildd failure can only be cleared from the other repo.
- **Does `docs/SPEC.md` stay in the chain?** It is the narrative source of truth and
  the specs are the per-capability contracts. Nothing here checks SPEC.md against
  either. Leaning: leave it, and let the per-capability specs carry enforcement,
  because SPEC.md's §2/§4 are prose about the whole domain model and don't decompose
  into slug-sized claims.

## Non-goals

- **Generating docs prose from specs.** Specs are written for engineers changing the
  system; docs pages are written for users operating it. Machine-translating one into
  the other produces pages nobody wants to read. This design routes attention, not text.
- **Binding `buildd-site`.** Marketing copy has different truth requirements and no
  per-capability granularity.
- **Replacing the semantic drift loop.** Deterministic binding covers what someone
  thought to bind. Discovery of the unbound stays semantic and stays human-judged.
- **Enforcing `docs/SPEC.md` §2/§4 against schema diffs.** Worth doing, separate change.
- **Blocking docs PRs on unbound pages.** Concept and tutorial pages have no single
  contract; forcing a slug on them would produce fake bindings, which cost more than
  no binding.

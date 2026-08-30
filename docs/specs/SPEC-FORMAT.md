# Spec Format

Every capability spec in `docs/specs/` must follow this template. Specs describe
**contracts and behaviour** — not UI layout, visual design, or implementation
minutiae. They must be concrete enough for a validation agent to run automated
pass/fail checks against a live deployment.

---

## Frontmatter

Every spec opens with a flat YAML block. The parser in `scripts/check-specs.ts`
supports **string scalars and one-line arrays only** — no nesting, no multi-line
values. `bun run specs:check` enforces the required fields and regenerates
`INDEX.md`; `specs:lint` runs the same checks in CI.

```yaml
---
title: Release Flow                    # human name; must be unique among active specs
status: active                         # active | draft | superseded
owner: max                             # who answers questions about it
last_verified: 2026-08-29              # ISO date; warns past 90d
summary: The release system MUST resolve a workspace's configured strategy and fire exactly one release per mission.
domain: releases                       # exactly one of the vocabulary below
surfaces: [apps/web/src/lib/release-executor.ts, packages/core/release-strategy.ts]
related: [db-migration-gates, mission-task-lifecycle]
keywords: [deploy, workflow_dispatch, prod branch, tag]
supersedes: []                         # slugs this spec replaces
---
```

| Field | Required | Rules |
|---|---|---|
| `title` | yes | Unique across active specs (duplicate = error). |
| `status` | yes | `active` \| `draft` \| `superseded`. `superseded` requires `superseded_by`. |
| `owner` | yes | GitHub handle, no `@`. |
| `last_verified` | warn | ISO date. Missing or >90d old warns; an unparseable date is an error. Bump it in the same PR that changes behaviour. |
| `summary` | **yes** | ONE sentence, present tense, states what MUST hold. This is what a reader sees in the index and what a retrieval agent matches on — write the capability, not the topic. Missing is an error; over 220 chars warns. Must not begin with `[` — that parses as a list and is rejected. |
| `domain` | **yes** | Exactly one value from the vocabulary. A spec spanning two domains is usually two specs. |
| `surfaces` | no | 2–4 paths, most important first. Every path is existence-checked (dead path = error); more than 4 warns. Distinct from the in-body **Code surface** section, which is exhaustive; this is the shortlist. |
| `related` | no | Sibling spec **slugs** (filename without `.md`). Existence-checked; self-reference is an error. These are the graph edges an ingesting agent follows. |
| `keywords` | no | Retrieval aliases a reader would search that the title omits — old feature names, error strings, column names. |

**Domain vocabulary** (extend `DOMAINS` in `scripts/check-specs.ts` in the same
PR if you genuinely need a new one):

`missions` · `tasks` · `runners` · `releases` · `knowledge` · `auth` · `mcp` ·
`surfaces` · `integrations`

Why these fields exist: twenty specs with only a title are a directory listing,
not a map. `summary` + `domain` make `INDEX.md` answer "which spec covers this?"
without opening any file, and give an agent a filter and a one-line abstract per
spec instead of twenty full documents.

---

## `<Capability Name>`

**Capability statement**: One sentence, behaviour-focused. What the system MUST
do from the perspective of its callers. Written as an invariant, not a wish.

**Invariants**: Conditions that must hold at all times, regardless of input.
Bullet list, each item a precise predicate. If it's not falsifiable, it's not an
invariant.

**Acceptance criteria**: Concrete, testable pass/fail checks. Each criterion
must be unambiguous: given the described input, the described output or side
effect either occurs or it doesn't. A future validation agent can turn each item
into an assertion.

Format:
```
- AC-N: [GIVEN <precondition>] WHEN <action> THEN <observable result>
```

**Code surface**: File paths and symbols that implement this capability. Enough
for a reader to find the implementation without searching. Reference at least
one route handler, one data model, and one shared helper where all three exist.

**Out of scope**: What this spec explicitly does NOT cover. Prevents scope creep
and documents intentional omissions.

---

## Rules for spec authors

1. **At least 3 acceptance criteria** per spec block. Each must be independently
   checkable (no compound assertions).
2. **No vague language.** "Should" and "may" are banned. Use "MUST", "MUST NOT",
   "returns", "rejects with HTTP N".
3. **Error paths count.** Each spec must include at least one AC for a failure
   or rejection case.
4. **Code surface links must be real.** Verify each file path exists before
   committing.
5. **Specs are living documents.** When an implementation changes an observable
   behaviour, update the spec in the same PR.
6. **Frontmatter is part of the contract.** A new spec without `summary` and
   `domain` fails CI. When behaviour changes, re-read the `summary` — a stale
   one-liner is worse than none, because the index is where people stop reading.

# Spec Format

Every capability spec in `{{specsRoot}}/` follows this template. Specs describe
**contracts and behaviour**, not UI layout, visual design, or implementation
minutiae. They must be concrete enough for a validation agent to run automated
pass/fail checks against a running deployment.

Specs are flat: one markdown file per capability at `{{specsRoot}}/<slug>.md`.
No subdirectories.

---

## Frontmatter

Every spec opens with a flat YAML block: string scalars and one-line arrays
only, no nesting, no multi-line values.

```yaml
---
title: Order Checkout                  # human name; unique among active specs
status: draft                          # active | draft | superseded
owner: octocat                         # who answers questions about it
last_verified: 2026-01-15              # ISO date
summary: Checkout MUST charge a cart exactly once and MUST reject an empty cart.
domain: orders                         # exactly one value from the vocabulary below
surfaces: [src/checkout/charge.ts, src/checkout/routes.ts]
related: [inventory-reservation]
keywords: [payment, cart, charge]
verified_by: [tests/checkout.test.ts]  # tests that assert these invariants
supersedes: []                         # slugs this spec replaces
---
```

| Field | Required | Rules |
|---|---|---|
| `title` | yes | Unique across active specs. |
| `status` | yes | `active` \| `draft` \| `superseded`. `superseded` names its replacement in `superseded_by`. |
| `owner` | yes | GitHub handle, no `@`. |
| `last_verified` | recommended | ISO date. Bump it in the same PR that changes behaviour. |
| `summary` | yes | ONE sentence, present tense, states what MUST hold. It is what a reader sees in an index and what a retrieval agent matches on: write the capability, not the topic. Do not begin it with `[`, which parses as a list. |
| `domain` | yes | Exactly one value from the vocabulary. A spec spanning two domains is usually two specs. |
| `surfaces` | no | 2-4 paths, most important first. Every path exists. Distinct from the in-body **Code surface** section, which is exhaustive. |
| `related` | no | Sibling spec **slugs** (filename without `.md`). They exist; a spec never lists itself. |
| `keywords` | no | Retrieval aliases a reader would search that the title omits: old feature names, error strings. |
| `verified_by` | yes if active | Test files that actually assert this spec's invariants. Every path exists. |

**Domain vocabulary:**

<!-- keep-if: domains -->
{{domains}}
<!-- /keep-if -->
<!-- keep-if: !domains -->
TODO(owner): list the domains this repo's specs are grouped into (for example one per top-level area of the codebase), then delete this line.
<!-- /keep-if -->

Add a new domain here in the same PR that first uses it.

---

## `<Capability Name>`

**Capability statement**: One sentence, behaviour-focused. What the system MUST
do from the perspective of its callers. Written as an invariant, not a wish.

**Invariants**: Conditions that must hold at all times, regardless of input.
Bullet list, each item a precise predicate. If it is not falsifiable, it is not
an invariant.

**Acceptance criteria**: Concrete, testable pass/fail checks. Each criterion is
unambiguous: given the described input, the described output or side effect
either occurs or it does not. A future validation agent can turn each item into
an assertion.

Format:
```
- AC-N: [GIVEN <precondition>] WHEN <action> THEN <observable result>
```

**Code surface**: File paths and symbols that implement this capability. Enough
for a reader to find the implementation without searching. Reference at least
one entry point, one data model, and one shared helper where all three exist.

**Out of scope**: What this spec explicitly does NOT cover. Prevents scope creep
and documents intentional omissions.

---

## Rules for spec authors

1. **At least 3 acceptance criteria** per spec block. Each must be independently
   checkable (no compound assertions).
2. **No vague language.** "Should" and "may" are banned. Use "MUST", "MUST NOT",
   "returns", "rejects with an error".
3. **Error paths count.** Each spec must include at least one AC for a failure
   or rejection case.
4. **Code surface links must be real.** Verify each file path exists before
   committing.
5. **Specs are living documents.** When an implementation changes an observable
   behaviour, update the spec in the same PR.
6. **Frontmatter is part of the contract.** A new spec without `summary` and
   `domain` is incomplete. When behaviour changes, re-read the `summary`: a
   stale one-liner is worse than none, because the index is where people stop
   reading.
7. **No guard, no `active`.** An `active` spec names the tests that assert its
   invariants in `verified_by`. A contract nobody can fail is a wish, so a new
   spec with no guard ships as `status: draft` and is promoted once tests exist.

# Design Format

Every proposal in `{{designRoot}}/` follows this template. Design docs argue for
a **change that has not been built yet**: the problem, the shape of the fix, and
the tradeoffs.
<!-- keep-if: specsRoot -->
They are not contracts: `{{specsRoot}}/` describes what the system MUST do
today; `{{designRoot}}/` describes what it should do next, and why.
<!-- /keep-if -->
<!-- keep-if: !specsRoot -->
They are not contracts: a design describes what the system should do next, and
why, not what it guarantees today.
<!-- /keep-if -->

Applies to new docs and to any doc you substantially edit. Do not bulk-rewrite
existing files to conform.

---

## Header

```markdown
# <Title>

**Status:** Proposed | Accepted | Implemented | Superseded
**Related:** real paths and docs a reader needs: code, sibling designs, specs
```

Use plain bold, not a blockquote. `**Superseded**` names its replacement.

## Required sections

**Problem**: the concrete failure, stated first. Lead with observed behaviour
(an error string, a wrong state), not an abstraction. If nothing is broken and
nothing is blocked, you do not need a design doc.

**Proposal**: the change. Name the **crux**: the one decision the design turns
on, and what breaks if it is wrong. A proposal without an identified crux is a
wish list.

**Open questions**: decisions you are deliberately NOT making alone. Say which
way you lean and why. An empty section means you either resolved everything or
you are hiding something.

**Non-goals**: what this explicitly does not cover. Prevents scope creep and
records intentional omissions.

Optional but common: **Current state** (cite the code you are changing),
**Implementation sketch** (ordered, with the load-bearing piece first).

## Rules for design authors

1. **Cite real code.** Every path and symbol exists. Verify before committing.
   Describe what the code does now, not what you remember it doing.
2. **Defaults must be no-ops.** New config ships defaulting to current
   behaviour, so merging the change alters nothing until someone opts in.
3. **Name the safety property.** Anything automatic (retries, failover, spend,
   deletion) states its bound: max attempts, cycle stop, throttle.
<!-- keep-if: isPublic -->
4. **This repo is public.** No real task or worker IDs, internal hostnames,
   customer names, or usage numbers. Use illustrative values.
5. **Close the loop.** When it ships, set `Status: Implemented` and link the PR.
<!-- keep-if: specsRoot -->
   If the design becomes a standing contract, promote it into `{{specsRoot}}/`
   and mark this doc `Superseded`.
<!-- /keep-if -->
<!-- /keep-if -->
<!-- keep-if: !isPublic -->
4. **Close the loop.** When it ships, set `Status: Implemented` and link the PR.
<!-- keep-if: specsRoot -->
   If the design becomes a standing contract, promote it into `{{specsRoot}}/`
   and mark this doc `Superseded`.
<!-- /keep-if -->
<!-- /keep-if -->

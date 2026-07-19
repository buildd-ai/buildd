# Design Format

Every proposal in `docs/design/` must follow this template. Design docs argue for
a **change that hasn't been built yet** — the problem, the shape of the fix, and
the tradeoffs. They are not contracts: `docs/specs/` describes what the system
MUST do today; `docs/design/` describes what it should do next, and why.

Applies to new docs and to any doc you substantially edit. Don't bulk-rewrite
existing files to conform.

---

## Header

```markdown
# <Title>

**Status:** Proposed | Accepted | Implemented | Superseded
**Related:** real paths and docs a reader needs — code, sibling designs, specs
```

Use plain bold, not a blockquote. `**Superseded**` must name its replacement.

## Required sections

**Problem** — the concrete failure, stated first. Lead with observed behaviour
(an error string, a wrong state), not an abstraction. If nothing is broken and
nothing is blocked, you don't need a design doc.

**Proposal** — the change. Name the **crux**: the one decision the design turns
on, and what breaks if it's wrong. A proposal without an identified crux is a
wish list.

**Open questions** — decisions you are deliberately NOT making alone. Say which
way you lean and why. An empty section means you either resolved everything or
you're hiding something.

**Non-goals** — what this explicitly does not cover. Prevents scope creep and
records intentional omissions.

Optional but common: **Current state** (cite the code you're changing),
**Implementation sketch** (ordered, with the load-bearing piece first).

## Rules for design authors

1. **Cite real code.** Every path/symbol must exist — verify before committing.
   Describe what the code does now, not what you remember it doing.
2. **Defaults must be no-ops.** New config ships defaulting to current
   behaviour, so merging the change alters nothing until someone opts in.
3. **Name the safety property.** Anything automatic (retries, failover, spend,
   deletion) states its bound: max attempts, cycle stop, throttle.
4. **This repo is public.** No real task/worker IDs, internal hostnames,
   customer names, or usage numbers. Use illustrative values.
5. **Close the loop.** When it ships, set `Status: Implemented` and link the PR,
   or promote the contract into `docs/specs/` and mark this `Superseded`. A doc
   stuck on `Proposed` after the code landed is a lie.

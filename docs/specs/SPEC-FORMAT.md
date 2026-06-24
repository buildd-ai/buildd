# Spec Format

Every capability spec in `docs/specs/` must follow this template. Specs describe
**contracts and behaviour** — not UI layout, visual design, or implementation
minutiae. They must be concrete enough for a validation agent to run automated
pass/fail checks against a live deployment.

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

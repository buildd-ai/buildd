# Buildd Component Patterns — moved

This file used to carry its own component spec. It drifted from the code and is
retired.

**Read [`docs/design/design-system.md`](../../../../docs/design/design-system.md):**

- §2.7 geometry, borders, shadows, button heights, z-index
- §2.8 the existing type classes (`.section-label`, `.status-pill`, `.field-label`, …)
- §4 the primitive inventory: Chip, Eyebrow, Section, Lede, PrimaryAction,
  Disclosure, Sheet, and which existing components each replaces

The executable source is `apps/web/src/app/globals.css` (`.card`, `.btn*`,
`.status-pill`, `.health-pill`, `.inset-panel`, `.seg`, `.notice`,
`.field-label`) and `apps/web/tailwind.config.ts`. If anything disagrees with
`globals.css`, `globals.css` wins.

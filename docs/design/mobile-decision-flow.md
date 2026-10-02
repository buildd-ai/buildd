---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# timeline-day-bands and gate-chip-collapse genuinely shipped (I-16 §3.8 wave
# banding and I-11 §1.3 timeline gate chip collapse) — this isn't a false
# positive — but the doc must stay 'partially' until I-3/I-4 (Missions list
# initiative grouping, §4.1-§4.2) ship, so these assertions will pass forever
# under a non-terminal status. Suppressed below (skip_until) rather than left
# to redispatch a reconcile-spec task against an already-accurate doc;
# re-verify and either renew or drop the suppression once I-3/I-4 ship and the
# doc can promote to 'implemented'.
assertions:
  - id: "timeline-day-bands"
    type: "symbol"
    name: "deriveDayBands"
    path: "apps/web/src/lib/condensed-timeline.ts"
    skip_until: "2026-12-15"
    skip_reason: "deriveDayBands genuinely shipped (I-16, §3.8 wave banding) — this isn't a false positive — but the doc must stay 'partially' until I-3/I-4 (Missions list initiative grouping) ship, so this assertion will pass forever under a non-terminal status."
  - id: "gate-chip-collapse"
    type: "symbol"
    name: "gateChipCollapsed"
    path: "apps/web/src/lib/condensed-timeline.ts"
    skip_until: "2026-12-15"
    skip_reason: "gateChipCollapsed genuinely shipped (I-11, §1.3 timeline gate chip collapse) — this isn't a false positive — but the doc must stay 'partially' until I-3/I-4 (Missions list initiative grouping) ship, so this assertion will pass forever under a non-terminal status."
  - id: "timeline-density-tests"
    type: "test_file"
    path: "apps/web/src/lib/condensed-timeline.test.ts"
    skip_until: "2026-12-15"
    skip_reason: "Assertions here only cover the shipped condensed-timeline subset (I-7, I-8, I-11, I-13-I-16); I-3 and I-4 (Missions list initiative grouping, §4.1-§4.2) remain unbuilt and unasserted — the rest of the breakdown (I-1, I-2, I-5, I-6, I-9, I-10, I-12) has since shipped too but gained no new assertions here — so status is intentionally held at 'partially' rather than promoted."
---

# mobile-decision-flow

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/mobile-decision-flow.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).

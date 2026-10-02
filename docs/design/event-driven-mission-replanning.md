---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
# Shipped: events plan every auto mission and wake it on non-task events (S1,
# PR #3117), the organizer checklist trim (S3, PR #3114), and the heartbeat as
# a stuck-check backstop with default check-ins (S2), and the UI copy (S4):
# check-ins and organizer runs labelled by trigger (lib/mission-checkins.ts).
assertions:
  - id: "wake-mission"
    type: "symbol"
    name: "wakeMission"
    path: "apps/web/src/lib/mission-wake.ts"
  - id: "stuck-check"
    type: "symbol"
    name: "isMissionStuck"
    path: "apps/web/src/lib/mission-stuck.ts"
  - id: "backstop-grace"
    type: "symbol"
    name: "BACKSTOP_GRACE_MS"
    path: "apps/web/src/lib/mission-stuck.ts"
  - id: "stuck-check-in-cron"
    type: "symbol_reachable"
    symbol: "isMissionStuck"
    entry: "apps/web/src/app/api/cron/schedules/route.ts"
    as: "call"
  - id: "stuck-check-tests"
    type: "test_file"
    path: "apps/web/src/lib/mission-stuck.test.ts"
  - id: "organizer-run-label"
    type: "symbol"
    name: "organizerRunLabel"
    path: "apps/web/src/lib/mission-checkins.ts"
  - id: "last-check"
    type: "symbol"
    name: "describeLastCheck"
    path: "apps/web/src/lib/mission-checkins.ts"
  - id: "checkins-copy-tests"
    type: "test_file"
    path: "apps/web/src/lib/mission-checkins.test.ts"
---

# event-driven-mission-replanning

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/event-driven-mission-replanning.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).

---
status: implemented
# Promoted 2026-09-23 with slice S3 of mission-feed-mobile-continuity.md, which
# deleted `deriveWorkLane` (Rule L-4 item (c)); items (a) and (b) shipped in S1.
# The retirement is pinned by a git-grep test
# (missions/[id]/mission-detail-retirements.test.ts), since no assertion type
# expresses an absence. Every assertion below passes for the reason it names.
assertions:
  - id: "compute-mission-flight-strip"
    type: "symbol"
    name: "computeMissionFlightStrip"
    path: "packages/core/mission-helpers.ts"
  - id: "flight-strip-reachable-from-detail-page"
    type: "symbol_reachable"
    symbol: "computeMissionFlightStrip"
    entry: "apps/web/src/app/app/(protected)/missions/[id]/page.tsx"
  - id: "flight-strip-cache-migration"
    type: "migration"
    number: "0000"
    contains: "flight_strip_cache"
  - id: "list-card-pagination-rule-p4"
    type: "symbol_reachable"
    symbol: "completedCursor"
    entry: "apps/web/src/app/app/(protected)/missions/page.tsx"
    as: "read"
  # The completed-mission stats row went with the Delivery stepper (#2888).
  # The page's duration is now the header's "40m of work · open 35d", read
  # from the Board model's unioned work spans (lib/mission-duration.ts), the
  # same figure Home and the missions list print.
  - id: "detail-header-duration-on-work-spans"
    type: "symbol_reachable"
    symbol: "activeMs"
    entry: "apps/web/src/app/app/(protected)/missions/[id]/page.tsx"
    as: "read"
---

# mission-flight-strip

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/mission-flight-strip.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).

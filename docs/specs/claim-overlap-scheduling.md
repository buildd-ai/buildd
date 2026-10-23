---
title: Claim Overlap Scheduling
status: superseded
superseded_by: "75217f55 / Overlap scheduling: serial lanes and file locks"
owner: max
last_verified: 2026-10-22
summary: Overlap scheduling MUST follow the approved serial lanes and file locks spec that replaces this contract.
domain: tasks
related: [path-claim-ownership, force-start, claim-ordering]
---

# Claim Overlap Scheduling

Replaced by approved Living Spec **75217f55: Overlap scheduling: serial lanes
and file locks** (revision 1), which also replaces imported spec ac1a1df2.

Serial lanes run schema, migrations and configured hard surfaces one task at a
time in a stored order. File locks protect active edits. Other file overlaps do
not hold a task at creation or claim time. Declared dependencies still apply.

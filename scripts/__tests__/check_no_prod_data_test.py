#!/usr/bin/env python3
"""Tests for the public-repo data check.

Every MUST_PASS case below is a real false positive the first version of this
check produced, taken from a sweep of this repo's own commit history. Every
MUST_FAIL case is a disclosure shape that first version let straight through.
Both lists are the point of the file: the check was simultaneously too loud on
measurements and too quiet on the counts that actually matter.
"""

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "chk", HERE.parent / "check_no_prod_data.py")
chk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chk)


def flags(line: str) -> bool:
    big = chk.COUNT_BIG.search(line)
    tenancy = chk.COUNT_TENANCY.search(line)
    small = (chk.COUNT_SMALL_IN_CONTEXT.search(line)
             and chk.PROD_CONTEXT_RE.search(line))
    return bool(big or tenancy or small or chk.UUID_RE.search(line))


MUST_PASS = [
    # Measurements and limits — ordinary engineering prose.
    "chore: bump bundle budget to 1,024 KB",
    "fix: retry backoff now 2,000 ms instead of 30s",
    "docs: Postgres text limit is 1,073,741,824 bytes",
    "fix: handle HTTP 429 with Retry-After 3,600",
    "feat: cap Pusher payloads at 10,240 bytes",
    "test: benchmark over 10,000 iterations",
    "fix: correct currency formatting for $1,499 plans",
    "feat: paginate at 1,000 items per page",
    # Third-party public stats — a recurring commit genre in this repo.
    "docs: SDK scan — 82K+ stars, 10,913+ repos indexed",
    "docs: research scan — 43K stars, 9,600+ forks",
    "docs: Anthropic launch supports up to 1,000 parallel calls",
    # Our own repo's code-graph size is not customer data.
    "perf(cbm): index 63,861 nodes and 77,831 edges",
    # Ordinary text with no figures.
    "refactor: split the helper and tidy the imports",
    "fix: guard against a null workspace repo",
    "test: 517/517 unit test files pass",
    # Squash subjects always end in a PR reference — 162 FPs on real history.
    "fix(runner): isolate the per-worker daemon (#1964)",
    "fix(workers): write effectiveCost back to workers.costUsd (#1973)",
    "fix(budget-forecast): include null-workspace team missions (#1971)",
    "feat(missions): mission Structure tab (#1968)",
    # Configuration limits and fixtures, not populations.
    "feat: cap at 60 workers per workspace",
    "test: scenario seeds 12 tasks and asserts ordering",
    "perf: keep just the last 100 calls per worker",
    "fix: rows use */30 in the cron expression",
]

MUST_FAIL = [
    # Population counts — the thing that actually discloses.
    "prod has 487 teams and 62 workspaces",              # sub-1000: missed before
    "migrated 3521 records from the old service",         # noun 'records': missed before
    "12000 tasks in the queue backlog",                   # noun 'tasks': missed before
    "fix: verified 3,521/3,521 rows byte-identical",      # the original leak shape
    "chore: 25 api keys minted across 9 teams",           # tenancy
    "docs: 15k users affected by the outage",             # k suffix: missed before
    "note: rows=4231 in the memories table",              # noun before number
    "prod currently has 900 seats across all customers",        # noun then number
    "seeded 1500 users in the load fixture",
    # Row identifiers.
    "fix: scope to team d2cb1c29-3f92-4ea1-ba0c-fe8b41ccf3b5",
    "fix: worker D2CB1C29-3F92-4EA1-BA0C-FE8B41CCF3B5 stalled",  # uppercase
]


def main() -> int:
    bad = []
    for line in MUST_PASS:
        if flags(line):
            bad.append(f"FALSE POSITIVE: {line!r}")
    for line in MUST_FAIL:
        if not flags(line):
            bad.append(f"MISSED:         {line!r}")

    # masking must never leak digits or hex
    masked = chk.mask("3,521 rows and d2cb1c29-3f92-4ea1-ba0c-fe8b41ccf3b5")
    if any(c.isdigit() for c in masked):
        bad.append(f"MASK LEAKS DIGITS: {masked!r}")

    total = len(MUST_PASS) + len(MUST_FAIL) + 1
    if bad:
        print(f"{len(bad)} of {total} failed:")
        for b in bad:
            print("  " + b)
        return 1
    print(f"all {total} cases pass "
          f"({len(MUST_PASS)} must-pass, {len(MUST_FAIL)} must-fail, 1 masking)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

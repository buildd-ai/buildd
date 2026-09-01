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


# The escape hatch must be usable without being triggerable by mention. An
# unanchored pattern matched its own documentation and disabled the check on the
# PR that introduced it.
ALLOW_MUST_NOT_TRIGGER = [
    "- **`no-prod-data: allow <reason>` escape hatch.**",
    "documented at `no-prod-data: allow` in CLAUDE.md",
    "we could add a no-prod-data: allow marker later",
]
ALLOW_MUST_TRIGGER = [
    "no-prod-data: allow documenting the pattern itself",
    "  no-prod-data: allow third-party star counts",
]


# ── Guard-integrity cases ───────────────────────────────────────────────────
#
# The three cases below are not pattern tuning. They cover the ways this check
# could be *present and green while doing nothing*, which is the failure mode it
# actually hit: NO_PROD_DATA_IDENTIFIERS was never set on this repo, so from the
# day the check shipped until it was noticed, the identifier half — the only half
# that reads added code — ran on every PR and scanned nothing, warning into a log
# nobody reads and exiting 0.

import os
import subprocess

SCRIPT = HERE.parent / "check_no_prod_data.py"


def run_main(env_extra: dict, cwd: Path) -> subprocess.CompletedProcess:
    """Run the checker end to end, so the exit code is the thing under test."""
    env = {**os.environ, **env_extra}
    return subprocess.run(
        [sys.executable, str(SCRIPT), "HEAD", "--body", "/dev/null",
         "--title", "/dev/null"],
        capture_output=True, text=True, cwd=cwd, env=env)


def guard_integrity_failures(tmp: Path) -> list[str]:
    bad = []

    # 1. An absent identifier list must FAIL. Skipping half the check and
    #    exiting 0 makes every PR green over an empty set.
    r = run_main({"NO_PROD_DATA_IDENTIFIERS": ""}, tmp)
    if r.returncode == 0:
        bad.append("UNSET IDENTIFIERS EXITED 0: the code-scan half is a no-op "
                   "and the check still passed")

    # 2. With a list present the checker must run and say so, not fail open.
    r = run_main({"NO_PROD_DATA_IDENTIFIERS": r"\bzzzunlikelyhandle\b"}, tmp)
    if r.returncode != 0:
        bad.append(f"SET IDENTIFIERS FAILED A CLEAN TREE: rc={r.returncode} "
                   f"{r.stdout.strip()[:120]!r}")

    # 3. An identifier finding must never echo the match. mask() only redacts
    #    [0-9a-f], so a name made of other letters survives it almost intact —
    #    and Actions logs on a public repo are world-readable, so printing the
    #    excerpt republishes the private name the check exists to catch.
    secret = "some-private-repo-name"
    rep = chk.Report()
    import io
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rep.hit_identifier("added code", 7, f"const repo = '{secret}';")
    out = buf.getvalue()
    for fragment in (secret, "private-repo", "some-private"):
        if fragment in out:
            bad.append(f"IDENTIFIER FINDING ECHOED THE MATCH: {fragment!r} "
                       f"appears in {out.strip()[:120]!r}")
            break

    return bad


def main() -> int:
    bad = []
    for line in MUST_PASS:
        if flags(line):
            bad.append(f"FALSE POSITIVE: {line!r}")
    for line in MUST_FAIL:
        if not flags(line):
            bad.append(f"MISSED:         {line!r}")

    for line in ALLOW_MUST_NOT_TRIGGER:
        if chk.ALLOW_RE.search(line):
            bad.append(f"ALLOW TRIGGERED BY MENTION: {line!r}")
    for line in ALLOW_MUST_TRIGGER:
        if not chk.ALLOW_RE.search(line):
            bad.append(f"ALLOW NOT HONOURED: {line!r}")

    import tempfile
    with tempfile.TemporaryDirectory() as td:
        bad.extend(guard_integrity_failures(Path(td)))

    # masking must never leak digits or hex
    masked = chk.mask("3,521 rows and d2cb1c29-3f92-4ea1-ba0c-fe8b41ccf3b5")
    if any(c.isdigit() for c in masked):
        bad.append(f"MASK LEAKS DIGITS: {masked!r}")

    total = (len(MUST_PASS) + len(MUST_FAIL)
             + len(ALLOW_MUST_NOT_TRIGGER) + len(ALLOW_MUST_TRIGGER) + 1 + 3)
    if bad:
        print(f"{len(bad)} of {total} failed:")
        for b in bad:
            print("  " + b)
        return 1
    print(f"all {total} cases pass "
          f"({len(MUST_PASS)} must-pass, {len(MUST_FAIL)} must-fail, "
          f"{len(ALLOW_MUST_NOT_TRIGGER) + len(ALLOW_MUST_TRIGGER)} escape-hatch, "
          f"1 masking, 3 guard-integrity)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

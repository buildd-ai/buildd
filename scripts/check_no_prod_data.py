#!/usr/bin/env python3
"""Fail if production data appears in a change to this PUBLIC repo.

Scoping is deliberate, to stay useful rather than noisy:

  - Counts and UUIDs are checked in the PR title, the PR body and commit
    messages, where they are almost never legitimate. NOT in code, which uses
    large numbers and UUID fixtures honestly.
  - Identifiers (personal handles, private repo names) are checked in those
    places AND in added code lines, because they are never legitimate here.

Two rules learned the hard way, both from real failures of the first version:

  1. Never print the matched text. This runs on a public repo, and Actions logs
     on a public repo are world-readable, so echoing the match would republish
     the very figure the check exists to keep out. Findings report a category, a
     location and a masked excerpt only.

  2. A bare grouped-thousands figure is not evidence of anything. `1,024 KB`,
     `Retry-After 3,600` and third-party star counts are ordinary engineering
     prose. What matters is a number *tied to a data noun* — and at that point
     the magnitude stops mattering, so the floor is two digits, not four.
     `487 teams` is more sensitive here than `10,240 bytes` will ever be.

The identifier list is NOT stored in this repo -- it would itself be a personal
handle and private repo names committed to a public repository. It arrives via
NO_PROD_DATA_IDENTIFIERS as a regex alternation. When unset, that half is
skipped and the script says so rather than passing quietly.

Escape hatch: a line containing `no-prod-data: allow <reason>` in the PR body
suppresses the count/UUID rules for that PR, and is reported. Documenting this
check necessarily instantiates the patterns it forbids.

Usage:  check_no_prod_data.py <base-ref> [--body FILE] [--title FILE]
Exit:   0 clean, 1 violation, 2 usage error.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

# ── Patterns ────────────────────────────────────────────────────────────────

# Two classes of noun, because they carry different risk.
#
# TENANCY nouns count paying entities. A number beside one of these is a
# disclosure at any magnitude -- "25 api keys across 9 teams" says more about
# the business than a six-figure row count does, and nobody writes a
# configuration limit in terms of customers.
TENANCY = (
    r"teams?|tenants?|customers?|orgs?|organi[sz]ations?|seats?|subscribers?|"
    r"accounts?|api keys?|paying"
)
# VOLUME nouns count things inside the product. These appear constantly as
# batch sizes, concurrency caps and test fixtures, so they need either a large
# figure or a production-flavoured sentence before they mean anything.
VOLUME = (
    r"rows?|records?|entries|entities|memories|keys?|users?|workspaces?|"
    r"workers?|chunks?|tasks?|missions?|sessions?"
)
NOUNS = rf"{TENANCY}|{VOLUME}"

# A quoted population figure: grouped thousands, or 4+ digits, or a k/M/B
# suffix. The floor is deliberate. Sub-1000 numbers beside a data noun are
# overwhelmingly concurrency limits, test fixtures and batch sizes -- measured
# against this repo's own history, dropping the floor produced ~150 false
# positives and would have got the check switched off inside a day.
BIG = r"\d{1,3}(?:,\d{3})+|\d{4,}|\d{2,}(?:\.\d+)?\s*[kKmMbB]\b"

# Units that make a figure a measurement rather than a population.
UNITS = (
    r"kb|mb|gb|tb|kib|mib|gib|bytes?|bits?|ms|milliseconds?|s|seconds?|"
    r"minutes?|hours?|days?|px|rem|em|%|stars?|forks?|tokens?|iterations?|"
    r"items?|lines?|chars?|characters?|commits?|files?|prs?|issues?|"
    r"requests?/s|rps|qps|usd|eur|gbp"
)

# Words that mark a sentence as being about live data rather than configuration.
# These let a SMALL figure count, because "prod has 487 teams" is a disclosure
# while "cap at 60 workers" is not, and only the surrounding words tell them
# apart. Tenancy counts here are small, so without this the real risk is missed.
PROD_CONTEXT = r"\bprod(?:uction)?\b|\blive\b|\bcurrently\b|\btotal\b|\bwe (?:have|had)\b|\bacross all\b"

# A big figure beside a data noun. `(?<!#)` keeps every squash subject's trailing
# "(#1964)" out -- that alone was 162 hits on this repo's history.
# `(?:/[\d,]+)?` catches the "N,NNN/N,NNN rows" form: the real disclosure that
# prompted this check was written that way, and without it the slash defeats the
# match entirely.
COUNT_BIG = re.compile(
    rf"(?<![\w.#-])({BIG})(?:\s*/\s*[\d,]+)?\s+(?!(?:{UNITS})\b)"
    rf"(?:[a-z-]+\s+){{0,2}}?({NOUNS})\b",
    re.I,
)
# Any figure, however small, beside a tenancy noun.
COUNT_TENANCY = re.compile(
    rf"(?<![\w./#-])(\d+)(?:\s*/\s*[\d,]+)?\s+(?!(?:{UNITS})\b)"
    rf"(?:[a-z-]+\s+){{0,2}}?({TENANCY})\b",
    re.I,
)
# A small figure beside a data noun, only in a production-flavoured sentence.
COUNT_SMALL_IN_CONTEXT = re.compile(
    rf"(?<![\w./#-])(\d{{2,3}})\s+(?!(?:{UNITS})\b)(?:[a-z-]+\s+){{0,2}}?({NOUNS})\b",
    re.I,
)
UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I
)
PROD_CONTEXT_RE = re.compile(PROD_CONTEXT, re.I)

ALLOW_RE = re.compile(r"no-prod-data:\s*allow\b(.*)", re.I)

# This file documents the categories it forbids, so exclude it from the scan of
# added lines or it flags its own docstring.
SELF = ("scripts/check_no_prod_data.py", "scripts/check-no-prod-data.sh")


def mask(text: str) -> str:
    """Redact digits and hex so a finding never republishes the value."""
    return re.sub(r"[0-9a-f]", "•", text, flags=re.I)


class Report:
    def __init__(self) -> None:
        self.failed = False

    def hit(self, where: str, category: str, line_no: int, excerpt: str, advice: str) -> None:
        self.failed = True
        # Masked, and truncated. Never the raw match.
        shown = mask(excerpt.strip())[:110]
        print(f"::error::{where}: possible {category} at line {line_no} — {advice}")
        print(f"   masked: {shown}")


def scan_prose(text: str, where: str, rep: Report, check_counts: bool) -> None:
    ident = os.environ.get("NO_PROD_DATA_IDENTIFIERS", "").strip()
    ident_re = re.compile(ident, re.I) if ident else None

    for i, line in enumerate(text.splitlines(), 1):
        if check_counts:
            big = COUNT_BIG.search(line)
            tenancy = COUNT_TENANCY.search(line)
            small = (COUNT_SMALL_IN_CONTEXT.search(line)
                     and PROD_CONTEXT_RE.search(line))
            if big or tenancy or small:
                rep.hit(where, "population count", i, line,
                        "state evidence qualitatively; exact figures belong in the private knowledge-base")
            if UUID_RE.search(line):
                rep.hit(where, "UUID", i, line,
                        "row identifiers must not enter a public repo")
        if ident_re and ident_re.search(line):
            rep.hit(where, "personal handle or private repo name", i, line,
                    "remove it; this repository is public")


def main() -> int:
    args = [a for a in sys.argv[1:]]
    if not args:
        print(__doc__)
        return 2
    base = args[0]
    body_file = title_file = None
    for flag, target in (("--body", "body"), ("--title", "title")):
        if flag in args:
            val = args[args.index(flag) + 1]
            if target == "body":
                body_file = val
            else:
                title_file = val

    rep = Report()

    body = ""
    if body_file and os.path.exists(body_file):
        body = open(body_file, encoding="utf8", errors="replace").read()

    allow = ALLOW_RE.search(body)
    if allow:
        print(f"::warning::count/UUID rules suppressed by 'no-prod-data: allow'"
              f"{(' —' + allow.group(1)) if allow.group(1).strip() else ''}. "
              "Identifier checks still apply.")

    check_counts = allow is None

    if title_file and os.path.exists(title_file):
        scan_prose(open(title_file, encoding="utf8", errors="replace").read(),
                   "PR title", rep, check_counts)
    if body:
        scan_prose(body, "PR body", rep, check_counts)

    msgs = subprocess.run(["git", "log", "--format=%B", f"{base}..HEAD"],
                          capture_output=True, text=True).stdout
    if msgs.strip():
        scan_prose(msgs, "commit message", rep, check_counts)

    # Added code lines: identifiers only.
    ident = os.environ.get("NO_PROD_DATA_IDENTIFIERS", "").strip()
    if ident:
        excludes = [f":(exclude){p}" for p in SELF]
        diff = subprocess.run(
            ["git", "diff", f"{base}...HEAD", "--", ".",
             ":(exclude)packages/core/drizzle/meta", *excludes],
            capture_output=True, text=True).stdout
        added = [l for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++")]
        rx = re.compile(ident, re.I)
        for i, line in enumerate(added, 1):
            if rx.search(line):
                rep.hit("added code", "personal handle or private repo name", i, line,
                        "remove it; this repository is public")
    else:
        print("::warning::NO_PROD_DATA_IDENTIFIERS is not set — "
              "handle and private-repo checks were skipped in code and prose.")

    if rep.failed:
        print()
        print("This repository is public. See 'This Repo Is Public' in CLAUDE.md.")
        print("Matches are shown masked on purpose: Actions logs on a public repo are")
        print("world-readable, so printing the value would republish it.")
        print("If a finding is a false positive, add a line to the PR body:")
        print("  no-prod-data: allow <short reason>")
        return 1

    print("no-prod-data: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())

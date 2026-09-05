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
NO_PROD_DATA_IDENTIFIERS as a regex alternation, and it must come from a SECRET
rather than an Actions variable: variable values are echoed unmasked into the
step's env group, and Actions logs on a public repo are world-readable, so
carrying the list in a variable would publish it on every run.

When the list is absent this script FAILS. It used to warn and exit 0, which is
how the identifier half -- the only half that reads added code -- ran on every PR
against an empty pattern for its entire life without anyone noticing. A guard
that cannot see anything must not report success.

Escape hatch: a line STARTING with `no-prod-data: allow <reason>` in the PR body
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

# Must start a line and carry a reason. An unanchored version matched its own
# documentation -- a PR body that merely named the marker, inside backticks,
# switched the check off on that PR. Mentioning the escape hatch must not be
# the same act as using it.
ALLOW_RE = re.compile(r"^[ \t]*no-prod-data:[ \t]*allow[ \t]+(\S.*)$", re.I | re.M)

# This file documents the categories it forbids, so exclude it from the scan of
# added lines or it flags its own docstring.
SELF = ("scripts/check_no_prod_data.py", "scripts/check-no-prod-data.sh")


def mask(text: str) -> str:
    """Redact digits and hex so a finding never republishes the value."""
    return re.sub(r"[0-9a-f]", "•", text, flags=re.I)


class Report:
    def __init__(self) -> None:
        self.failed = False
        # Tracked separately so the epilogue only offers the escape hatch when
        # the hatch would actually help. It suppresses the count/UUID rules and
        # nothing else, so advertising it under a missing-secret failure sends
        # the reader to a switch that cannot clear their error.
        self.suppressible = False

    def hit(self, where: str, category: str, line_no: int, excerpt: str, advice: str) -> None:
        self.failed = True
        self.suppressible = True
        # Masked, and truncated. Never the raw match.
        shown = mask(excerpt.strip())[:110]
        print(f"::error::{where}: possible {category} at line {line_no} — {advice}")
        print(f"   masked: {shown}")

    def hit_identifier(self, where: str, line_no: int, excerpt: str) -> None:
        """Report an identifier match with NO excerpt at all.

        `mask` only redacts [0-9a-f], which is right for a count or a UUID --
        digits are the payload there. A personal handle or a private repo name is
        made of the other twenty letters, so masking leaves it readable
        ('some-private-repo-name' -> 'som•-priv•t•-r•po-n•m•'). Echoing it here
        would republish the exact string this check exists to keep out of a public
        repo. The location is enough: whoever wrote the line knows what is on it.
        """
        self.failed = True
        del excerpt  # deliberately unused -- see above
        print(f"::error::{where}: possible personal handle or private repo name "
              f"at line {line_no} — remove it; this repository is public. "
              f"The match is not printed: this log is world-readable.")


# `+++ b/path` names the file that the following `+` lines belong to. Tracking it
# is what lets the UUID scan skip test paths without skipping the rest of a diff.
DIFF_FILE_RE = re.compile(r"^\+\+\+ b/(.*)$")
TEST_PATH_RE = re.compile(r"(^|/)__tests__/|\.test\.[jt]sx?$|(^|/)tests/")


def added_source_lines(diff: str) -> list[tuple[str, str]]:
    """`(path, line)` for every added line that is NOT in a test file.

    Walks the raw diff so the owning path is known per line; the caller's
    pre-filtered `+`-only list has already thrown that away.
    """
    out: list[tuple[str, str]] = []
    path = "?"
    for line in diff.splitlines():
        header = DIFF_FILE_RE.match(line)
        if header:
            path = header.group(1)
            continue
        if line.startswith("+") and not line.startswith("+++"):
            if not TEST_PATH_RE.search(path):
                out.append((path, line))
    return out


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
            rep.hit_identifier(where, i, line)


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

    excludes = [f":(exclude){p}" for p in SELF]
    diff = subprocess.run(
        ["git", "diff", f"{base}...HEAD", "--", ".",
         ":(exclude)packages/core/drizzle/meta", *excludes],
        capture_output=True, text=True).stdout
    added = [l for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++")]

    # Added SOURCE lines: UUIDs. Needs no secret, so unlike the identifier half
    # below it cannot silently no-op.
    #
    # This existed only for prose (PR title/body/commit messages) until a real
    # workspace id sat in a committed .ts file for months: code was never
    # scanned for UUIDs at all, so the rule was enforced on the description of a
    # change and not on the change.
    #
    # Test files are excluded deliberately. They are full of UUID-shaped
    # fixtures, and a good number are high-entropy enough to be indistinguishable
    # from real ones by shape or by character variety — measured on this repo,
    # `aabbccdd-1234-5678-9abc-def012345678` (synthetic) and
    # `d7e60452-8a4d-49e6-9cf3-60221baf12dd` (looks real) both use 16 distinct
    # hex characters, so no entropy threshold separates them. Every real-looking
    # UUID in the tree today lives under a test path. KNOWN GAP: a genuine id
    # pasted into a test file still passes. Narrow and stated beats broad and
    # switched off for noise.
    if check_counts:
        for i, (path, line) in enumerate(added_source_lines(diff), 1):
            if UUID_RE.search(line):
                rep.hit(f"added source line ({path})", "UUID", i, line,
                        "pass it in at run time (env var or argument); "
                        "row identifiers must not enter a public repo")

    # Added code lines: identifiers only.
    ident = os.environ.get("NO_PROD_DATA_IDENTIFIERS", "").strip()
    if ident:
        rx = re.compile(ident, re.I)
        for i, line in enumerate(added, 1):
            if rx.search(line):
                rep.hit_identifier("added code", i, line)
    else:
        # Not a warning. With no pattern there is nothing to match, so the
        # identifier half of this check silently passes every PR -- including one
        # that adds a private repo name to a public file.
        rep.failed = True
        print("::error::NO_PROD_DATA_IDENTIFIERS is not set, so the handle and "
              "private-repo checks scanned nothing. Set it as a repository "
              "SECRET (not a variable -- variable values are printed in this "
              "log) under Settings → Secrets and variables → Actions.")

    if rep.failed:
        print()
        print("This repository is public. See 'This Repo Is Public' in CLAUDE.md.")
        if rep.suppressible:
            print("Matches are shown masked on purpose: Actions logs on a public repo are")
            print("world-readable, so printing the value would republish it.")
            print("If a finding is a false positive, add a line to the PR body:")
            print("  no-prod-data: allow <short reason>")
        return 1

    print("no-prod-data: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())

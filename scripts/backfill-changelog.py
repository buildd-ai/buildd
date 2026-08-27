#!/usr/bin/env python3
"""
Backfill CHANGELOG.md: distribute [Unreleased] entries to the versioned sections
they actually shipped in, based on PR number → git tag mapping.

Usage: python3 scripts/backfill-changelog.py [--dry-run]
"""

import re
import subprocess
import sys
from collections import defaultdict

DRY_RUN = "--dry-run" in sys.argv

def git(*args):
    return subprocess.check_output(["git"] + list(args), text=True, stderr=subprocess.DEVNULL).strip()

def git_lines(*args):
    out = git(*args)
    return [l for l in out.split("\n") if l.strip()]


# ---------------------------------------------------------------------------
# 1. Build sorted tag list (v0.37.0 .. current)
# ---------------------------------------------------------------------------
all_tags = git_lines("tag", "--sort=v:refname", "--list", "v*")

def tag_tuple(t):
    parts = t.lstrip("v").split(".")
    try:
        return tuple(int(x) for x in parts)
    except ValueError:
        return (0, 0, 0)

tags_in_range = [t for t in all_tags if tag_tuple(t) >= (0, 37, 0)]
print(f"Tags in range (v0.37+): {len(tags_in_range)} ({tags_in_range[0]} .. {tags_in_range[-1]})")

# All tags (for pre-v0.37 history lookup too)
all_semver_tags = [t for t in all_tags if tag_tuple(t) >= (0, 1, 1)]


# ---------------------------------------------------------------------------
# 2. Build commit-SHA → earliest tag map (ALL tags, not just v0.37+)
# ---------------------------------------------------------------------------
print("Building commit→tag map... ", end="", flush=True)
commit_to_tag: dict[str, str] = {}

prev_tag = None
for tag in all_semver_tags:
    try:
        if prev_tag is None:
            shas = git_lines("log", tag, "--format=%H")
        else:
            shas = git_lines("log", f"{prev_tag}..{tag}", "--format=%H")
        for sha in shas:
            if sha not in commit_to_tag:
                commit_to_tag[sha] = tag
        prev_tag = tag
    except Exception:
        pass

print(f"{len(commit_to_tag)} commits mapped")


# ---------------------------------------------------------------------------
# 3. Build PR-number → tag map by searching commits for "(#NNN)"
# ---------------------------------------------------------------------------
print("Building PR→tag map... ", end="", flush=True)
pr_to_tag: dict[int, str] = {}

# Match both "(#NNN)" (squash merges) and "pull request #NNN" (merge commits)
pr_pattern = re.compile(r'\(#(\d+)\)')
pr_in_subject = re.compile(r'(?:\(#(\d+)\)|pull request #(\d+))', re.IGNORECASE)

# Grab ALL commit messages + shas (full history) in one call
log_lines = git_lines("log", "--format=%H %s")

for line in log_lines:
    parts = line.split(" ", 1)
    if len(parts) < 2:
        continue
    sha, subject = parts
    tag = commit_to_tag.get(sha)
    if not tag:
        continue
    for m in pr_in_subject.finditer(subject):
        pr_num = int(m.group(1) or m.group(2))
        if pr_num not in pr_to_tag:
            pr_to_tag[pr_num] = tag

print(f"{len(pr_to_tag)} PRs mapped")


# ---------------------------------------------------------------------------
# 4. Parse CHANGELOG.md
# ---------------------------------------------------------------------------
with open("CHANGELOG.md") as f:
    raw = f.read()

# Split on section headers — keep delimiters
parts = re.split(r"(^## \[[^\]]+\][^\n]*\n)", raw, flags=re.MULTILINE)
# parts[0] = text before first ##-section (the file header)
# parts[1::2] = headers; parts[2::2] = bodies

preamble = parts[0]

sections: list[tuple[str, str]] = []
for i in range(1, len(parts), 2):
    header = parts[i]
    body = parts[i + 1] if i + 1 < len(parts) else ""
    sections.append((header, body))


# ---------------------------------------------------------------------------
# 5. Extract [Unreleased] section
# ---------------------------------------------------------------------------
unreleased_idx = None
for i, (hdr, _) in enumerate(sections):
    if re.match(r"## \[Unreleased\]", hdr):
        unreleased_idx = i
        break

if unreleased_idx is None:
    print("No [Unreleased] section found — nothing to do.")
    sys.exit(0)

unreleased_body = sections[unreleased_idx][1]

# Check if there are any bullet entries
if not re.search(r"^- ", unreleased_body, re.MULTILINE):
    print("[Unreleased] has no entries — nothing to do.")
    sys.exit(0)


# ---------------------------------------------------------------------------
# 6. Classify each entry in [Unreleased]
# ---------------------------------------------------------------------------
# Parse the unreleased body into sub-sections (### Added, ### Fixed, etc.)
entry_lines = unreleased_body.split("\n")

# For each bullet line, determine which tag it belongs to
# We'll emit a dict: tag → {subsection → [lines]}

FALLBACK_TAG = tags_in_range[-1]  # assign unknown entries to latest release

# Build a date-sorted tag list with commit timestamps for date-based fallback
print("Building tag date index... ", end="", flush=True)
tag_date_map: list[tuple[str, str, str]] = []  # (tag, date_str, sha)
for tag in all_semver_tags:
    try:
        sha = git("rev-parse", tag)
        date = git("log", "-1", "--format=%ci", tag)
        tag_date_map.append((tag, date, sha))
    except Exception:
        pass
tag_date_map.sort(key=lambda x: x[1])
print(f"{len(tag_date_map)} tags")


def tag_for_commit_date(commit_date_str: str) -> str:
    """Return the earliest tag whose date is >= the commit date."""
    for tag, tag_date, _ in tag_date_map:
        if tag_tuple(tag) >= (0, 37, 0) and tag_date >= commit_date_str:
            return tag
    return FALLBACK_TAG


# Build a map from PR number → commit date (from --all history, including orphans)
print("Building PR→commit-date map from orphaned commits... ", end="", flush=True)
pr_to_date: dict[int, str] = {}
all_commit_log = git_lines("log", "--all", "--format=%H %ai %s")
for line in all_commit_log:
    parts = line.split(" ", 2)
    if len(parts) < 3:
        continue
    sha, date_str, subject = parts
    for m in pr_in_subject.finditer(subject):
        pr_num = int(m.group(1) or m.group(2))
        if pr_num not in pr_to_date:
            pr_to_date[pr_num] = date_str
print(f"{len(pr_to_date)} PRs with dates")

tag_entries: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
current_subsection = "Other"
unmatched_lines: list[str] = []

for line in entry_lines:
    sub_match = re.match(r"^### (.+)", line)
    if sub_match:
        current_subsection = sub_match.group(1)
        continue
    if not line.startswith("- "):
        # blank/non-entry line — skip (we'll reconstruct)
        continue

    # Extract all PR numbers from entry (handles comma-separated like "#1657, #1659, #1664")
    entry_prs = [int(m) for m in re.findall(r'#(\d+)', line)]
    tag = None

    # First: try direct git ancestry lookup (most accurate)
    for pr_num in entry_prs:
        if pr_num in pr_to_tag:
            tag = pr_to_tag[pr_num]
            break

    # Fallback: use commit date of any referenced PR to find next tag
    if tag is None:
        best_date = None
        for pr_num in entry_prs:
            if pr_num in pr_to_date:
                d = pr_to_date[pr_num]
                if best_date is None or d < best_date:
                    best_date = d
        if best_date:
            tag = tag_for_commit_date(best_date)

    if tag is None:
        tag = FALLBACK_TAG
        unmatched_lines.append(line)

    tag_entries[tag][current_subsection].append(line)

if unmatched_lines:
    print(f"  {len(unmatched_lines)} entries could not be matched to a PR/commit; assigned to {FALLBACK_TAG}:")
    for l in unmatched_lines[:5]:
        print(f"    {l[:80]}")
    if len(unmatched_lines) > 5:
        print(f"    ... and {len(unmatched_lines)-5} more")


# ---------------------------------------------------------------------------
# 7. Get tag dates
# ---------------------------------------------------------------------------
tag_dates: dict[str, str] = {}
for tag in tag_entries:
    try:
        date = git("log", "-1", "--format=%ai", tag)
        tag_dates[tag] = date[:10]
    except Exception:
        tag_dates[tag] = "2026-01-01"


# ---------------------------------------------------------------------------
# 8. Build versioned sections to INSERT after [Unreleased]
# ---------------------------------------------------------------------------
def build_section(tag: str, sub_entries: dict[str, list[str]]) -> str:
    date = tag_dates.get(tag, "")
    lines = [f"## [{tag.lstrip('v')}] - {date}", ""]
    for subsection, entries in sub_entries.items():
        if entries:
            lines.append(f"### {subsection}")
            lines.append("")
            lines.extend(entries)
            lines.append("")
    return "\n".join(lines)


# Sort tags in reverse order (newest first in the file, per Keep a Changelog convention)
sorted_new_tags = sorted(tag_entries.keys(), key=tag_tuple, reverse=True)

new_sections_text = ""
for tag in sorted_new_tags:
    new_sections_text += build_section(tag, tag_entries[tag])


# ---------------------------------------------------------------------------
# 9. Build updated footer links
# ---------------------------------------------------------------------------
# Collect existing footer lines
footer_match = re.search(r"(\n\[Unreleased\]:.*)", raw, re.DOTALL)
existing_footer = footer_match.group(1) if footer_match else ""

# Extract existing link map
existing_links: dict[str, str] = {}
for m in re.finditer(r"^\[([^\]]+)\]: (https?://\S+)", existing_footer, re.MULTILINE):
    existing_links[m.group(1)] = m.group(2)

repo = "buildd-ai/buildd"
latest_tag = tags_in_range[-1]
new_unreleased_url = f"https://github.com/{repo}/compare/{latest_tag}...HEAD"

# Build complete sorted link list
all_link_tags = sorted(
    set(list(existing_links.keys()) + [t.lstrip("v") for t in tags_in_range]),
    key=lambda x: tag_tuple(f"v{x}") if x[0].isdigit() else (0, 0, 0),
    reverse=True,
)

# Build tag→compare URL map
all_versions_sorted = sorted(
    [t for t in all_tags if tag_tuple(t) >= (0, 1, 1)],
    key=tag_tuple,
)

compare_links: dict[str, str] = {}
for i, tag in enumerate(all_versions_sorted):
    ver = tag.lstrip("v")
    if i == 0:
        compare_links[ver] = f"https://github.com/{repo}/releases/tag/{tag}"
    else:
        prev = all_versions_sorted[i - 1]
        compare_links[ver] = f"https://github.com/{repo}/compare/{prev}...{tag}"

footer_lines = [f"[Unreleased]: {new_unreleased_url}"]
for ver in all_link_tags:
    if ver == "Unreleased":
        continue
    url = compare_links.get(ver) or existing_links.get(ver, "")
    if url:
        footer_lines.append(f"[{ver}]: {url}")

new_footer = "\n" + "\n".join(footer_lines) + "\n"


# ---------------------------------------------------------------------------
# 10. Reconstruct CHANGELOG
# ---------------------------------------------------------------------------
# New structure: preamble + [Unreleased] (now empty) + new versioned sections + old sections + footer

unreleased_hdr = sections[unreleased_idx][0]
# Keep [Unreleased] as empty (no entries)
new_unreleased = unreleased_hdr + "\n"

old_sections_text = ""
for i, (hdr, body) in enumerate(sections):
    if i == unreleased_idx:
        continue  # replaced above
    # Strip footer links from body (we rebuild them)
    body_stripped = re.sub(r"\n\[.*\n?", "", body)
    old_sections_text += hdr + body_stripped

# Remove trailing footer from old sections (it may be embedded in the last section body)
old_sections_text = re.sub(r"\n\[Unreleased\]:.*", "", old_sections_text, flags=re.DOTALL)

new_content = preamble + new_unreleased + "\n" + new_sections_text + old_sections_text.rstrip() + "\n" + new_footer

if DRY_RUN:
    print("\n--- DRY RUN: first 100 lines of new CHANGELOG ---")
    for line in new_content.split("\n")[:100]:
        print(line)
    print("...")
    print(f"\nTotal new CHANGELOG: {len(new_content.split(chr(10)))} lines")
else:
    with open("CHANGELOG.md", "w") as f:
        f.write(new_content)
    print(f"\nCHANGELOG.md rewritten: {len(new_content.split(chr(10)))} lines")
    print(f"Added {len(sorted_new_tags)} versioned sections: {sorted_new_tags[0]} .. {sorted_new_tags[-1]}")

print("Done.")

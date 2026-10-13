#!/bin/bash
set -euo pipefail

# Bring main into dev by hand — the same reconciliation sync-dev.yml runs after
# every merge to main. This used to `reset --hard origin/main` and force-push
# dev, which deleted anything that landed on dev after the release was cut. It
# now merges, so commits on both sides survive, and it never force-pushes.

git fetch origin
git checkout dev
git merge --ff-only origin/dev

if git merge-base --is-ancestor origin/main HEAD; then
  echo "✅ dev already contains main"
  exit 0
fi

if ! git merge --no-edit origin/main; then
  echo "❌ main and dev conflict. Resolve the conflicts, commit, then: git push origin dev"
  echo "   (for CHANGELOG.md: bun scripts/release-candidate.ts reconcile-changelog --base <merge-base copy> --ours <dev copy> --theirs <main copy>)"
  exit 1
fi
git push origin dev
echo "✅ main merged into dev"

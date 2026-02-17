#!/bin/bash
set -e

# After a PR is squash-merged into main, reset dev to match main.
# All PR commits are already in main (squashed), so dev just needs to catch up.

git checkout dev
git fetch origin
git reset --hard origin/main
git push --force origin dev

echo "✅ dev is now in sync with main"

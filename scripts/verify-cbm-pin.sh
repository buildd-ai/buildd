#!/usr/bin/env bash
#
# Verify the pinned codebase-memory-mcp checksums against the upstream release.
#
# The unit test (apps/runner/__tests__/unit/cbm-version-pin.test.ts) can only
# check that the Dockerfile and install.sh agree with each other — it has no
# network, so a hash that matches nothing upstream passes it. Mutation testing
# confirmed the gap: flipping a darwin hash left the suite green. This script
# closes it by diffing all six pinned values against the release's checksums.txt.
#
# Usage: bash scripts/verify-cbm-pin.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="$REPO_ROOT/docker/worker/Dockerfile"
INSTALL_SH="$REPO_ROOT/apps/runner/install.sh"

version_from() { grep -m1 -E "$2" "$1" | sed -E "s/$2//" | tr -d '"'; }

DOCKER_VERSION=$(grep -m1 -E '^ARG CBM_VERSION=' "$DOCKERFILE" | cut -d= -f2)
INSTALL_VERSION=$(grep -m1 -E '^[[:space:]]*CBM_VERSION=' "$INSTALL_SH" | cut -d= -f2 | tr -d '"')

if [ "$DOCKER_VERSION" != "$INSTALL_VERSION" ]; then
  echo "FAIL: version drift — Dockerfile=$DOCKER_VERSION install.sh=$INSTALL_VERSION" >&2
  exit 1
fi
echo "pinned version: v$DOCKER_VERSION"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://github.com/DeusData/codebase-memory-mcp/releases/download/v${DOCKER_VERSION}/checksums.txt" \
  -o "$TMP/checksums.txt"

fail=0
check() { # <pinned-sha> <asset-name> <where>
  local pinned="$1" asset="$2" where="$3" upstream
  upstream=$(awk -v a="$asset" '$2 == a { print $1 }' "$TMP/checksums.txt" | head -1)
  if [ -z "$upstream" ]; then
    echo "FAIL: $asset not published in v$DOCKER_VERSION ($where)" >&2; fail=1; return
  fi
  if [ "$pinned" != "$upstream" ]; then
    echo "FAIL: $asset ($where) pinned $pinned != upstream $upstream" >&2; fail=1; return
  fi
  echo "  ok  $where  $asset"
}

for arch in AMD64 ARM64; do
  lower=$(echo "$arch" | tr '[:upper:]' '[:lower:]')
  check "$(grep -m1 "^ARG CBM_SHA256_${arch}=" "$DOCKERFILE" | cut -d= -f2)" \
        "codebase-memory-mcp-linux-${lower}.tar.gz" "Dockerfile"
done

for plat in LINUX_AMD64 LINUX_ARM64 DARWIN_AMD64 DARWIN_ARM64; do
  lower=$(echo "$plat" | tr '[:upper:]_' '[:lower:]-')
  check "$(grep -m1 -E "^[[:space:]]*CBM_SHA256_${plat}=" "$INSTALL_SH" | cut -d= -f2 | tr -d '"')" \
        "codebase-memory-mcp-${lower}.tar.gz" "install.sh"
done

[ "$fail" -eq 0 ] && echo "all pinned CBM checksums match upstream v$DOCKER_VERSION"
exit "$fail"

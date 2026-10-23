#!/usr/bin/env bash
# apt-get install in a CI ubuntu container, from the first Ubuntu mirror that answers.
#
#   apt-install.sh <package> [<package>...]
#
# The container's sources point at archive.ubuntu.com. When that host is
# unreachable from the runner (it was on 2026-10-22 and turned dev red), plain
# `apt-get update` only warns and exits 0, and the install then fails with
# "has no installation candidate". So update runs with --error-on=any, and on
# failure every URIs: line in the deb822 sources is pointed at the next mirror
# and the update + install retried in the same round. Up to APT_ATTEMPTS
# (default 3) rounds, sleeping APT_BACKOFF_SECONDS * round (default 15) between.
#
# Mirrors, in order:
#   1. archive.ubuntu.com        what the image ships with
#   2. azure.archive.ubuntu.com  the mirror GitHub's own runner VMs use
#
# APT_GET and APT_SOURCES override the binary and the sources file (tests use fakes).
set -uo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <package> [<package>...]" >&2
  exit 2
fi

APT_GET="${APT_GET:-apt-get}"
SOURCES="${APT_SOURCES:-/etc/apt/sources.list.d/ubuntu.sources}"
ATTEMPTS="${APT_ATTEMPTS:-3}"
BACKOFF="${APT_BACKOFF_SECONDS:-15}"
MIRRORS="http://archive.ubuntu.com/ubuntu http://azure.archive.ubuntu.com/ubuntu"

if [ ! -f "$SOURCES" ]; then
  echo "::error::no apt sources at $SOURCES"
  exit 2
fi

for attempt in $(seq 1 "$ATTEMPTS"); do
  for mirror in $MIRRORS; do
    sed -i -E "s#^URIs:.*#URIs: $mirror#" "$SOURCES"
    if "$APT_GET" -o Acquire::Retries=3 update -qq --error-on=any \
      && DEBIAN_FRONTEND=noninteractive "$APT_GET" -o Acquire::Retries=3 install -y -qq "$@" >/dev/null; then
      echo "Installed $* from $mirror (round $attempt)"
      exit 0
    fi
    echo "::warning::apt-get via $mirror failed (round $attempt/$ATTEMPTS); trying the next mirror"
  done
  if [ "$attempt" -lt "$ATTEMPTS" ]; then sleep $((BACKOFF * attempt)); fi
done

echo "::error::every mirror failed $ATTEMPTS/$ATTEMPTS times: $MIRRORS"
exit 1

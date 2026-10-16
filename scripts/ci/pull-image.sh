#!/usr/bin/env bash
# Pull a CI image from the first registry that answers, and tag it locally.
#
#   pull-image.sh <local-tag> <candidate-ref> [<candidate-ref>...]
#
# Candidates are tried in order on every attempt, so a rate-limited registry
# falls through to the next one immediately instead of burning the retry
# budget. Up to PULL_ATTEMPTS (default 5) rounds, sleeping
# PULL_BACKOFF_SECONDS * round (default 15) between rounds. The winning image is
# tagged <local-tag> so later steps never need to know which registry served it.
#
# Order used by the workflows (see .github/workflows/mirror-ci-images.yml):
#   1. ghcr.io/buildd-ai/ci-mirror/*  our own mirror, pulled with GITHUB_TOKEN
#   2. public.ecr.aws/docker/library/* ECR Public (its anonymous data limit is
#      what failed CI on 2026-10-14/15)
#   3. docker.io/library/*            Docker Hub (anonymous pull limit)
#
# DOCKER overrides the docker binary (tests use a fake).
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <local-tag> <candidate-ref> [<candidate-ref>...]" >&2
  exit 2
fi

DOCKER="${DOCKER:-docker}"
ATTEMPTS="${PULL_ATTEMPTS:-5}"
BACKOFF="${PULL_BACKOFF_SECONDS:-15}"
LOCAL_TAG="$1"
shift

for attempt in $(seq 1 "$ATTEMPTS"); do
  for ref in "$@"; do
    if "$DOCKER" pull "$ref"; then
      "$DOCKER" tag "$ref" "$LOCAL_TAG" || { echo "::error::docker tag $ref $LOCAL_TAG failed"; exit 1; }
      echo "Pulled $ref (round $attempt) as $LOCAL_TAG"
      if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "source=$ref" >> "$GITHUB_OUTPUT"; fi
      exit 0
    fi
    echo "::warning::docker pull $ref failed (round $attempt/$ATTEMPTS); trying the next source"
  done
  if [ "$attempt" -lt "$ATTEMPTS" ]; then sleep $((BACKOFF * attempt)); fi
done

echo "::error::every source failed $ATTEMPTS/$ATTEMPTS times: $*"
exit 1

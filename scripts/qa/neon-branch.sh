#!/usr/bin/env bash
#
# neon-branch.sh — a disposable copy-on-write Neon branch for local visual review.
#
# The local recipe in .claude/skills/visual-review needs a DATABASE_URL that is
# NOT production. This makes one: a branch off the production branch (real data,
# isolated writes), with an expiry so a forgotten branch removes itself, and its
# connection string written to a 0600 env file. Nothing is ever printed but the
# file path.
#
# Usage:
#   scripts/qa/neon-branch.sh create [--ttl-hours N] [--migrate]   # prints the env file path
#   scripts/qa/neon-branch.sh delete <branch-name>
#   scripts/qa/neon-branch.sh list                                  # qa/local-* branches
#   scripts/qa/neon-branch.sh sweep                                 # delete expired qa/local-* branches
#
# With shoot.sh:  QA_NEON_BRANCH=1 scripts/qa/shoot.sh /app/home   (creates, captures, deletes)
#
# Auth: neonctl's own login (`npx neonctl@latest auth`); no API key on disk.
# Env (all optional):
#   NEON_QA_ORG_ID       org to use when the login sees more than one
#   NEON_QA_PROJECT_ID   project id (default: the project named $NEON_QA_PROJECT_NAME)
#   NEON_QA_PROJECT_NAME default "buildd"
#   NEON_QA_PARENT       parent branch (default "production")
#   NEON_QA_ROLE         role for the connection string (default "neondb_owner")
#   NEON_QA_TTL_HOURS    expiry (default 3)
#   NEONCTL              command to run neonctl (default "npx -y neonctl@latest")
#   QA_ENV_DIR           where env files go (default ~/.cache/buildd-qa)
#
# --migrate runs `bun db:migrate` against the branch, for a code branch whose
# migrations are not in production yet. It only ever touches the new branch.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NEONCTL="${NEONCTL:-npx -y neonctl@latest}"
PROJECT_NAME="${NEON_QA_PROJECT_NAME:-buildd}"
PARENT="${NEON_QA_PARENT:-production}"
ROLE="${NEON_QA_ROLE:-neondb_owner}"
TTL_HOURS="${NEON_QA_TTL_HOURS:-3}"
ENV_DIR="${QA_ENV_DIR:-$HOME/.cache/buildd-qa}"
PREFIX="qa/local-"

die() { echo "[neon-branch] $*" >&2; exit 1; }
log() { echo "[neon-branch] $*" >&2; }
neon() { $NEONCTL "$@"; }
# neonctl prints a bare array for list commands (older versions wrapped it).
items() { jq "if type == \"array\" then . else (.$1 // []) end"; }

org_args() {
  if [ -n "${NEON_QA_ORG_ID:-}" ]; then echo "--org-id $NEON_QA_ORG_ID"; return; fi
  local orgs n
  orgs="$(neon orgs list --output json 2>/dev/null)" || die "neonctl is not logged in. Run: npx neonctl@latest auth"
  n="$(echo "$orgs" | items organizations | jq 'length')"
  if [ "$n" = "1" ]; then echo "--org-id $(echo "$orgs" | items organizations | jq -r '.[0].id')"; return; fi
  [ "$n" = "0" ] && { echo ""; return; }
  die "the login sees $n orgs; set NEON_QA_ORG_ID"
}

project_id() {
  if [ -n "${NEON_QA_PROJECT_ID:-}" ]; then echo "$NEON_QA_PROJECT_ID"; return; fi
  local id orgs
  orgs="$(org_args)" || exit 1
  # shellcheck disable=SC2086
  id="$(neon projects list $orgs --output json | items projects | jq -r --arg n "$PROJECT_NAME" '.[] | select(.name == $n) | .id' | head -1)"
  [ -n "$id" ] || die "no Neon project named \"$PROJECT_NAME\"; set NEON_QA_PROJECT_ID"
  echo "$id"
}

expires_at() {
  date -u -v+"${TTL_HOURS}"H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+${TTL_HOURS} hours" +%Y-%m-%dT%H:%M:%SZ
}

env_file_for() { echo "$ENV_DIR/$(echo "$1" | tr '/' '_').env"; }

cmd_create() {
  local migrate=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --ttl-hours) TTL_HOURS="$2"; shift 2 ;;
      --migrate) migrate=1; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  command -v jq >/dev/null || die "jq is required"
  local pid name file url
  pid="$(project_id)" || exit 1
  name="${PREFIX}$(id -un | tr -cd 'a-zA-Z0-9' | cut -c1-12 | tr 'A-Z' 'a-z')-$(date +%m%d-%H%M%S)"
  log "creating $name off $PARENT (expires in ${TTL_HOURS}h)…"
  neon branches create --project-id "$pid" --name "$name" --parent "$PARENT" \
    --expires-at "$(expires_at)" --no-secrets --output json >/dev/null \
    || die "branch create failed"
  url="$(neon connection-string "$name" --project-id "$pid" --role-name "$ROLE" --pooled 2>/dev/null)" \
    || { neon branches delete "$name" --project-id "$pid" >/dev/null 2>&1 || true; die "could not read a connection string for role $ROLE"; }
  [ -n "$url" ] || die "empty connection string"
  mkdir -p "$ENV_DIR"; chmod 700 "$ENV_DIR"
  file="$(env_file_for "$name")"
  case "$url" in *"'"*) die "connection string contains a single quote; refusing to write it" ;; esac
  # Single-quoted: the URL's query string has '&', which would background the assignment when sourced.
  ( umask 077; printf "DATABASE_URL='%s'\nQA_NEON_BRANCH_NAME='%s'\nQA_NEON_PROJECT_ID='%s'\n" "$url" "$name" "$pid" > "$file" )
  if [ "$migrate" = "1" ]; then
    log "applying this checkout's migrations to ${name}…"
    # shellcheck source=/dev/null
    ( set -a; . "$file"; set +a; cd "$ROOT/packages/core" && bun db:migrate >/dev/null ) || die "migrate failed (branch kept: $name)"
  fi
  log "ready: $name"
  echo "$file"
}

cmd_delete() {
  local name="${1:-}" pid
  [ -n "$name" ] || die "usage: delete <branch-name>"
  case "$name" in "$PREFIX"*) ;; *) die "refusing to delete \"$name\": only ${PREFIX}* branches" ;; esac
  pid="${QA_NEON_PROJECT_ID:-}"; [ -n "$pid" ] || pid="$(project_id)" || exit 1
  neon branches delete "$name" --project-id "$pid" >/dev/null && log "deleted $name"
  rm -f "$(env_file_for "$name")"
}

cmd_list() {
  local pid; pid="$(project_id)" || exit 1
  neon branches list --project-id "$pid" --output json | items branches \
    | jq -r --arg p "$PREFIX" '.[] | select(.name | startswith($p)) | "\(.name)\t\(.created_at)\texpires \(.expires_at // "never")"'
}

cmd_sweep() {
  local pid now; pid="$(project_id)" || exit 1; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  neon branches list --project-id "$pid" --output json | items branches \
    | jq -r --arg p "$PREFIX" --arg now "$now" '.[] | select(.name | startswith($p)) | select((.expires_at // "9999") < $now) | .name' \
    | while read -r n; do [ -n "$n" ] && QA_NEON_PROJECT_ID="$pid" cmd_delete "$n"; done
}

case "${1:-}" in
  create) shift; cmd_create "$@" ;;
  delete) shift; cmd_delete "$@" ;;
  list) cmd_list ;;
  sweep) cmd_sweep ;;
  *) sed -n '2,32p' "$0" >&2; exit 2 ;;
esac

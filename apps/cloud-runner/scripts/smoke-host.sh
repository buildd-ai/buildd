# Sourced by the local smokes. Prints a host address that both this host
# (where `wrangler dev` runs the Worker) and the task containers (on local
# Docker) can reach, so BUILDD_SERVER works from both sides. Docker Desktop's
# host.docker.internal resolves only inside containers, so it does not.
#
# SMOKE_HOST_ADDR wins when set. Otherwise: the host's primary address (the
# source address of its default route). Prints nothing if none is found.
smoke_host_addr() {
  if [ -n "${SMOKE_HOST_ADDR:-}" ]; then echo "$SMOKE_HOST_ADDR"; return; fi
  local addr="" iface
  if command -v ipconfig >/dev/null 2>&1 && command -v route >/dev/null 2>&1 && [ "$(uname -s)" = Darwin ]; then
    iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
    for i in $iface en0 en1; do
      addr="$(ipconfig getifaddr "$i" 2>/dev/null || true)"
      [ -n "$addr" ] && break
    done
  fi
  if [ -z "$addr" ] && command -v ip >/dev/null 2>&1; then
    addr="$(ip -4 route get 1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
  fi
  if [ -z "$addr" ] && hostname -I >/dev/null 2>&1; then
    addr="$(hostname -I | awk '{print $1}')"
  fi
  echo "$addr"
}

# Fails the smoke (exit 2) unless this host reaches the fake buildd at
# $1:$2 within a few seconds. The fake must already be listening.
require_host_reachable() { # addr port
  local k
  for ((k = 0; k < 20; k++)); do
    curl -s -o /dev/null --max-time 2 "http://$1:$2/" && return 0
    sleep 0.5
  done
  echo "   this host cannot reach the fake buildd at $1:$2. Set SMOKE_HOST_ADDR to an address both"
  echo "   this host and the containers reach (the host's LAN address on Docker Desktop)."
  exit 2
}

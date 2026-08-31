FROM codercom/enterprise-base:ubuntu

# Pin codebase-memory-mcp — bump these three ARGs together to upgrade.
# CBM_VERSION and both SHA256 values must be updated together on each version bump,
# and apps/runner/install.sh must be bumped in the same commit: it provisions the
# binary on existing Coder workspaces, which is the only surface that actually gets
# updated today (this image is built in CI but never pushed). The pin-parity test
# (apps/runner/__tests__/unit/cbm-version-pin.test.ts) fails if they drift.
# Checksums come from the release's checksums.txt.
ARG CBM_VERSION=0.10.8
ARG CBM_SHA256_AMD64=e5cba4cad6ca8254a85f45041fc8a831908d7d5cb64f98fc3f8eb70a58671793
ARG CBM_SHA256_ARM64=e2804a20f5a6fc392af361525a232703e351b7d1aacb81b88eef806eec5959fa

# TARGETARCH is injected automatically by BuildKit (docker buildx build --platform).
# Default to amd64 for plain `docker build` invocations.
ARG TARGETARCH=amd64

# The base image runs as uid 1000 (coder), which cannot write /opt — this layer
# failed with `mkdir: Permission denied` on every arch (the build-check workflow
# had never actually run, so nothing caught it). Drop back to coder afterwards so
# the image keeps the user Coder templates expect.
USER root

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) CBM_SHA256="${CBM_SHA256_AMD64}" ;; \
      arm64) CBM_SHA256="${CBM_SHA256_ARM64}" ;; \
      *)     echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/buildd/bin; \
    curl -fsSL \
      "https://github.com/DeusData/codebase-memory-mcp/releases/download/v${CBM_VERSION}/codebase-memory-mcp-linux-${TARGETARCH}.tar.gz" \
      -o /tmp/cbm.tar.gz; \
    echo "${CBM_SHA256}  /tmp/cbm.tar.gz" | sha256sum -c; \
    tar -xzf /tmp/cbm.tar.gz -C /opt/buildd/bin codebase-memory-mcp; \
    chmod +x /opt/buildd/bin/codebase-memory-mcp; \
    rm /tmp/cbm.tar.gz; \
    /opt/buildd/bin/codebase-memory-mcp --version

USER coder

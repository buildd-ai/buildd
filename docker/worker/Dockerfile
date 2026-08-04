FROM codercom/enterprise-base:ubuntu

# Pin codebase-memory-mcp — bump these two ARGs (and the arm64 counterpart) to upgrade.
# CBM_VERSION and both SHA256 values must be updated together on each version bump.
ARG CBM_VERSION=0.9.0
ARG CBM_SHA256_AMD64=e2832a8d207c26beaa30efa6222ed4a37cb3f526ca4bee060bfbf336ed6fc679
ARG CBM_SHA256_ARM64=68a345d9a6842f02a3cb07e187b28bc38c4f3a22967f47fadbcd0757ba93a680

# TARGETARCH is injected automatically by BuildKit (docker buildx build --platform).
# Default to amd64 for plain `docker build` invocations.
ARG TARGETARCH=amd64

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

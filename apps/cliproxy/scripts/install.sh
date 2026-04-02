#!/bin/bash
# Install CLIProxyAPI binary + default config
# Binary is bundled in the release zip under bin/{arch}/cli-proxy-api
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.cliproxy"

mkdir -p "${APP_DIR}/bin" "${APP_DIR}/auths"

if [ -x "${APP_DIR}/bin/cli-proxy-api" ]; then
  echo "CLIProxyAPI already installed"
else
  # Use bundled binary (included in release zip by GitHub Action)
  ARCH=$(uname -m)
  [ "$ARCH" = "aarch64" ] && ARCH="arm64" || ARCH="amd64"

  if [ -x "${APP_DIR}/bin/${ARCH}/cli-proxy-api" ]; then
    mv "${APP_DIR}/bin/${ARCH}/cli-proxy-api" "${APP_DIR}/bin/cli-proxy-api"
    rm -rf "${APP_DIR}/bin/amd64" "${APP_DIR}/bin/arm64"
    chmod +x "${APP_DIR}/bin/cli-proxy-api"
    VERSION=$("${APP_DIR}/bin/cli-proxy-api" --help 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
    echo "Installed CLIProxyAPI ${VERSION} (bundled)"
  else
    # Fallback: download from GitHub (for dev/manual installs without bundled binary)
    echo "No bundled binary found, downloading from GitHub..."
    FALLBACK_VERSION="6.9.2"
    CURL_ARGS=(-sL)
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      CURL_ARGS+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
    fi
    TAG=$(curl "${CURL_ARGS[@]}" https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest | jq -r '.tag_name // empty')
    if [ -z "$TAG" ]; then
      TAG="v${FALLBACK_VERSION}"
    fi
    VERSION=${TAG#v}
    echo "Downloading CLIProxyAPI v${VERSION} (${ARCH})..."
    curl -sfL "https://github.com/router-for-me/CLIProxyAPI/releases/download/${TAG}/CLIProxyAPI_${VERSION}_linux_${ARCH}.tar.gz" \
      -o /tmp/cliproxy.tar.gz
    tar -xzf /tmp/cliproxy.tar.gz -C "${APP_DIR}/bin" cli-proxy-api
    chmod +x "${APP_DIR}/bin/cli-proxy-api"
    rm -f /tmp/cliproxy.tar.gz
    echo "Installed CLIProxyAPI ${VERSION}"
  fi
fi

if [ ! -f "${APP_DIR}/config.yaml" ]; then
  cat > "${APP_DIR}/config.yaml" << 'EOF'
host: "0.0.0.0"
port: 4001
auth-dir: "auths"
api-keys:
  - "local-only"
EOF
  echo "Created default config.yaml"
fi

echo "Done. Run: ~/apps/com.xshopper.cliproxy/scripts/start.sh"

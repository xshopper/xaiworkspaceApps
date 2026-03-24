#!/bin/bash
# Install CLIProxyAPI binary + default config
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.cliproxy"
FALLBACK_VERSION="6.9.1"

mkdir -p "${APP_DIR}/bin" "${APP_DIR}/auths"

if [ -x "${APP_DIR}/bin/cli-proxy-api" ]; then
  echo "CLIProxyAPI already installed"
else
  echo "Downloading CLIProxyAPI..."
  ARCH=$(uname -m)
  [ "$ARCH" = "aarch64" ] && ARCH="arm64" || ARCH="amd64"

  # Use GitHub token if available (avoids rate limits)
  AUTH_HEADER=""
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    AUTH_HEADER="-H \"Authorization: Bearer ${GITHUB_TOKEN}\""
  fi

  # Get latest version from GitHub API (with auth if available)
  TAG=$(eval curl -sL ${AUTH_HEADER} https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest | jq -r '.tag_name // empty')
  if [ -z "$TAG" ]; then
    echo "GitHub API unavailable, using fallback version v${FALLBACK_VERSION}"
    TAG="v${FALLBACK_VERSION}"
  fi
  VERSION=${TAG#v}

  echo "Installing CLIProxyAPI v${VERSION} (${ARCH})..."
  curl -sfL "https://github.com/router-for-me/CLIProxyAPI/releases/download/${TAG}/CLIProxyAPI_${VERSION}_linux_${ARCH}.tar.gz" \
    -o /tmp/cliproxy.tar.gz
  tar -xzf /tmp/cliproxy.tar.gz -C "${APP_DIR}/bin" cli-proxy-api
  chmod +x "${APP_DIR}/bin/cli-proxy-api"
  rm -f /tmp/cliproxy.tar.gz
  echo "Installed CLIProxyAPI ${VERSION}"
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

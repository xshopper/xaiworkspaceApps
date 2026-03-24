#!/bin/bash
# Install CLIProxyAPI binary + default config
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.cliproxy"

mkdir -p "${APP_DIR}/bin" "${APP_DIR}/auths"

if [ -x "${APP_DIR}/bin/cli-proxy-api" ]; then
  echo "CLIProxyAPI already installed"
else
  echo "Downloading CLIProxyAPI..."
  ARCH=$(uname -m)
  [ "$ARCH" = "aarch64" ] && ARCH="arm64" || ARCH="amd64"
  TAG=$(curl -sL https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest | jq -r '.tag_name')
  VERSION=${TAG#v}
  curl -sL "https://github.com/router-for-me/CLIProxyAPI/releases/download/${TAG}/CLIProxyAPI_${VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xzf - -C "${APP_DIR}/bin" cli-proxy-api
  chmod +x "${APP_DIR}/bin/cli-proxy-api"
  echo "Installed CLIProxyAPI ${VERSION}"
fi

if [ ! -f "${APP_DIR}/config.yaml" ]; then
  cat > "${APP_DIR}/config.yaml" << 'EOF'
host: "127.0.0.1"
port: 4001
auth-dir: "auths"
api-keys:
  - "local-only"
EOF
  echo "Created default config.yaml"
fi

echo "Done. Run: ~/apps/com.xshopper.cliproxy/scripts/start.sh"

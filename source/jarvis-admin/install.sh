#!/bin/sh
set -e

# Jarvis Admin Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/alexberardi/jarvis-admin/main/install.sh | sh

REPO="alexberardi/jarvis-admin"
INSTALL_DIR="$HOME/.jarvis/bin"
BINARY_NAME="jarvis-admin"
SERVICE_NAME="jarvis-admin"

# Colors (if terminal supports them)
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info() { printf "${BLUE}>${NC} %s\n" "$1"; }
success() { printf "${GREEN}>${NC} %s\n" "$1"; }
error() { printf "${RED}>${NC} %s\n" "$1" >&2; exit 1; }

# Detect platform
detect_platform() {
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)

  case "$OS" in
    darwin) OS="darwin" ;;
    linux)  OS="linux" ;;
    *)      error "Unsupported OS: $OS" ;;
  esac

  case "$ARCH" in
    x86_64|amd64)  ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)             error "Unsupported architecture: $ARCH" ;;
  esac

  BINARY="jarvis-admin-${OS}-${ARCH}"
  info "Detected platform: ${OS}-${ARCH}"

  # Detect TrueNAS SCALE
  IS_TRUENAS=false
  if [ -d "/usr/share/truenas" ]; then
    IS_TRUENAS=true
    info "Detected TrueNAS SCALE"
  elif [ -f "/etc/version" ] && grep -qi truenas /etc/version 2>/dev/null; then
    IS_TRUENAS=true
    info "Detected TrueNAS SCALE"
  fi
}

# Get latest release tag
get_latest_version() {
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

  if [ -z "$VERSION" ]; then
    error "Could not determine latest version. Check https://github.com/${REPO}/releases"
  fi
  info "Latest version: ${VERSION}"
}

# Check prerequisites
check_prereqs() {
  if ! command -v docker >/dev/null 2>&1; then
    printf "${BOLD}Warning:${NC} Docker not found. Jarvis requires Docker to run services.\n"
    printf "  Install: https://docs.docker.com/get-docker/\n\n"
  fi

  if ! command -v curl >/dev/null 2>&1; then
    error "curl is required but not installed"
  fi
}

# Download and install
install_binary() {
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY}"

  info "Downloading ${BINARY}..."
  mkdir -p "$INSTALL_DIR"

  if ! curl -fsSL "$DOWNLOAD_URL" -o "${INSTALL_DIR}/${BINARY_NAME}"; then
    error "Download failed. Check if release exists: https://github.com/${REPO}/releases/tag/${VERSION}"
  fi

  chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
  success "Installed binary to ${INSTALL_DIR}/${BINARY_NAME}"

  # Download frontend assets
  PUBLIC_URL="https://github.com/${REPO}/releases/download/${VERSION}/public.tar.gz"
  info "Downloading frontend assets..."
  if curl -fsSL "$PUBLIC_URL" | tar xz -C "$INSTALL_DIR"; then
    success "Frontend assets installed to ${INSTALL_DIR}/public/"
  else
    error "Failed to download frontend assets"
  fi
}

# Write installed version to admin.json for upgrade detection
write_version() {
  CONFIG_DIR="$HOME/.jarvis"
  CONFIG_FILE="$CONFIG_DIR/admin.json"
  SEMVER="${VERSION#v}"
  mkdir -p "$CONFIG_DIR"

  if [ -f "$CONFIG_FILE" ]; then
    # Merge installedVersion into existing config (preserve other keys)
    EXISTING=$(cat "$CONFIG_FILE")
    echo "$EXISTING" | sed "s/}$/,\"installedVersion\":\"${SEMVER}\"}/" | \
      sed 's/,\+/,/g' | sed 's/{,/{/g' > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
  else
    echo "{\"installedVersion\":\"${SEMVER}\"}" > "$CONFIG_FILE"
  fi
}

# Add to PATH if needed
setup_path() {
  if echo "$PATH" | grep -q "$INSTALL_DIR"; then
    return
  fi

  SHELL_NAME=$(basename "$SHELL")
  case "$SHELL_NAME" in
    zsh)  RC_FILE="$HOME/.zshrc" ;;
    bash) RC_FILE="$HOME/.bashrc" ;;
    *)    RC_FILE="" ;;
  esac

  if [ -n "$RC_FILE" ]; then
    if ! grep -q ".jarvis/bin" "$RC_FILE" 2>/dev/null; then
      printf '\n# Jarvis\nexport PATH="$HOME/.jarvis/bin:$PATH"\n' >> "$RC_FILE"
      info "Added ${INSTALL_DIR} to PATH in ${RC_FILE}"
    fi
  fi

  export PATH="${INSTALL_DIR}:${PATH}"
}

# Set up systemd service (Linux) or launchd (macOS) for autostart
setup_autostart() {
  if [ "$IS_TRUENAS" = true ]; then
    info "TrueNAS detected — skipping systemd user service (not supported)."

    # Create a startup script instead
    STARTUP_SCRIPT="${INSTALL_DIR}/start-jarvis.sh"
    cat > "$STARTUP_SCRIPT" << SCRIPT
#!/bin/sh
# Jarvis Admin startup script for TrueNAS SCALE
export PORT=7711
export STATIC_DIR="${INSTALL_DIR}/public"
${DOCKER_SOCKET:+export DOCKER_SOCKET="${DOCKER_SOCKET}"}
exec "${INSTALL_DIR}/${BINARY_NAME}"
SCRIPT
    chmod +x "$STARTUP_SCRIPT"

    # Start now
    mkdir -p "$HOME/.jarvis/logs"
    STATIC_DIR="${INSTALL_DIR}/public" PORT=7711 ${DOCKER_SOCKET:+DOCKER_SOCKET="${DOCKER_SOCKET}"} \
      nohup "${INSTALL_DIR}/${BINARY_NAME}" > "$HOME/.jarvis/logs/admin.log" 2>&1 &
    success "Started (PID: $!)"

    printf "\n"
    printf "${BOLD}TrueNAS Setup Instructions:${NC}\n"
    printf "  1. Open TrueNAS web UI -> System -> Advanced -> Init/Shutdown Scripts\n"
    printf "  2. Add a Post Init script:\n"
    printf "     Command: ${STARTUP_SCRIPT}\n"
    printf "     Type: Script\n"
    printf "     When: Post Init\n"
    printf "  3. This ensures Jarvis Admin starts automatically after reboot.\n"
    printf "\n"

  elif [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
    info "Setting up systemd service..."

    SERVICE_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
    mkdir -p "$(dirname "$SERVICE_FILE")"

    cat > "$SERVICE_FILE" << UNIT
[Unit]
Description=Jarvis Admin Dashboard
After=network.target docker.service

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/${BINARY_NAME}
Restart=on-failure
RestartSec=5
Environment=PORT=7711
Environment=STATIC_DIR=${INSTALL_DIR}/public
${DOCKER_SOCKET:+Environment=DOCKER_SOCKET=${DOCKER_SOCKET}}

[Install]
WantedBy=default.target
UNIT

    systemctl --user daemon-reload
    systemctl --user enable "$SERVICE_NAME" 2>/dev/null || true
    systemctl --user restart "$SERVICE_NAME"

    # Enable lingering so user services start at boot (not just on login)
    loginctl enable-linger "$(whoami)" 2>/dev/null || true

    success "Systemd service installed and started"

  elif [ "$OS" = "darwin" ]; then
    info "Setting up launchd service..."

    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST_FILE="$PLIST_DIR/com.jarvis.admin.plist"
    mkdir -p "$PLIST_DIR"

    cat > "$PLIST_FILE" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.jarvis.admin</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/${BINARY_NAME}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>7711</string>
    <key>STATIC_DIR</key>
    <string>${INSTALL_DIR}/public</string>
    <!-- The native macOS admin runs on the host, outside Docker, so it must
         discover peers via config-service and reach them on published localhost
         ports. Point at config-service and request the "external" URL style
         (localhost, not host.docker.internal). Without these, startup URL
         resolution fails and the dashboard health + traces proxy silently break
         (auth=/config=/llm=/cc= all empty). NOTE: resolution runs once at
         startup, so on a truly fresh box the admin still needs one restart after
         the stack is up — KeepAlive + a mini reboot handle that. -->
    <key>JARVIS_CONFIG_URL</key>
    <string>http://localhost:7700</string>
    <key>JARVIS_CONFIG_URL_STYLE</key>
    <string>external</string>
    <!-- launchd's default PATH omits Docker Desktop's docker CLI; include the
         standard Homebrew + Docker.app locations so 'docker' resolves. The
         admin also self-heals its PATH at startup, but set it here too. -->
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${HOME}/.jarvis/logs/admin.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.jarvis/logs/admin.log</string>
</dict>
</plist>
PLIST

    mkdir -p "$HOME/.jarvis/logs"
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    launchctl load "$PLIST_FILE"

    success "LaunchAgent installed and started"

  else
    # Fallback: just start in background
    info "Starting jarvis-admin in background..."
    STATIC_DIR="${INSTALL_DIR}/public" PORT=7711 \
      nohup "${INSTALL_DIR}/${BINARY_NAME}" > "$HOME/.jarvis/logs/admin.log" 2>&1 &
    success "Started (PID: $!)"
  fi
}

# Print success message
print_success() {
  printf "\n"
  printf "${GREEN}${BOLD}Jarvis Admin installer is running!${NC}\n"
  printf "\n"
  printf "  1. Open ${BLUE}http://localhost:7711${NC} to run the first-time setup wizard.\n"
  printf "  2. After setup completes, your admin dashboard stays at the same ${BLUE}http://localhost:7711${NC}.\n"
  printf "\n"
  printf "  Re-run setup:     ${BOLD}JARVIS_FORCE_INSTALL=1 jarvis-admin${NC}\n"
  printf "  Check containers: ${BOLD}docker compose ls${NC}\n"
  printf "\n"
}

# Parse arguments
DOCKER_SOCKET=""
parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --docker-socket)
        if [ -z "$2" ] || [ "${2#-}" != "$2" ]; then
          error "--docker-socket requires a path argument"
        fi
        DOCKER_SOCKET="$2"
        export DOCKER_SOCKET
        info "Docker socket: ${DOCKER_SOCKET}"
        shift 2
        ;;
      --help|-h)
        printf "Usage: install.sh [OPTIONS]\n"
        printf "  --docker-socket PATH   Set custom Docker socket path\n"
        printf "  --help                 Show this help\n"
        exit 0
        ;;
      *)
        error "Unknown argument: $1"
        ;;
    esac
  done
}

# Main
main() {
  printf "\n${BOLD}Jarvis Admin Installer${NC}\n\n"

  parse_args "$@"
  check_prereqs
  detect_platform
  get_latest_version
  install_binary
  write_version
  setup_path
  setup_autostart
  print_success
}

main "$@"

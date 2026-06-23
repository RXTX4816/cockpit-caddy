#!/usr/bin/env bash
# Plugin-specific VM config for cockpit-caddy.
# Sourced by node_modules/@rxtx4816/cockpit-plugin-base/scripts/test-vm.sh

PLUGIN_NAME="cockpit-caddy"
MOUNT_TAG="cockpit_caddy"
INSTALL_PATH="/usr/share/cockpit/cockpit-caddy"

# Simple distro VMs — no runtime variants needed for Caddy
ALL_VMS=(arch debian fedora)
SSH_BASE=2230       # offset from compose's 2220 so both can run simultaneously
COCKPIT_BASE=9093

extra_packages() {
  local distro="$1"
  case "$distro" in
    arch)   echo "caddy" ;;
    debian) echo "caddy" ;;
    fedora) echo "caddy" ;;
  esac
}

extra_runcmd() {
  local distro; distro="${1%%-*}"
  case "$distro" in
    arch)
      cat <<'YAML'
  - pacman -Sy --noconfirm caddy || true
  - systemctl enable --now caddy
YAML
      ;;
    *)
      cat <<'YAML'
  - systemctl enable --now caddy
YAML
      ;;
  esac
}

pre_staged_files() {
  : # no pre-staged files needed for caddy testing
}

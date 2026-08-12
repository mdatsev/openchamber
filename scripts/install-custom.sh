#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
linux_launcher="$repo_root/packages/electron/scripts/launch-custom-linux.sh"

info() {
  printf 'info  %s\n' "$1"
}

success() {
  printf 'success  %s\n' "$1"
}

fail() {
  printf 'error  %s\n' "$1" >&2
  exit 1
}

install_linux() {
  local applications_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  local desktop_file="$applications_dir/openchamber-custom-source.desktop"
  local legacy_desktop_file="$applications_dir/openchamber-custom.desktop"
  local icon="$repo_root/packages/electron/resources/icons/icon.png"

  [[ -f "$linux_launcher" ]] || fail "Linux launcher not found at $linux_launcher"
  [[ -f "$icon" ]] || fail "OpenChamber icon not found at $icon"

  mkdir -p "$applications_dir"
  chmod +x "$linux_launcher"

  cat > "$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=OpenChamber CUSTOM
Comment=Run custom OpenChamber from source
Exec="$linux_launcher"
Path=$repo_root
Icon=$icon
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=openchamber-custom-source
EOF

  rm -f "$legacy_desktop_file"

  if command -v desktop-file-validate >/dev/null 2>&1; then
    desktop-file-validate "$desktop_file"
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$applications_dir"
  fi

  success "Installed OpenChamber CUSTOM launcher at $desktop_file"
  info "Launch it from the application menu, then pin its separate taskbar icon."
  info "Logs: ${XDG_STATE_HOME:-$HOME/.local/state}/openchamber-custom/dev.log"
}

set_plist_string() {
  local plist="$1"
  local key="$2"
  local value="$3"

  if ! /usr/libexec/PlistBuddy -c "Set :$key $value" "$plist" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c "Add :$key string $value" "$plist"
  fi
}

install_macos() {
  local source_app="$repo_root/packages/electron/node_modules/electron/dist/Electron.app"
  local applications_dir="$HOME/Applications"
  local target_app="$applications_dir/OpenChamber CUSTOM.app"
  local staging_dir
  local staged_app
  local plist
  local original_binary
  local custom_binary
  local wrapper
  local icon_source="$repo_root/packages/electron/resources/icons/icon.icns"
  local icon_target
  local quoted_repo_root

  [[ -d "$source_app" ]] || fail "Electron.app not found. Run bun install first."
  [[ -f "$icon_source" ]] || fail "OpenChamber macOS icon not found at $icon_source"
  command -v ditto >/dev/null 2>&1 || fail "ditto is required to install the macOS launcher"
  command -v codesign >/dev/null 2>&1 || fail "codesign is required to install the macOS launcher"
  [[ -x /usr/libexec/PlistBuddy ]] || fail "PlistBuddy is required to install the macOS launcher"

  mkdir -p "$applications_dir"
  staging_dir="$(mktemp -d)"
  trap 'rm -rf "$staging_dir"' EXIT
  staged_app="$staging_dir/OpenChamber CUSTOM.app"

  info "Copying Electron runtime into OpenChamber CUSTOM.app"
  ditto "$source_app" "$staged_app"

  plist="$staged_app/Contents/Info.plist"
  original_binary="$staged_app/Contents/MacOS/Electron"
  custom_binary="$staged_app/Contents/MacOS/openchamber-custom-bin"
  wrapper="$staged_app/Contents/MacOS/openchamber-custom"
  icon_target="$staged_app/Contents/Resources/openchamber-custom.icns"

  mv "$original_binary" "$custom_binary"
  cp "$icon_source" "$icon_target"
  printf -v quoted_repo_root '%q' "$repo_root"

  cat > "$wrapper" <<EOF
#!/usr/bin/env bash

set -euo pipefail

repo_root=$quoted_repo_root
macos_dir="\$(cd -- "\$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
state_dir="\$HOME/Library/Logs/OpenChamber CUSTOM"
log_file="\$state_dir/dev.log"

mkdir -p "\$state_dir"
exec > "\$log_file" 2>&1

bun_bin="\${BUN_INSTALL:-\$HOME/.bun}/bin/bun"
if [[ ! -x "\$bun_bin" ]]; then
  bun_bin="\$(command -v bun || true)"
fi
if [[ -z "\$bun_bin" ]]; then
  printf 'Bun was not found. Install the repository-pinned Bun version and try again.\\n'
  exit 127
fi

export PATH="\$(dirname -- "\$bun_bin"):\$PATH"
export OPENCHAMBER_ELECTRON_BIN="\$macos_dir/openchamber-custom-bin"
export OPENCHAMBER_ELECTRON_CACHE_BUNDLED_UI=1
export OPENCHAMBER_DESKTOP_PORT=46405

cd "\$repo_root"
exec "\$bun_bin" run electron:dev:bundled
EOF
  chmod +x "$wrapper" "$custom_binary"

  set_plist_string "$plist" CFBundleIdentifier dev.openchamber.custom.source
  set_plist_string "$plist" CFBundleName "OpenChamber CUSTOM"
  set_plist_string "$plist" CFBundleDisplayName "OpenChamber CUSTOM"
  set_plist_string "$plist" CFBundleExecutable openchamber-custom
  set_plist_string "$plist" CFBundleIconFile openchamber-custom.icns

  codesign --force --deep --sign - "$staged_app"
  rm -rf "$target_app"
  mv "$staged_app" "$target_app"
  trap - EXIT
  rm -rf "$staging_dir"

  success "Installed OpenChamber CUSTOM at $target_app"
  info "Open it from Finder once, then choose Keep in Dock."
  info "Logs: $HOME/Library/Logs/OpenChamber CUSTOM/dev.log"
}

case "$(uname -s)" in
  Linux)
    install_linux
    ;;
  Darwin)
    install_macos
    ;;
  *)
    fail "OpenChamber CUSTOM launcher installation supports Linux and macOS only"
    ;;
esac

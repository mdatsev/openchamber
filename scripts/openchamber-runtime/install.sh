#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
custom_repo="${OPENCHAMBER_CUSTOM_FORK_REPO:-$repo_root}"
custom_remote="${OPENCHAMBER_CUSTOM_FORK_REMOTE:-https://github.com/mdatsev/openchamber.git}"
custom_branch="${OPENCHAMBER_CUSTOM_FORK_BRANCH:-custom}"
runtime_dir="${XDG_DATA_HOME:-$HOME/.local/share}/openchamber-runtime"
bin_dir="$HOME/.local/bin"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
service_path="${PATH:-$HOME/.bun/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin}"
opencode_bin="${OPENCODE_BINARY:-$HOME/.local/bin/opencode}"
openchamber_bin="${OPENCHAMBER_BINARY:-$HOME/.npm-global/bin/openchamber}"
node_bin="${NODE_BINARY:-$(command -v node)}"
bun_candidate="${BUN_BINARY:-bun}"
bun_bin="$(command -v "$bun_candidate" || true)"
activate=''

usage() {
  printf 'Usage: %s [--activate regular|custom]\n' "$0" >&2
  exit 2
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --activate)
      [[ $# -ge 2 ]] || usage
      activate="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

if [[ -n "$activate" && "$activate" != 'regular' && "$activate" != 'custom' ]]; then
  usage
fi

for command in systemctl systemd-analyze systemd-run curl flock git; do
  command -v "$command" >/dev/null 2>&1 || fail "Required command is unavailable: $command"
done

[[ -x "$opencode_bin" ]] || fail "OpenCode binary is not executable: $opencode_bin"
[[ -x "$openchamber_bin" ]] || fail "OpenChamber binary is not executable: $openchamber_bin"
[[ -x "$node_bin" ]] || fail "Node binary is not executable: $node_bin"
[[ -n "$bun_bin" && -x "$bun_bin" ]] || fail "Bun binary is not executable: $bun_candidate"
[[ -f "$custom_repo/packages/web/bin/cli.js" ]] || fail "Custom OpenChamber checkout is invalid: $custom_repo"

mkdir -p "$runtime_dir" "$bin_dir" "$unit_dir"
staging_dir="$(mktemp -d "$unit_dir/.openchamber-runtime.XXXXXX")"
trap 'rm -rf "$staging_dir"' EXIT
install -m 0644 "$script_dir/systemd/opencode-tools.slice" "$staging_dir/opencode-tools.slice"

render_unit() {
  local source="$1"
  local target="$2"
  local content
  content="$(<"$source")"
  content="${content//@HOME@/$HOME}"
  content="${content//@BIN_DIR@/$bin_dir}"
  content="${content//@CUSTOM_REPO@/$custom_repo}"
  content="${content//@CUSTOM_FORK_REMOTE@/$custom_remote}"
  content="${content//@CUSTOM_FORK_BRANCH@/$custom_branch}"
  content="${content//@RUNTIME_DIR@/$runtime_dir}"
  content="${content//@SERVICE_PATH@/$service_path}"
  content="${content//@OPENCODE_BIN@/$opencode_bin}"
  content="${content//@OPENCHAMBER_BIN@/$openchamber_bin}"
  content="${content//@NODE_BIN@/$node_bin}"
  content="${content//@BUN_BIN@/$bun_bin}"
  printf '%s\n' "$content" > "$target"
  chmod 0644 "$target"
}

render_unit "$script_dir/systemd/opencode.service.in" "$staging_dir/opencode.service"
render_unit "$script_dir/systemd/opencode-tool-memory-supervisor.service.in" "$staging_dir/opencode-tool-memory-supervisor.service"
render_unit "$script_dir/systemd/openchamber.service.in" "$staging_dir/openchamber.service"
render_unit "$script_dir/systemd/openchamber-custom.service.in" "$staging_dir/openchamber-custom.service"
render_unit "$script_dir/systemd/openchamber-tailnet-control.service.in" "$staging_dir/openchamber-tailnet-control.service"
render_unit "$script_dir/openchamber-switch" "$staging_dir/openchamber-switch"

install -m 0755 "$script_dir/opencode-tool-memory-supervisor" "$runtime_dir/opencode-tool-memory-supervisor"
install -m 0644 "$script_dir/apply-custom-update.mjs" "$runtime_dir/apply-custom-update.mjs"
install -m 0755 "$script_dir/tailnet-control.mjs" "$runtime_dir/tailnet-control.mjs"
systemd-analyze --user verify \
  "$staging_dir/opencode.service" \
  "$staging_dir/opencode-tool-memory-supervisor.service" \
  "$staging_dir/opencode-tools.slice" \
  "$staging_dir/openchamber.service" \
  "$staging_dir/openchamber-custom.service" \
  "$staging_dir/openchamber-tailnet-control.service"
install -m 0755 "$staging_dir/openchamber-switch" "$bin_dir/openchamber-switch"
install -m 0644 "$staging_dir/opencode.service" "$unit_dir/opencode.service"
install -m 0644 "$staging_dir/opencode-tool-memory-supervisor.service" "$unit_dir/opencode-tool-memory-supervisor.service"
install -m 0644 "$staging_dir/opencode-tools.slice" "$unit_dir/opencode-tools.slice"
install -m 0644 "$staging_dir/openchamber.service" "$unit_dir/openchamber.service"
install -m 0644 "$staging_dir/openchamber-custom.service" "$unit_dir/openchamber-custom.service"
install -m 0644 "$staging_dir/openchamber-tailnet-control.service" "$unit_dir/openchamber-tailnet-control.service"
systemctl --user daemon-reload
install -m 0755 "$script_dir/opencode-cgroup-shell" "$runtime_dir/bash"
trap - EXIT
rm -rf "$staging_dir"

printf 'Installed external OpenCode runtime, tool-memory supervisor, and OpenChamber switch units.\n'
printf 'No running service was changed. Inspect with: openchamber-switch status\n'

if [[ -n "$activate" ]]; then
  "$bin_dir/openchamber-switch" "$activate"
fi

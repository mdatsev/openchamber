#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/openchamber-custom"
log_file="$state_dir/dev.log"

mkdir -p "$state_dir"
exec > "$log_file" 2>&1

bun_bin="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
if [[ ! -x "$bun_bin" ]]; then
  bun_bin="$(command -v bun || true)"
fi

if [[ -z "$bun_bin" ]]; then
  printf 'Bun was not found. Install the repository-pinned Bun version and try again.\n'
  exit 127
fi

export PATH="$(dirname -- "$bun_bin"):$PATH"

printf 'Starting OpenChamber CUSTOM from %s\n' "$repo_root"
printf 'Writing this run to %s\n\n' "$log_file"

cd "$repo_root"
exec "$bun_bin" run electron:dev:bundled

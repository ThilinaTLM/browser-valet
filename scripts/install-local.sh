#!/usr/bin/env bash
# Build a release bvl (with the extension embedded) and copy it to ~/.local/bin.
# Usage: scripts/install-local.sh            # installs to ~/.local/bin/bvl
#        BIN_DIR=/some/dir scripts/install-local.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="${BIN_DIR:-$HOME/.local/bin}"

# The CLI embeds extension/dist, so build the extension first.
echo "==> Building extension"
cd "$root/extension"
[ -d node_modules ] || pnpm install --frozen-lockfile
pnpm build

echo "==> Building bvl (release)"
cd "$root/cli"
cargo build --release --locked

echo "==> Installing to $bin_dir/bvl"
mkdir -p "$bin_dir"
# Copy to a temp name and rename, so a running bvl is not overwritten in place.
install -m 755 "$root/cli/target/release/bvl" "$bin_dir/.bvl.tmp"
mv -f "$bin_dir/.bvl.tmp" "$bin_dir/bvl"

"$bin_dir/bvl" --version 2>/dev/null || true
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "note: $bin_dir is not on your PATH" ;;
esac

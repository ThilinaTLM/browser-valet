#!/bin/sh
# Install bvl (Browser Valet CLI) from a GitHub release on Linux or macOS.
#
#   curl -fsSL https://github.com/ThilinaTLM/browser-valet/releases/latest/download/install.sh | sh
#
# Environment:
#   BVL_VERSION      release tag to install, e.g. v0.2.0 or v0.2.0-rc.1 (default: latest stable)
#   BVL_INSTALL_DIR  where to put bvl (default: ~/.local/bin)
#   BVL_BASE_URL     release download base, for mirrors and tests
#                    (default: https://github.com/ThilinaTLM/browser-valet/releases)
#
# Downloads bvl-<target>.tar.gz, checks it against the release's SHA256SUMS and installs the
# binary. Running it again upgrades bvl; the extension follows on its next connection.
# Everything lives in main() so a truncated download cannot run half a script.

set -eu

REPO_URL="https://github.com/ThilinaTLM/browser-valet/releases"

say() { printf '%s\n' "$*"; }
err() { printf 'bvl install: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

download() { # url dest
  if has curl; then
    curl -fsSL --proto '=https,file' --retry 3 -o "$2" "$1"
  elif has wget; then
    wget -q -O "$2" "$1"
  else
    err "need curl or wget"
  fi
}

sha256() { # file -> hex digest
  if has sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif has shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  elif has openssl; then openssl dgst -sha256 "$1" | sed 's/.*= *//'
  else err "need sha256sum, shasum or openssl to verify the download"
  fi
}

detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$arch" in
    x86_64 | amd64) arch=x86_64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) err "unsupported CPU architecture: $arch (prebuilt: x86_64, aarch64)" ;;
  esac
  case "$os" in
    Linux) echo "$arch-unknown-linux-musl" ;;
    Darwin)
      # A shell under Rosetta reports x86_64 on Apple Silicon: prefer the native build.
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
        arch=aarch64
      fi
      echo "$arch-apple-darwin" ;;
    MINGW* | MSYS* | CYGWIN*) err "on Windows, use install.ps1 (see the README)" ;;
    *) err "unsupported OS: $os (prebuilt: Linux, macOS, Windows)" ;;
  esac
}

main() {
  base="${BVL_BASE_URL:-$REPO_URL}"
  base="${base%/}"
  version="${BVL_VERSION:-latest}"
  case "$version" in
    latest) url="$base/latest/download" ;;
    v*) url="$base/download/$version" ;;
    *) url="$base/download/v$version" ;;
  esac
  bin_dir="${BVL_INSTALL_DIR:-$HOME/.local/bin}"
  target=$(detect_target)
  asset="bvl-$target.tar.gz"

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t bvl)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading $asset ($version)"
  download "$url/$asset" "$tmp/$asset" || err "download failed: $url/$asset"
  download "$url/SHA256SUMS" "$tmp/SHA256SUMS" || err "download failed: $url/SHA256SUMS"

  want=$(awk -v f="$asset" '{ n = $2; sub(/^\*/, "", n) } n == f { print $1; exit }' "$tmp/SHA256SUMS")
  [ -n "$want" ] || err "$asset is not listed in SHA256SUMS"
  got=$(sha256 "$tmp/$asset")
  [ "$want" = "$got" ] || err "checksum mismatch for $asset (expected $want, got $got)"
  say "Checksum OK"

  mkdir -p "$tmp/x"
  tar -xzf "$tmp/$asset" -C "$tmp/x"
  [ -f "$tmp/x/bvl" ] || err "bvl not found in $asset"

  mkdir -p "$bin_dir"
  # Copy to a temp name, then rename: a running bvl (e.g. the proxy) is never written in place.
  cp "$tmp/x/bvl" "$bin_dir/.bvl.tmp"
  chmod 755 "$bin_dir/.bvl.tmp"
  mv -f "$bin_dir/.bvl.tmp" "$bin_dir/bvl"

  installed=$("$bin_dir/bvl" version 2>/dev/null) || err "installed $bin_dir/bvl but it does not run"
  say "Installed $installed to $bin_dir/bvl"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      say ""
      say "$bin_dir is not on your PATH. Add it, e.g. in ~/.bashrc, ~/.zshrc or ~/.profile:"
      say "  export PATH=\"$bin_dir:\$PATH\""
      ;;
  esac
  say ""
  say "Next: run \`bvl setup\` to install the browser extension."
}

main "$@"

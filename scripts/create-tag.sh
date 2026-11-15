#!/usr/bin/env bash
# Bump the release version, commit, tag vX.Y.Z and push both to origin.
# The tag triggers .github/workflows/release.yml, which checks that the tag matches all three versions.
# Usage: scripts/create-tag.sh 0.2.0          # or v0.2.0, or a pre-release such as 0.2.0-rc.1
#        scripts/create-tag.sh -y 0.2.0       # skip the confirmation prompt
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

die() { echo "error: $*" >&2; exit 1; }

yes=0
[ "${1:-}" = "-y" ] && { yes=1; shift; }
[ $# -eq 1 ] || die "usage: scripts/create-tag.sh [-y] <version>   e.g. 0.2.0 or 0.2.0-rc.1"

version="${1#v}"
tag="v$version"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "'$1' is not a semver version (X.Y.Z or X.Y.Z-pre)"

cargo_toml=cli/Cargo.toml
package_json=extension/package.json
manifest_json=extension/static/manifest.json

# --- Preconditions ---------------------------------------------------------------------------
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || die "on branch '$branch'; releases are tagged from main"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean; commit or stash first"

git fetch --quiet --tags origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not in sync with origin/main; pull or push first"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "tag $tag already exists"

current="$(grep -m1 '^version' "$cargo_toml" | cut -d'"' -f2)"
[ "$current" != "$version" ] || die "version is already $version"

echo "Release $tag (current version $current)"
echo "  will update $cargo_toml, cli/Cargo.lock, $package_json, $manifest_json"
echo "  then commit, tag $tag and push main + $tag to origin"
if [ "$yes" -eq 0 ]; then
  read -r -p "Continue? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || die "aborted"
fi

# --- Bump versions ---------------------------------------------------------------------------
# Targeted line edits (not jq rewrites) so the files keep their formatting and the manifest `key`
# is never touched.
sed -i.bak -E "0,/^version = \".*\"/s//version = \"$version\"/" "$cargo_toml"
sed -i.bak -E "0,/^  \"version\": \".*\"/s//  \"version\": \"$version\"/" "$package_json"
sed -i.bak -E "0,/^  \"version\": \".*\"/s//  \"version\": \"$version\"/" "$manifest_json"
rm -f "$cargo_toml.bak" "$package_json.bak" "$manifest_json.bak"

# CI builds with --locked, so Cargo.lock must carry the new version too.
(cd cli && cargo update --workspace --offline --quiet)

# Verify every file got the new version (same check as the release workflow).
cli_v="$(grep -m1 '^version' "$cargo_toml" | cut -d'"' -f2)"
pkg_v="$(jq -r .version "$package_json")"
man_v="$(jq -r .version "$manifest_json")"
lock_v="$(grep -A1 '^name = "browser-valet"$' cli/Cargo.lock | sed -n 's/^version = "\(.*\)"/\1/p')"
for v in "$cli_v" "$pkg_v" "$man_v" "$lock_v"; do
  [ "$v" = "$version" ] || {
    git checkout -- "$cargo_toml" cli/Cargo.lock "$package_json" "$manifest_json"
    die "version bump failed (Cargo.toml=$cli_v Cargo.lock=$lock_v package.json=$pkg_v manifest.json=$man_v); changes reverted"
  }
done

git --no-pager diff --stat

# --- Commit, tag, push -----------------------------------------------------------------------
git add "$cargo_toml" cli/Cargo.lock "$package_json" "$manifest_json"
git commit --quiet -m "Release $tag"
git tag -a "$tag" -m "$tag"
# --atomic: either both main and the tag land on origin, or neither does.
git push --atomic origin main "refs/tags/$tag"

echo "Pushed $tag. Follow the release at:"
echo "  https://github.com/ThilinaTLM/browser-valet/actions/workflows/release.yml"

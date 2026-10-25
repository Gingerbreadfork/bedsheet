#!/bin/sh
# Regenerates the offline cargo and pnpm sources for the Flatpak build.
# Run it whenever Cargo.lock or pnpm-lock.yaml changes. Needs git and uv.
set -eu

TOOLS_COMMIT=9d86d336a39b9af38b86f114b6ce5820fe260f91

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
tools=$(mktemp -d)
trap 'rm -rf "$tools"' EXIT

git -C "$tools" init --quiet
git -C "$tools" fetch --quiet --depth 1 https://github.com/flatpak/flatpak-builder-tools "$TOOLS_COMMIT"
git -C "$tools" checkout --quiet FETCH_HEAD

uv run --quiet --isolated --no-project --with aiohttp --with PyYAML --with tomlkit \
  python "$tools/cargo/flatpak-cargo-generator.py" "$root/src-tauri/Cargo.lock" \
  -o "$here/cargo-sources.json"

uvx --quiet --isolated --from "$tools/node" flatpak-node-generator \
  pnpm "$root/pnpm-lock.yaml" -o "$here/node-sources.json"

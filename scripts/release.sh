#!/usr/bin/env bash
#
# Build the standalone binaries and upload them to a GitHub Release.
#
# The release itself is normally created by the CI workflow
# (.github/workflows/release.yml) when you push a v* tag. This script lets you
# (re)build the cross-platform Go binaries locally and attach — or refresh —
# them on that release, or create the release if it doesn't exist yet.
#
# Usage:
#   scripts/release.sh v1.0.0            # build + upload binaries to v1.0.0
#   scripts/release.sh v1.0.0 --tag-push # also create & push the git tag first
#
# Requires the GitHub CLI (gh), authenticated: https://cli.github.com
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "usage: scripts/release.sh <vX.Y.Z> [--tag-push]" >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "error: GitHub CLI 'gh' is required (https://cli.github.com) and must be authenticated (gh auth login)" >&2
  exit 1
fi

# optionally create and push the tag (which also triggers the CI workflow)
if [ "${2:-}" = "--tag-push" ]; then
  git tag "$TAG"
  git push origin "$TAG"
fi

echo "==> Building cross-platform binaries"
make cross

echo "==> Generating checksums"
( cd dist
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum devtil-* > SHA256SUMS
  else
    shasum -a 256 devtil-* > SHA256SUMS   # macOS
  fi
  cat SHA256SUMS
)

# create the release from the notes if it doesn't exist yet, else reuse it
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "==> Release $TAG already exists — uploading assets"
else
  echo "==> Creating release $TAG from RELEASE_NOTES.md"
  gh release create "$TAG" --title "Devtil $TAG" --notes-file RELEASE_NOTES.md
fi

echo "==> Uploading assets (overwriting any with the same name)"
gh release upload "$TAG" dist/devtil-* dist/SHA256SUMS --clobber

echo "==> Done. Assets on $TAG:"
gh release view "$TAG" --json assets --jq '.assets[].name'

#!/usr/bin/env bash
# Install this checkout into a dsh profile as a packaged copy.
#
# The profile gets a real directory from a tarball kept under
# $DSH_HOME/plugins/packages, so the running plugin never points at this
# development checkout. Restart `dsh web` afterwards: preset rows are not
# HMR-managed.
#
# Usage: scripts/install-local.sh [profile]   (default profile: web)
set -euo pipefail

profile="${1:-web}"
dsh_home="${DSH_HOME:-$HOME/.dsh}"
packages="$dsh_home/plugins/packages"
root="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$packages"
version="$(node -p "require('$root/package.json').version")"
tarball="$packages/discipline-whale-$version.tgz"
rm -f "$tarball"
npm pack --silent --pack-destination "$packages" "$root" >/dev/null

dsh() { npx -y @deepseek-ai/dsh@latest "$@"; }
dsh plugin --profile "$profile" remove discipline-whale >/dev/null 2>&1 || true
dsh plugin --profile "$profile" add "$tarball"

echo "installed $tarball into profile '$profile'; restart dsh web to load it"

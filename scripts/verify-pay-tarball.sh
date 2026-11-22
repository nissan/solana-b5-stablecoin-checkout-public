#!/usr/bin/env bash
# Rebuild app/vendor/solana-pay-1.2.0.tgz from its upstream commit and compare digests.
#
#   scripts/verify-pay-tarball.sh
#
# @solana/pay 1.2.0 is on upstream main but not on npm, so the app installs a tarball
# committed in app/vendor (decision D-11). This script is what vouches for that file:
# it checks out the pinned commit, runs upstream's own build, packs the package and
# fails unless the result is byte-identical to the committed tarball. Needs git, node,
# pnpm 10 and network access. pnpm 10 switches itself to the version upstream pins
# when run inside upstream's workspace; the version check below fails if it did not.
set -euo pipefail

REPO=https://github.com/solana-foundation/pay.git
COMMIT=a5c1c831cfa6c67e312313f4fee8f3975fe5f355
NAME=solana-pay-1.2.0.tgz

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git init -q "$work/src"
git -C "$work/src" fetch -q --depth 1 "$REPO" "$COMMIT"
git -C "$work/src" checkout -q FETCH_HEAD
[ "$(git -C "$work/src" rev-parse HEAD)" = "$COMMIT" ]

cd "$work/src/typescript"
want=$(node -p "require('./package.json').packageManager.split('@')[1]")
have=$(pnpm --version)
if [ "$have" != "$want" ]; then
  echo "FAIL: upstream pins pnpm $want at $COMMIT; found pnpm $have" >&2
  exit 1
fi

pnpm install --frozen-lockfile >"$work/install.log" 2>&1 || { cat "$work/install.log" >&2; exit 1; }
pnpm --filter @solana/pay build >"$work/build.log" 2>&1 || { cat "$work/build.log" >&2; exit 1; }
(cd packages/solana-pay/core && pnpm pack --pack-destination "$work/out" >/dev/null)

built=$(sha256sum "$work/out/$NAME" | cut -d' ' -f1)
committed=$(sha256sum "$root/app/vendor/$NAME" | cut -d' ' -f1)
if [ "$built" != "$committed" ]; then
  echo "FAIL: app/vendor/$NAME is $committed; a build of $COMMIT is $built" >&2
  exit 1
fi
echo "PASS: app/vendor/$NAME matches a build of solana-foundation/pay@$COMMIT (sha256 $built)"

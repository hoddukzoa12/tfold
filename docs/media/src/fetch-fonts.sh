#!/usr/bin/env bash
set -euo pipefail

src=$(cd "$(dirname "$0")" && pwd)
version=1.3.9
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

(cd "$scratch" && npm pack --silent "pretendard@$version" >/dev/null && tar xzf "pretendard-$version.tgz")
mkdir -p "$src/assets/fonts"
for weight in Regular Medium SemiBold Bold; do
	cp "$scratch/package/dist/web/static/woff2/Pretendard-$weight.woff2" "$src/assets/fonts/"
	cp "$scratch/package/dist/public/static/Pretendard-$weight.otf" "$src/assets/fonts/"
done
cp "$scratch/package/dist/LICENSE.txt" "$src/assets/fonts/LICENSE-Pretendard.txt"
ls "$src/assets/fonts"

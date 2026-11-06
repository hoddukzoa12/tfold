#!/usr/bin/env bash
# Rebuilds docs/media from the real extension on a Linux machine with Node 22 and ffmpeg.
# Usage: rebuild.sh <fold-build-dir> [<popup-build-dir>] [--live]
# Folds show the lines in model-lines.json. --live asks the model again, needs OPENGATEWAY_API_KEY, and rewrites that file.
set -euo pipefail

src=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$src/../../.." && pwd)
media=$repo/docs/media
fold_build=$(realpath "$1")
popup_build=$(realpath "${2:-$1}")
hyperframes=(npx --yes hyperframes@0.9.12)
export HYPERFRAMES_NO_TELEMETRY=1

[ -e "$src/assets/fonts/Pretendard-Regular.woff2" ] || bash "$src/fetch-fonts.sh"

cd "$repo"
node scripts/capture-media.ts --folds "$fold_build" --popups "$popup_build" --stills "$media" "${@:3}"

mkdir -p "$src/renders"
(cd "$src/hero" && "${hyperframes[@]}" render --quality high --fps 30 --output "$src/renders/hero.mp4")
(cd "$src/film" && "${hyperframes[@]}" render --quality high --fps 30 --output "$media/tfold-product.mp4")
bash "$src/hero-gif.sh" "$src/renders/hero.mp4" "$media/tfold-hero.gif"
ls -la "$media"/tfold-*

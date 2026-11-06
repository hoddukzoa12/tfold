#!/usr/bin/env bash
# Encodes the hero render as a looping GIF with one palette and no dithering, which keeps type sharp and the file small.
set -euo pipefail

fps=25
filters="fps=$fps,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle"
ffmpeg -y -loglevel error -i "$1" -filter_complex "$filters" -loop 0 "$2"

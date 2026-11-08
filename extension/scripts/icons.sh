#!/usr/bin/env sh
# Regenerates the toolbar/store PNG icons from the SVG sources (needs rsvg-convert).
# Not part of the build: the PNGs are committed.
set -eu
cd "$(dirname "$0")/../static/icons"
rsvg-convert -w 128 -h 128 icon.svg -o icon-128.png
rsvg-convert -w 48 -h 48 icon.svg -o icon-48.png
rsvg-convert -w 32 -h 32 icon-small.svg -o icon-32.png
rsvg-convert -w 16 -h 16 icon-small.svg -o icon-16.png

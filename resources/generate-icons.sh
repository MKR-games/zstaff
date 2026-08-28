#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_svg="$project_dir/resources/app-icon.svg"
icon_dir="$project_dir/icons"
runtime_dir="$project_dir/resources/.icon-runtime"

mkdir -p "$icon_dir" "$runtime_dir/config" "$runtime_dir/cache" "$runtime_dir/data"
export XDG_CONFIG_HOME="$runtime_dir/config"
export XDG_CACHE_HOME="$runtime_dir/cache"
export XDG_DATA_HOME="$runtime_dir/data"

inkscape "$source_svg" --export-filename="$icon_dir/icon-192.png" --export-width=192 --export-height=192
inkscape "$source_svg" --export-filename="$icon_dir/icon-512.png" --export-width=512 --export-height=512
inkscape "$source_svg" --export-filename="$icon_dir/icon-maskable-512.png" --export-width=512 --export-height=512
inkscape "$source_svg" --export-filename="$icon_dir/apple-touch-icon-180.png" --export-width=180 --export-height=180

for icon_file in \
  "$icon_dir/icon-192.png" \
  "$icon_dir/icon-512.png" \
  "$icon_dir/icon-maskable-512.png" \
  "$icon_dir/apple-touch-icon-180.png"
do
  opaque_file="$runtime_dir/$(basename "$icon_file")"
  convert "$icon_file" -background "#111827" -alpha remove -alpha off "PNG24:$opaque_file"
  mv "$opaque_file" "$icon_file"
done

echo "PWA icons generated."

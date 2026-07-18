#!/bin/sh
set -eu

destination="$1"
project_directory=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
machine_arch=$(uname -m)
cache_directory="$project_directory/src-tauri/binaries/build-cache/$machine_arch"
source_directory="$cache_directory/source"
prefix_directory="$cache_directory/prefix"
build_jobs="${PICFLIP_BUILD_JOBS:-4}"
build_marker="$cache_directory/picflip-video-profile-v2"

mkdir -p "$source_directory" "$prefix_directory"

if [ -x "$source_directory/ffmpeg-8.0/ffmpeg" ] && [ -f "$build_marker" ]; then
  cp "$source_directory/ffmpeg-8.0/ffmpeg" "$destination"
  chmod 755 "$destination"
  exit 0
fi

download_and_extract() {
  url="$1"
  archive="$2"
  folder="$3"
  expected_sha256="$4"

  if [ -f "$source_directory/$folder/configure" ]; then
    return
  fi

  # A previous interrupted or cleaned build can leave an incomplete directory.
  # Never treat that as a valid source tree.
  if [ -d "$source_directory/$folder" ]; then
    rm -rf "$source_directory/$folder"
  fi

  if [ ! -f "$source_directory/$archive" ]; then
    curl -L --fail --retry 3 --show-error "$url" -o "$source_directory/$archive"
  fi

  actual_sha256=$(shasum -a 256 "$source_directory/$archive" | awk '{print $1}')
  if [ "$actual_sha256" != "$expected_sha256" ]; then
    echo "SHA-256 mismatch for $archive" >&2
    echo "Expected: $expected_sha256" >&2
    echo "Actual:   $actual_sha256" >&2
    exit 1
  fi

  tar -xf "$source_directory/$archive" -C "$source_directory"
}

download_and_extract \
  "https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz" \
  "lame-3.100.tar.gz" \
  "lame-3.100" \
  "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"

download_and_extract \
  "https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz" \
  "ffmpeg-8.0.tar.xz" \
  "ffmpeg-8.0" \
  "b2751fccb6cc4c77708113cd78b561059b6fa904b24162fa0be2d60273d27b8e"

download_and_extract \
  "https://code.videolan.org/videolan/x264/-/archive/stable/x264-stable.tar.bz2" \
  "x264-stable.tar.bz2" \
  "x264-stable" \
  "740126cb48549ca4e2f09b4ae13beed592d5b54744044e38f28662fd96d0ba56"

if [ ! -f "$prefix_directory/lib/libmp3lame.a" ]; then
  cd "$source_directory/lame-3.100"
  ./configure \
    --prefix="$prefix_directory" \
    --disable-shared \
    --enable-static \
    --disable-frontend
  make -j"$build_jobs" || make -j1
  make install
fi

if [ ! -f "$prefix_directory/lib/libx264.a" ]; then
  cd "$source_directory/x264-stable"
  ./configure \
    --prefix="$prefix_directory" \
    --enable-static \
    --disable-cli \
    --disable-opencl \
    --disable-asm
  make -j"$build_jobs" || make -j1
  make install
fi

cd "$source_directory/ffmpeg-8.0"
make distclean >/dev/null 2>&1 || true

deployment_target="10.15"
extra_configuration=""
if [ "$machine_arch" = "arm64" ]; then
  deployment_target="11.0"
else
  extra_configuration="--disable-x86asm"
fi
export MACOSX_DEPLOYMENT_TARGET="$deployment_target"
export PICFLIP_CODEC_PREFIX="$prefix_directory"
chmod 755 "$project_directory/scripts/picflip-pkg-config.sh"

PKG_CONFIG_PATH="$prefix_directory/lib/pkgconfig" ./configure \
  --prefix="$prefix_directory/ffmpeg" \
  --enable-gpl \
  --enable-libmp3lame \
  --enable-libx264 \
  --pkg-config-flags="--static" \
  --pkg-config="$project_directory/scripts/picflip-pkg-config.sh" \
  --extra-cflags="-I$prefix_directory/include" \
  --extra-ldflags="-L$prefix_directory/lib" \
  --disable-autodetect \
  --disable-doc \
  --disable-debug \
  --disable-ffplay \
  --disable-ffprobe \
  --disable-network \
  --disable-avdevice \
  --enable-small \
  $extra_configuration

make -j"$build_jobs" ffmpeg
cp "$source_directory/ffmpeg-8.0/ffmpeg" "$destination"
chmod 755 "$destination"
touch "$build_marker"

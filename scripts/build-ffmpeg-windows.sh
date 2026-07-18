#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <destination.exe> [cache-directory]" >&2
  exit 2
fi

destination="$1"
project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$destination" != /* ]]; then
  destination="$project_directory/$destination"
fi

cache_directory="${2:-$project_directory/src-tauri/binaries/build-cache/windows-x64}"
if [[ "$cache_directory" != /* ]]; then
  cache_directory="$project_directory/$cache_directory"
fi

source_directory="$cache_directory/source"
prefix_directory="$cache_directory/prefix"
tool_shim_directory="$cache_directory/tool-shims"
build_jobs="${PICFLIP_BUILD_JOBS:-${NUMBER_OF_PROCESSORS:-4}}"

mkdir -p "$source_directory" "$prefix_directory" "$tool_shim_directory" "$(dirname "$destination")"

# MSYS2 UCRT64 exposes a few binutils without the MinGW target prefix even
# though autotools and FFmpeg cross builds look for the prefixed names.
for tool in ar ranlib strip nm objdump strings dlltool windres; do
  prefixed_tool="x86_64-w64-mingw32-$tool"
  if ! command -v "$prefixed_tool" >/dev/null 2>&1 && command -v "$tool" >/dev/null 2>&1; then
    ln -sf "$(command -v "$tool")" "$tool_shim_directory/$prefixed_tool"
  fi
done
export PATH="$tool_shim_directory:$PATH"

download_and_extract() {
  local url="$1"
  local archive="$2"
  local folder="$3"
  local expected_sha256="$4"

  if [[ -d "$source_directory/$folder" ]]; then
    return
  fi

  if [[ ! -f "$source_directory/$archive" ]]; then
    curl -L --fail --retry 3 --show-error "$url" -o "$source_directory/$archive"
  fi

  local actual_sha256
  actual_sha256="$(sha256sum "$source_directory/$archive" | awk '{print $1}')"
  if [[ "$actual_sha256" != "$expected_sha256" ]]; then
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

if [[ ! -f "$prefix_directory/lib/libmp3lame.a" ]]; then
  cd "$source_directory/lame-3.100"
  make distclean >/dev/null 2>&1 || true
  CC=x86_64-w64-mingw32-gcc \
    AR=x86_64-w64-mingw32-ar \
    RANLIB=x86_64-w64-mingw32-ranlib \
    ./configure \
      --prefix="$prefix_directory" \
      --host=x86_64-w64-mingw32 \
      --disable-shared \
      --enable-static \
      --disable-frontend
  make -j"$build_jobs" || make -j1
  make install
fi

if [[ ! -f "$prefix_directory/lib/libx264.a" ]]; then
  cd "$source_directory/x264-stable"
  make distclean >/dev/null 2>&1 || true
  ./configure \
    --prefix="$prefix_directory" \
    --host=x86_64-w64-mingw32 \
    --cross-prefix=x86_64-w64-mingw32- \
    --enable-static \
    --bit-depth=8 \
    --disable-cli \
    --disable-opencl \
    --disable-asm
  make -j"$build_jobs" || make -j1
  make install
fi

cd "$source_directory/ffmpeg-8.0"
make distclean >/dev/null 2>&1 || true

export PICFLIP_CODEC_PREFIX="$prefix_directory"
chmod 755 "$project_directory/scripts/picflip-pkg-config.sh"

./configure \
  --prefix="$prefix_directory/ffmpeg" \
  --target-os=mingw32 \
  --arch=x86_64 \
  --enable-cross-compile \
  --cross-prefix=x86_64-w64-mingw32- \
  --enable-gpl \
  --enable-libmp3lame \
  --enable-libx264 \
  --pkg-config-flags="--static" \
  --pkg-config="$project_directory/scripts/picflip-pkg-config.sh" \
  --extra-cflags="-I$prefix_directory/include" \
  --extra-ldflags="-static -static-libgcc -L$prefix_directory/lib" \
  --extra-libs="-lwinpthread" \
  --disable-autodetect \
  --disable-doc \
  --disable-debug \
  --disable-x86asm \
  --disable-ffplay \
  --disable-ffprobe \
  --disable-network \
  --disable-avdevice \
  --enable-small

make -j"$build_jobs" ffmpeg || make -j1 ffmpeg
cp "$source_directory/ffmpeg-8.0/ffmpeg.exe" "$destination"

if x86_64-w64-mingw32-objdump -p "$destination" \
  | grep -Eiq 'DLL Name: (libgcc|libstdc\+\+|libwinpthread|msys|ucrt64)'; then
  echo "The Windows FFmpeg build depends on a non-system runtime DLL." >&2
  x86_64-w64-mingw32-objdump -p "$destination" | grep -i 'DLL Name:' >&2
  exit 1
fi

resources_directory="$project_directory/src-tauri/resources"
mkdir -p "$resources_directory"
cp "$source_directory/ffmpeg-8.0/COPYING.GPLv3" "$resources_directory/COPYING.GPLv3"
cp "$source_directory/lame-3.100/COPYING" "$resources_directory/COPYING.LAME"
cp "$source_directory/x264-stable/COPYING" "$resources_directory/COPYING.X264"
cp "$project_directory/THIRD_PARTY_NOTICES.md" "$resources_directory/THIRD_PARTY_NOTICES.md"

{
  echo "PicFlip Windows FFmpeg build"
  echo
  echo "FFmpeg source: ffmpeg-8.0.tar.xz"
  echo "SHA-256: b2751fccb6cc4c77708113cd78b561059b6fa904b24162fa0be2d60273d27b8e"
  echo "LAME source: lame-3.100.tar.gz"
  echo "SHA-256: ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"
  echo "x264 source: x264-stable.tar.bz2"
  echo "SHA-256: 740126cb48549ca4e2f09b4ae13beed592d5b54744044e38f28662fd96d0ba56"
  echo
  "$destination" -version
} > "$resources_directory/WINDOWS-FFMPEG-BUILD-INFO.txt"

"$destination" -hide_banner -version

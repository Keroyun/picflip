#!/bin/sh
set -eu

prefix="${PICFLIP_CODEC_PREFIX:?PICFLIP_CODEC_PREFIX is required}"
arguments=" $* "

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) thread_library="-lwinpthread" ;;
  *) thread_library="-lpthread" ;;
esac

case "$arguments" in
  *" --version "*)
    printf '%s\n' "1.9.0-picflip"
    exit 0
    ;;
esac

case "$arguments" in
  *" x264 "*)
    package="x264"
    version="0.165"
    libraries="-L$prefix/lib -lx264 $thread_library -lm"
    ;;
  *" libmp3lame "*)
    package="libmp3lame"
    version="3.100"
    libraries="-L$prefix/lib -lmp3lame -lm"
    ;;
  *)
    exit 1
    ;;
esac

case "$arguments" in
  *" --exists "*|*" --atleast-version="*) exit 0 ;;
  *" --modversion "*) printf '%s\n' "$version" ;;
  *" --cflags "*) printf '%s\n' "-I$prefix/include" ;;
  *" --libs "*) printf '%s\n' "$libraries" ;;
  *" --variable=prefix "*) printf '%s\n' "$prefix" ;;
  *" --print-errors "*) exit 0 ;;
  *)
    printf '%s\n' "$package"
    ;;
esac

# Third-party notices

PicFlip uses the following open-source components. This notice is informational and does not replace the full licenses shipped by each project.

## FFmpeg

This source-only repository does not contain an FFmpeg executable. A desktop
build can produce or obtain a separate FFmpeg 8.0 command-line executable. On
macOS it is built from source by `scripts/build-ffmpeg-macos.sh` with GPL
features enabled and with `--enable-nonfree` explicitly prohibited. LAME 3.100
provides MP3 encoding and x264 provides H.264 video encoding. The Windows share
workflow builds the same minimal profile from pinned source archives. Other
local Windows builds may use `ffmpeg-static`; `scripts/prepare-sidecar.mjs`
requires x264 and rejects unredistributable `--enable-nonfree` configurations.

- FFmpeg project and source: https://ffmpeg.org/
- Exact FFmpeg source archive: https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz
- LAME project: https://lame.sourceforge.io/
- Exact LAME source archive: https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz
- x264 project: https://code.videolan.org/videolan/x264
- x264 stable source archive: https://code.videolan.org/videolan/x264/-/archive/stable/x264-stable.tar.bz2
- ffmpeg-static: https://github.com/eugeneware/ffmpeg-static

An FFmpeg executable created by this configuration is licensed under GNU GPL
version 3 or later. Anyone distributing a PicFlip binary containing that
executable must also provide its complete corresponding FFmpeg, LAME, and x264
source, local patches and build scripts, plus the applicable license texts.

## PDF.js

PDF.js is licensed under the Apache License 2.0.

- Project: https://github.com/mozilla/pdf.js

## pdf-lib

pdf-lib is licensed under the MIT License.

- Project: https://github.com/Hopding/pdf-lib

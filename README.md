# PicFlip

PicFlip is a private, offline media conversion toolkit for Windows and macOS. It is built with Tauri 2, React, TypeScript, Rust, PDF.js, pdf-lib, and FFmpeg.

> This is the source-only GitHub edition. It does not contain an FFmpeg
> executable, an installer, build caches, generated files, or test media.

## Features

- Images: convert between PNG, JPG, WebP, ICO, BMP, and TIFF.
- Image controls: batch conversion, quality, percentage or exact resizing, aspect-ratio protection, and collision-safe output names.
- Clean Upscale: 1× cleanup, 2× enlargement, or 4× enlargement using Lanczos resampling plus mild smoothing and sharpening.
- Documents: render every page of a PDF to PNG, JPG, or WebP, or combine ordered images into one PDF.
- Audio: convert MP3, WAV, AAC, and M4A inputs to MP3, WAV, or AAC.
- Video: accept MP4, MOV, M4V, MKV, AVI, WebM, and GIF; export MP4, MOV, MKV, AVI, or GIF.
- Video controls: H.264 quality presets, original/720p/1080p/4K sizing, optional audio retention, and improved GIF palette rendering.
- Accessible display: responsive laptop layouts and an Apple-style text-size slider from 90% to 130%, available from the Settings menu and saved locally for the next launch.
- Bilingual interface: switch the complete app between English and Bahasa Melayu; the selected language is saved locally for the next launch.
- Creator details: the Settings menu includes Khairul Azhar's website and GitHub links.
- Update entry point: Settings includes a bilingual update-check button, currently showing a coming-soon message while the automatic update service is prepared.
- Privacy: no accounts, analytics, uploads, remote conversion, or network access while using the app.
- Security hardening: native commands only accept files and output folders explicitly approved through PicFlip's picker or drag-and-drop, and oversized image/PDF inputs are rejected before they can exhaust laptop memory.

Clean Upscale is a classical local enhancement filter, not generative AI. It can reduce visible blockiness and improve edge definition, but cannot reconstruct detail that does not exist in the source image.

## Development

Prerequisites:

- Node.js 20 or newer
- Rust stable
- A C compiler and `make` on macOS (used to build the redistributable FFmpeg sidecar)
- Tauri system dependencies for the operating system

Install and run:

```bash
pnpm install
pnpm run desktop:dev
```

Build a production application:

```bash
pnpm run desktop:build
```

The first macOS build downloads FFmpeg 8.0, LAME 3.100, and x264 source archives and builds a native sidecar. Later builds reuse the verified local sidecar. Windows uses the platform binary supplied by `ffmpeg-static`; the preparation script requires H.264 support and rejects any binary whose configuration contains `--enable-nonfree`.

Build each desktop target on its native operating system. The included
**Validate source** GitHub Actions workflow checks TypeScript, web assets, and
the Rust core, but deliberately does not build or publish installers. Unsigned
local builds are suitable for development and testing only.

The **Build Windows share package** workflow creates an unsigned Windows x64
NSIS installer using a minimal FFmpeg 8.0 sidecar built from pinned FFmpeg,
LAME, and x264 source archives. Its downloadable artifact also contains a
corresponding-source ZIP and a single share package that keeps the installer
and sources together. Windows SmartScreen may warn about this unsigned test
build.

Before publishing a binary, follow [RELEASING.md](RELEASING.md). Public releases
should be signed, macOS releases should be notarized, and any distributed
FFmpeg executable must be accompanied by its complete corresponding source.

## Verification

```bash
pnpm exec tsc --noEmit
pnpm run security:scan
cd src-tauri && cargo test
```

## Licensing

PicFlip's original application source is available under the
[MIT License](LICENSE). This does not relicense third-party components.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The optional FFmpeg
sidecar produced during a desktop build is a separate GPL-licensed executable.
Distributors must provide its complete corresponding source and applicable
license texts with released binaries.

## Security

PicFlip performs conversion locally and does not require media uploads. Media
files are still untrusted input, so keep PicFlip and its parsing dependencies
updated. Please read [SECURITY.md](SECURITY.md) before reporting a vulnerability.
Production builds use a restrictive Content Security Policy, remove private
build paths from packaged binaries, and pin every GitHub Action to an immutable
commit. Dependabot checks JavaScript, Rust, and Actions dependencies weekly.

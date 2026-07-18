# Release checklist

This repository is prepared for source publication. It intentionally excludes
compiled FFmpeg binaries, installers, build caches, generated files, and test
media.

## Source repository

Before pushing:

1. Confirm `git status --ignored` shows build products as ignored.
2. Run `pnpm exec tsc --noEmit` and `cargo test --locked` in `src-tauri`.
3. Scan the files selected for commit for credentials and private material.
4. Keep `LICENSE`, `THIRD_PARTY_NOTICES.md`, and the license texts in
   `src-tauri/resources/` in the repository.
5. Do not force-add anything under `src-tauri/binaries/`.

## Binary releases

Do not publish a `.app`, `.dmg`, `.exe`, `.msi`, `.zip`, or GitHub Actions
installer artifact until the binary-distribution checklist is complete.

For every build that contains FFmpeg:

1. Record the complete `ffmpeg -version` configuration output.
2. Preserve the exact FFmpeg, x264, and LAME source archives used by the build.
3. Preserve all local patches, configuration, and build scripts needed to
   rebuild the distributed FFmpeg executable.
4. Publish the corresponding-source bundle beside the binary, with clear links
   in the release notes and the applicable license texts.
5. Keep the corresponding source available for as long as the binary remains
   available.
6. Audit Windows and macOS builds separately; they may use different FFmpeg
   sources and configurations.
7. Sign public Windows installers. Sign and notarize public macOS builds.

The x264 download currently uses the upstream `stable` archive URL, but the
build script pins its SHA-256 digest. If upstream changes that archive, the
build must stop until the new source is reviewed, recorded, and intentionally
pinned.

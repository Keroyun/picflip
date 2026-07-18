import { access, chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { arch, platform } from "node:process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { sanitizeBinaryPaths } from "./sanitize-binary-paths.mjs";

const execFile = promisify(execFileCallback);
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE ?? localTargetTriple();
const windowsTarget = targetTriple.includes("windows");
const binariesDirectory = new URL("../src-tauri/binaries/", import.meta.url);
const destination = new URL(
  `ffmpeg-${targetTriple}${windowsTarget ? ".exe" : ""}`,
  binariesDirectory,
);

await mkdir(binariesDirectory, { recursive: true });

if (await isUsable(destination)) {
  await sanitizeSidecar(destination);
  await prepareLicenseNotices();
  process.stdout.write(`Using verified FFmpeg sidecar for ${targetTriple}.\n`);
  process.exit(0);
}

await rm(destination, { force: true });

if (targetTriple === "aarch64-apple-darwin" || targetTriple === "x86_64-apple-darwin") {
  if (targetTriple !== localTargetTriple()) {
    throw new Error(`Build the ${targetTriple} sidecar on a matching native macOS runner.`);
  }
  const buildScript = new URL("./build-ffmpeg-macos.sh", import.meta.url);
  await chmod(buildScript, 0o755);
  process.stdout.write(`Building a redistributable FFmpeg sidecar for ${targetTriple}…\n`);
  await execFile(fileURLToPath(buildScript), [fileURLToPath(destination)], { timeout: 30 * 60_000 });
} else {
  if (!ffmpegPath) {
    throw new Error(`No bundled FFmpeg binary is available for ${platform}/${arch}.`);
  }
  await copyFile(ffmpegPath, destination);
}

if (!windowsTarget) await chmod(destination, 0o755);

if (!(await isUsable(destination))) {
  await rm(destination, { force: true });
  throw new Error(
    "The selected FFmpeg build is missing, cannot run on this builder, or was configured with --enable-nonfree. PicFlip will not package an unredistributable build.",
  );
}

await sanitizeSidecar(destination);
await prepareLicenseNotices();
process.stdout.write(`Prepared verified FFmpeg sidecar for ${targetTriple}.\n`);

async function isUsable(binaryUrl) {
  try {
    await access(binaryUrl);
    if (!windowsTarget) await chmod(binaryUrl, 0o755);
    const binaryPath = binaryUrl instanceof URL ? fileURLToPath(binaryUrl) : binaryUrl;
    const { stdout, stderr } = await execFile(binaryPath, ["-version"], {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const version = `${stdout}\n${stderr}`;
    return version.includes("ffmpeg version")
      && version.includes("--enable-libx264")
      && !version.includes("--enable-nonfree");
  } catch {
    return false;
  }
}

async function prepareLicenseNotices() {
  const resourcesDirectory = new URL("../src-tauri/resources/", import.meta.url);
  await mkdir(resourcesDirectory, { recursive: true });
  await copyFile(
    new URL("../THIRD_PARTY_NOTICES.md", import.meta.url),
    new URL("THIRD_PARTY_NOTICES.md", resourcesDirectory),
  );
  if (targetTriple.includes("apple-darwin")) {
    const cacheArchitecture = targetTriple.startsWith("aarch64") ? "arm64" : "x86_64";
    const sourceRoot = new URL(`../src-tauri/binaries/build-cache/${cacheArchitecture}/source/`, import.meta.url);
    await copyFile(new URL("ffmpeg-8.0/COPYING.GPLv3", sourceRoot), new URL("COPYING.GPLv3", resourcesDirectory));
    await copyFile(new URL("lame-3.100/COPYING", sourceRoot), new URL("COPYING.LAME", resourcesDirectory));
    await copyFile(new URL("x264-stable/COPYING", sourceRoot), new URL("COPYING.X264", resourcesDirectory));
  } else if (process.env.PICFLIP_CUSTOM_FFMPEG_SOURCE !== "1") {
    const downloadedBinaryName = windowsTarget ? "ffmpeg.exe" : "ffmpeg";
    await copyFile(
      new URL(`../node_modules/ffmpeg-static/${downloadedBinaryName}.LICENSE`, import.meta.url),
      new URL("FFMPEG.LICENSE", resourcesDirectory),
    );
    await copyFile(
      new URL("../node_modules/ffmpeg-static/LICENSE", import.meta.url),
      new URL("FFMPEG-STATIC.LICENSE", resourcesDirectory),
    );
  }
}

async function sanitizeSidecar(binaryUrl) {
  const binaryPath = binaryUrl instanceof URL ? fileURLToPath(binaryUrl) : binaryUrl;
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
  const replacements = await sanitizeBinaryPaths(binaryPath, [repositoryRoot, homedir()]);
  if (replacements > 0) {
    process.stdout.write(`Removed ${replacements} private build-path reference(s) from the FFmpeg sidecar.\n`);
  }
  if (platform === "darwin") {
    await execFile("/usr/bin/codesign", ["--force", "--sign", "-", binaryPath], { timeout: 30_000 });
  }
}

function localTargetTriple() {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  throw new Error(`Unsupported build platform: ${platform}/${arch}`);
}

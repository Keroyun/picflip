import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const tauriCli = fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));
const separator = "\u001f";
const existingFlags = process.env.CARGO_ENCODED_RUSTFLAGS
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split(separator).filter(Boolean)
  : [];
const remapFlags = [
  `--remap-path-prefix=${repositoryRoot}=/src/picflip`,
  `--remap-path-prefix=${homedir()}=/home/builder`,
];
const runFile = promisify(execFile);
const tauriArguments = process.argv.slice(2);

const child = spawn(process.execPath, [tauriCli, ...tauriArguments], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    CARGO_ENCODED_RUSTFLAGS: [...existingFlags, ...remapFlags].join(separator),
  },
  stdio: "inherit",
});

const exitCode = await new Promise((resolve) => {
  child.once("error", (error) => {
    process.stderr.write(`Could not start the Tauri build: ${error.message}\n`);
    resolve(1);
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.stderr.write(`Tauri build stopped by ${signal}.\n`);
      resolve(1);
    } else {
      resolve(code ?? 1);
    }
  });
});

if (exitCode === 0
  && platform === "darwin"
  && tauriArguments[0] === "build"
  && !process.env.APPLE_SIGNING_IDENTITY) {
  const appBundle = fileURLToPath(new URL("../src-tauri/target/release/bundle/macos/PicFlip.app", import.meta.url));
  try {
    await access(appBundle);
    await runFile("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appBundle], {
      timeout: 60_000,
    });
    process.stdout.write("Applied a local ad-hoc signature to PicFlip.app.\n");
  } catch (error) {
    process.stderr.write(`Could not apply the local app signature: ${error.message}\n`);
    process.exitCode = 1;
  }
} else {
  process.exitCode = exitCode;
}

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const { stdout } = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  maxBuffer: 8 * 1024 * 1024,
});
const files = stdout.split("\0").filter(Boolean);
const findings = [];
const excluded = new Set(["scripts/security-scan.mjs"]);
const rules = [
  ["macOS home path", /\/Users\/[A-Za-z0-9._-]+/g],
  ["Windows home path", /[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+/g],
  ["Linux home path", /\/home\/[A-Za-z0-9._-]+/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
];

for (const file of files) {
  if (excluded.has(file) || file.startsWith("outputs/") || file.startsWith("src-tauri/target/")) continue;
  const bytes = await readFile(file);
  if (bytes.subarray(0, 8192).includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const [label, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (label === "Linux home path" && match[0] === "/home/builder") continue;
      const line = text.slice(0, match.index).split("\n").length;
      findings.push(`${file}:${line}: ${label}`);
    }
  }

  const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  for (const match of text.matchAll(emailPattern)) {
    if (/^.+@\d+x\.(?:png|jpe?g|webp)$/i.test(match[0])) continue;
    if (!match[0].toLowerCase().endsWith("@users.noreply.github.com")) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push(`${file}:${line}: personal email address`);
    }
  }
}

// GitHub Actions checks out a generated pull-request merge commit whose author
// metadata is controlled by GitHub, not by the source branch. Keep this local
// privacy check while avoiding a false positive on ephemeral CI commits.
if (!process.env.CI) {
  try {
    const { stdout: email } = await exec("git", ["log", "-1", "--format=%ae"]);
    const trimmed = email.trim().toLowerCase();
    if (trimmed && !trimmed.endsWith("@users.noreply.github.com")) {
      findings.push("git HEAD: commit author email is not a GitHub noreply address");
    }
  } catch (error) {
    findings.push(`git HEAD: could not inspect commit metadata (${error.message})`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`Security scan failed:\n${findings.map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Security scan passed for ${files.length} source files.\n`);

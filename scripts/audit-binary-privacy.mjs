import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  throw new Error("Pass at least one binary, application bundle, or package path to scan.");
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const exactNeedles = [repositoryRoot, homedir()].filter((value) => value.length >= 8);
const pathPatterns = [
  /\/Users\/[A-Za-z0-9._-]+/g,
  /[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+/g,
];
const findings = [];
let scannedFiles = 0;

for (const target of targets) await scanPath(resolve(target));

if (findings.length > 0) {
  process.stderr.write(`Binary privacy scan failed:\n${findings.map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Binary privacy scan passed for ${scannedFiles} file(s).\n`);

async function scanPath(path) {
  const details = await stat(path);
  if (details.isDirectory()) {
    for (const entry of await readdir(path)) await scanPath(resolve(path, entry));
    return;
  }
  if (!details.isFile()) return;
  scannedFiles += 1;
  const bytes = await readFile(path);
  for (const needle of exactNeedles) {
    if (bytes.includes(Buffer.from(needle))) findings.push(`${path}: contains private build path ${needle}`);
  }
  const text = bytes.toString("latin1");
  for (const pattern of pathPatterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) findings.push(`${path}: contains user home path ${match[0]}`);
  }
}

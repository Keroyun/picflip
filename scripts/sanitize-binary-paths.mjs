import { readFile, writeFile } from "node:fs/promises";

export async function sanitizeBinaryPaths(binaryPath, sensitivePrefixes) {
  let bytes = await readFile(binaryPath);
  let replacements = 0;

  for (const prefix of [...new Set(sensitivePrefixes.filter(Boolean))]) {
    const needle = Buffer.from(prefix);
    if (needle.length < 8) continue;
    const replacement = safeReplacement(prefix, needle.length);
    let offset = bytes.indexOf(needle);
    while (offset !== -1) {
      replacement.copy(bytes, offset);
      replacements += 1;
      offset = bytes.indexOf(needle, offset + needle.length);
    }
  }

  if (replacements > 0) await writeFile(binaryPath, bytes);
  return replacements;
}

function safeReplacement(original, length) {
  const windows = /^[A-Za-z]:[\\/]/.test(original);
  const prefix = windows ? "C:\\picflip\\build" : "/picflip/build";
  return Buffer.from(prefix.padEnd(length, "_").slice(0, length));
}

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export async function hashDirectory(directory, prefix = '') {
  const files = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = `${prefix}${entry.name}`;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await hashDirectory(file, `${name}/`));
    else if (entry.isFile()) {
      const bytes = await readFile(file);
      files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
    } else throw new Error(`Unexpected artifact entry: ${name}`);
  }
  return files;
}
export function buildFingerprint(files) { return sha256(JSON.stringify(files)); }

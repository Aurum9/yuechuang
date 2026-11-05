import { readdir, readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
async function entries(dir, prefix = '') {
  const files = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, await entries(`${dir}/${entry.name}`, `${name}/`));
    else files[name] = new Uint8Array(await readFile(`${dir}/${entry.name}`));
  }
  return files;
}
await mkdir('release', { recursive: true });
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid release version');
const archive = `release/reading-assistant-${manifest.version}.zip`;
await writeFile(archive, zipSync(await entries('dist')));
await copyFile('docs/安装与使用说明.md', `release/阅窗-${manifest.version}-安装与使用说明.md`);
console.log(archive);

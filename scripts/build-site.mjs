import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateManifest } from './generate-manifest.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = join(root, '_site');
const imageFolders = ['man', 'women', 'couple', 'outdoor'];

await generateManifest();
await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'images'), { recursive: true });
await cp(join(root, 'index.html'), join(output, 'index.html'));
await cp(join(root, 'images', 'manifest.json'), join(output, 'images', 'manifest.json'));
for (const folder of imageFolders) {
  await cp(join(root, 'images', folder), join(output, 'images', folder), { recursive: true });
}
await writeFile(join(output, '.nojekyll'), '', 'utf8');
console.log('Built public site in _site (delete folder excluded)');

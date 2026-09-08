import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const imagesRoot = join(root, 'images');
const catalogPath = join(imagesRoot, 'catalog.json');
const manifestPath = join(imagesRoot, 'manifest.json');
const supported = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const categories = [
  ['man', 'male', '남자 솔로'],
  ['women', 'female', '여자 솔로'],
  ['couple', 'couple', '함께'],
  ['outdoor', 'outdoor', '야외 셀프웨딩'],
];

export async function generateManifest() {
  let catalog = {};
  try { catalog = JSON.parse(await readFile(catalogPath, 'utf8')); } catch {}

  const items = [];
  for (const [folder, category, categoryLabel] of categories) {
    const folderPath = join(imagesRoot, folder);
    const entries = (await readdir(folderPath, { withFileTypes: true }))
      .filter(entry => entry.isFile() && supported.has(extname(entry.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    for (const entry of entries) {
      const absolute = join(folderPath, entry.name);
      const webPath = relative(root, absolute).split(sep).join('/');
      const meta = catalog[webPath] || {};
      const hash = createHash('sha256').update(await readFile(absolute)).digest('hex').slice(0, 10);
      items.push({
        id: items.length + 1,
        category,
        categoryLabel,
        src: `${webPath}?v=${hash}`,
        width: meta.width || 4,
        height: meta.height || 5,
        account: meta.account || '직접 추가',
        studio: meta.studio || '직접 추가한 포즈',
        source: meta.source || '',
      });
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(items)}\n`, 'utf8');
  return items;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const items = await generateManifest();
  console.log(`Generated images/manifest.json (${items.length} images)`);
}

import { createServer } from 'node:http';
import { mkdir, readFile, rename, stat, watch } from 'node:fs/promises';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateManifest, moveCatalogEntries } from './generate-manifest.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const types = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
};
const clients = new Set();
let rebuildTimer;
let suppressWatchUntil = 0;
const deleteFolder = join(root, 'images', 'delete');
await mkdir(deleteFolder, { recursive: true });

function notifyReload() {
  for (const response of clients) response.write('data: reload\n\n');
}

async function rebuildAndReload() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    await generateManifest({ includeDeleted: true });
    notifyReload();
  }, 120);
}

await generateManifest({ includeDeleted: true });
(async () => {
  try {
    for await (const event of watch(join(root, 'images'), { recursive: true })) {
      if (Date.now() >= suppressWatchUntil && event.filename && !event.filename.endsWith('manifest.json')) rebuildAndReload();
    }
  } catch (error) { console.warn('Image watcher stopped:', error.message); }
})();

createServer(async (request, response) => {
  if (request.url === '/__reload') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.write(': connected\n\n'); clients.add(response);
    request.on('close', () => clients.delete(response)); return;
  }
  if (request.method === 'DELETE' && request.url === '/__delete-image') {
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 2048) throw new Error('Request too large');
      }
      const imagesRoot = resolve(root, 'images') + sep;
      const payload = JSON.parse(raw);
      const requestedPaths = Array.isArray(payload.paths) ? payload.paths : [payload.path];
      const webPaths = [...new Set(requestedPaths.map(path => String(path || '').replaceAll('\\', '/')))];
      if (!webPaths.length || webPaths.length > 500) throw new Error('Invalid image selection');
      const targets = [];
      for (const webPath of webPaths) {
        if (!/^images\/(man|women|couple|outdoor)\/[^/]+\.(jpe?g|png|webp|gif|avif)$/i.test(webPath)) throw new Error('Invalid image path');
        const filePath = resolve(root, webPath);
        if (!filePath.startsWith(imagesRoot)) throw new Error('Invalid image path');
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error('Not a file');
        const sourceFolder = webPath.split('/')[1];
        let targetName = `${sourceFolder}--${basename(webPath)}`;
        let targetPath = join(deleteFolder, targetName);
        for (let sequence = 2; ; sequence += 1) {
          try { await stat(targetPath); targetName = `${sourceFolder}--${sequence}--${basename(webPath)}`; targetPath = join(deleteFolder, targetName); }
          catch (error) { if (error.code === 'ENOENT') break; throw error; }
        }
        targets.push({ webPath, filePath, targetPath, targetWebPath: `images/delete/${targetName}` });
      }
      suppressWatchUntil = Date.now() + 1000;
      for (const target of targets) {
        await rename(target.filePath, target.targetPath);
      }
      await moveCatalogEntries(targets.map(target => ({ from: target.webPath, to: target.targetWebPath })));
      const items = await generateManifest({ includeDeleted: true });
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: true, deleted: targets.length, count: items.length }));
      notifyReload();
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (request.method === 'POST' && request.url === '/__restore-image') {
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 2048) throw new Error('Request too large');
      }
      const payload = JSON.parse(raw);
      const webPath = String(payload.path || '').replaceAll('\\', '/');
      const folders = { male: 'man', female: 'women', couple: 'couple', outdoor: 'outdoor' };
      const targetFolder = folders[payload.category];
      if (!targetFolder || !/^images\/delete\/[^/]+\.(jpe?g|png|webp|gif|avif)$/i.test(webPath)) throw new Error('Invalid restore request');
      const sourcePath = resolve(root, webPath);
      if (!sourcePath.startsWith(resolve(root, 'images', 'delete') + sep)) throw new Error('Invalid image path');
      const info = await stat(sourcePath);
      if (!info.isFile()) throw new Error('Not a file');
      const originalName = basename(webPath).replace(/^(man|women|couple|outdoor)--(?:(?:\d+)--)?/, '');
      let targetName = originalName;
      let targetPath = join(root, 'images', targetFolder, targetName);
      for (let sequence = 2; ; sequence += 1) {
        try { await stat(targetPath); targetName = `restored-${sequence}--${originalName}`; targetPath = join(root, 'images', targetFolder, targetName); }
        catch (error) { if (error.code === 'ENOENT') break; throw error; }
      }
      const targetWebPath = `images/${targetFolder}/${targetName}`;
      suppressWatchUntil = Date.now() + 1000;
      await rename(sourcePath, targetPath);
      await moveCatalogEntries([{ from: webPath, to: targetWebPath }]);
      const items = await generateManifest({ includeDeleted: true });
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: true, path: targetWebPath, count: items.length }));
      notifyReload();
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  try {
    const requested = decodeURIComponent((request.url || '/').split('?')[0]);
    const relativePath = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    const filePath = normalize(join(root, relativePath));
    if (!filePath.startsWith(root)) throw new Error('Invalid path');
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');
    let body = await readFile(filePath);
    if (relativePath === 'index.html') {
      body = Buffer.from(body.toString('utf8')
        .replace('</head>', '<script>window.__LOCAL_DEV__=true</script></head>')
        .replace('</body>', '<script>new EventSource("/__reload").onmessage=()=>location.reload()</script></body>'));
    }
    response.writeHead(200, { 'Content-Type': types[extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Wedding Pose Atlas: http://127.0.0.1:${port}`);
  console.log('images 폴더를 수정하면 브라우저가 자동으로 새로고침됩니다.');
});

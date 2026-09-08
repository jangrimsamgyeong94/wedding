import { createServer } from 'node:http';
import { readFile, stat, unlink, watch } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateManifest, removeCatalogEntry } from './generate-manifest.mjs';

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

function notifyReload() {
  for (const response of clients) response.write('data: reload\n\n');
}

async function rebuildAndReload() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    await generateManifest();
    notifyReload();
  }, 120);
}

await generateManifest();
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
        targets.push({ webPath, filePath });
      }
      suppressWatchUntil = Date.now() + 1000;
      for (const target of targets) {
        await unlink(target.filePath);
        await removeCatalogEntry(target.webPath);
      }
      const items = await generateManifest();
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: true, deleted: targets.length, count: items.length }));
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

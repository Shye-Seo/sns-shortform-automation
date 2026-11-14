/**
 * Static preview for the built console. No dependency, no watcher: run
 * `npm run build:web` again after a change.
 *
 *   npm run dev:web      → http://127.0.0.1:4173
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const port = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const target = join(root, normalize(path).replace(/^([/\\])+/, ''));

  if (!target.startsWith(root)) {
    response.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(target);
    response.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found — run `npm run build:web` first');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`console: http://127.0.0.1:${port}`);
});

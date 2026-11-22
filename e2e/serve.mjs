/**
 * 정적 파일 서버 — 빌드된 docs/를 그대로 서빙한다(깃허브 페이지와 같은 조건).
 * E2E가 file://이 아니라 http://로 열어야 fetch·MediaRecorder 동작이 실제와 같다.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'docs');
const port = Number(process.argv[3] ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = join(root, normalize(path).replace(/^([.]{2}[/\\])+/, ''));
    const info = await stat(file).catch(() => null);
    const target = info?.isDirectory() ? join(file, 'index.html') : file;
    const body = await readFile(target);
    response.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} at http://127.0.0.1:${port}/`);
});

/**
 * Build the static demo console into `docs/`.
 *
 * Why esbuild and not a dev server: the artifact has to open from GitHub Pages
 * (and from a file path) with no build step on the viewer's machine. One bundle,
 * one stylesheet, one HTML file.
 *
 * The engine modules are imported unchanged. Four Node built-ins appear in their
 * import graph (file writers, path joins, ffmpeg spawn, randomUUID) and are
 * mapped to `web/shims/*` so the browser bundle carries the same functions the
 * worker runs for everything the console actually calls.
 */
import { build } from 'esbuild';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'docs');
const appDir = resolve(outDir, 'app');

const shim = (name) => resolve(here, 'shims', name);

await rm(appDir, { recursive: true, force: true });
await mkdir(appDir, { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: [resolve(here, 'main.tsx')],
  outfile: resolve(appDir, 'app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  alias: {
    'node:fs/promises': shim('node-fs-promises.ts'),
    'node:path': shim('node-path.ts'),
    'node:child_process': shim('node-child-process.ts'),
    'node:crypto': shim('node-crypto.ts'),
  },
  banner: {
    js: '/* sns-shortform-automation · studio & comment-coupon console · MIT */',
  },
  metafile: true,
});

await copyFile(resolve(here, 'styles.css'), resolve(appDir, 'app.css'));
await copyFile(resolve(here, 'index.html'), resolve(outDir, 'index.html'));
await writeFile(resolve(outDir, '.nojekyll'), '');

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
await writeFile(
  resolve(appDir, 'build.json'),
  `${JSON.stringify({ builtAt: new Date().toISOString(), bundleBytes: bytes }, null, 2)}\n`,
);

console.log(`docs/index.html + docs/app/app.js (${(bytes / 1024).toFixed(1)} KiB)`);

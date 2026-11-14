/**
 * Browser stub for `node:child_process`.
 *
 * ffmpeg is invoked by the render path only; the demo shows the render plan and
 * the publish queue, not a server-side encode. Calling it here is a bug, so it
 * throws.
 */
export function spawn(): never {
  throw new Error('node:child_process.spawn is not available in the browser demo (ffmpeg runs on the worker)');
}

export default { spawn };

/**
 * Browser stub for `node:fs/promises`.
 *
 * The demo bundle imports engine modules whose pure functions it uses (script
 * timeline, ducking envelope, subtitle cues). Some of those modules also expose
 * file writers and renderers that only the CLI calls. In a browser there is no
 * file system, so every entry point here fails loudly instead of silently
 * pretending the write happened.
 */
const unavailable = (name: string): never => {
  throw new Error(`node:fs/promises.${name} is not available in the browser demo`);
};

export const mkdir = async (): Promise<void> => unavailable('mkdir');
export const writeFile = async (): Promise<void> => unavailable('writeFile');
export const readFile = async (): Promise<Uint8Array> => unavailable('readFile');
export const stat = async (): Promise<unknown> => unavailable('stat');
export const rename = async (): Promise<void> => unavailable('rename');
export const unlink = async (): Promise<void> => unavailable('unlink');
export const rm = async (): Promise<void> => unavailable('rm');
export const open = async (): Promise<unknown> => unavailable('open');
export const copyFile = async (): Promise<void> => unavailable('copyFile');
export const readdir = async (): Promise<string[]> => unavailable('readdir');

export default { mkdir, writeFile, readFile, stat, rename, unlink, rm, open, copyFile, readdir };

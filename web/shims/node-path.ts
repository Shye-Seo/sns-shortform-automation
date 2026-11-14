/** Browser stub for `node:path`: the string joins the engine uses in file names. */
export function join(...parts: string[]): string {
  return parts
    .filter((part) => part !== '')
    .join('/')
    .replace(/\/+/g, '/');
}

export function dirname(input: string): string {
  const normalized = input.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '.' : normalized.slice(0, index);
}

export function basename(input: string, suffix = ''): string {
  const normalized = input.replace(/\/+$/, '');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

export function resolve(...parts: string[]): string {
  const joined = join(...parts);
  return joined.startsWith('/') ? joined : `/${joined}`;
}

export function extname(input: string): string {
  const name = basename(input);
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index);
}

export default { join, dirname, basename, resolve, extname };

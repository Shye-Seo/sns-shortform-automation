import { sha1Hex, sha256Bytes, sha256Hex } from './hash';

export function slugify(input: string, fallback = 'episode'): string {
  const ascii = input
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
    .replace(/^-|-$/g, '');
  if (ascii) return ascii;
  return `${fallback}-${sha1Hex(input).slice(0, 6)}`;
}

export function stableHash(...parts: string[]): string {
  return sha1Hex(parts.join('\u0000')).slice(0, 8);
}

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${stableHash(...parts)}`;
}

export function sha256(input: string | Uint8Array): string {
  return typeof input === 'string' ? sha256Hex(input) : sha256Bytes(input);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function nowIso(): string {
  return new Date().toISOString();
}

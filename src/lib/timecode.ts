/**
 * Timecode formatters. SRT uses a comma before milliseconds, WebVTT a dot, and
 * ASS counts hundredths of a second — all three are generated from the same
 * cue list, so a rounding drift here becomes a visible caption offset.
 */

export function pad(value: number, size = 2): string {
  return Math.floor(value).toString().padStart(size, '0');
}

export function formatSrtTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  if (ms === 1000) return `${pad(h)}:${pad(m)}:${pad(s + 1)},000`;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function formatVttTime(seconds: number): string {
  return formatSrtTime(seconds).replace(',', '.');
}

/** ASS: H:MM:SS.cc (centiseconds, truncated like libass does). */
export function formatAssTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.floor(((total - Math.floor(total)) * 1000) / 10);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

export interface ParsedTime {
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
}

export function parseSrtTime(value: string): ParsedTime | null {
  const match = value
    .trim()
    .match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return null;
  return {
    hours: Number(match[1]),
    minutes: Number(match[2]),
    seconds: Number(match[3]),
    milliseconds: Number((match[4] as string).padEnd(3, '0')),
  };
}

export function srtTimeToSeconds(value: string): number | null {
  const parsed = parseSrtTime(value);
  if (!parsed) return null;
  return parsed.hours * 3600 + parsed.minutes * 60 + parsed.seconds + parsed.milliseconds / 1000;
}

/** Centiseconds helper for ASS karaoke tags ({\kf<cs>}). */
export function toCentiseconds(seconds: number): number {
  return Math.max(1, Math.round(seconds * 100));
}

export function durationBetween(startSec: number, endSec: number): number {
  return Math.max(0, endSec - startSec);
}

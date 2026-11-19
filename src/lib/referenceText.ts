import { ShortformError } from './errors';

/**
 * Fetch a public reference (Reels/Shorts description, longform page, blog post)
 * and reduce it to readable text for the analyzer. This runs in Node only: the
 * browser console accepts pasted text because arbitrary sites do not send CORS
 * headers, and pretending otherwise would show an empty analysis.
 */

export interface ReferenceFetchResult {
  url: string;
  title: string;
  text: string;
  bytes: number;
}

function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return input
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const withoutHead = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const blockText = withoutHead
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(blockText)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return { title: title || '(제목 없음)', text };
}

export async function fetchReferenceText(url: string, timeoutMs = 15_000): Promise<ReferenceFetchResult> {
  if (!/^https?:\/\//i.test(url)) {
    throw new ShortformError('참고 URL은 http(s)로 시작해야 합니다', { code: 'VALIDATION', details: { url } });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'shortform-engine/2.0 (+https://github.com/Shye-Seo/sns-shortform-automation)',
        accept: 'text/html,text/plain;q=0.9,*/*;q=0.5',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new ShortformError(`참고 URL 응답 ${response.status}`, { code: 'EXTERNAL', details: { url } });
    }
    const contentType = response.headers.get('content-type') ?? '';
    const parsed = /html/i.test(contentType) ? htmlToText(raw) : { title: url, text: raw.trim() };
    return { url, title: parsed.title, text: parsed.text, bytes: raw.length };
  } finally {
    clearTimeout(timer);
  }
}

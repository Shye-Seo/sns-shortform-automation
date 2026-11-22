/**
 * 링크 하나로 컷 대본 만들기 — 파서 모음.
 *
 * 정적 GitHub Pages에는 서버가 없다. 그래서 가져오기 경로를 세 단계로 나눴다.
 *  1) 공개 oEmbed(유튜브): CORS가 열려 있어 브라우저에서 바로 읽힌다.
 *  2) 직접 요청(블로그 HTML/RSS): 사이트가 CORS를 열어 준 경우에만 성공한다.
 *  3) 선택형 프록시(공개 리더 프록시·사용자 워커): 2)가 막혔을 때만.
 * 셋 다 막히면 "본문 붙여넣기"로 넘긴다 — 사용자가 빈 화면을 보는 일이 없도록.
 *
 * 파서는 DOM 없이 정규식으로 동작한다. Node 테스트에서 같은 함수를 그대로
 * 돌려 HTML·RSS·마크다운 입력을 고정해 두기 위해서다.
 */

export type SourceKind = 'youtube' | 'naver-blog' | 'tistory' | 'instagram' | 'web';

export interface SourceDescriptor {
  kind: SourceKind;
  /** 정규화된 절대 URL. */
  url: string;
  host: string;
  label: string;
  videoId?: string;
  blogId?: string;
  logNo?: string;
  /** 유튜브는 oEmbed, 블로그는 RSS 후보 URL. */
  oembedUrl?: string;
  rssUrl?: string;
}

export type ProxyMode = 'none' | 'jina' | 'custom';

export const SOURCE_LABEL: Record<SourceKind, string> = {
  youtube: '유튜브',
  'naver-blog': '네이버 블로그',
  tistory: '티스토리',
  instagram: '인스타그램',
  web: '일반 웹페이지',
};

export const PROXY_PRESETS: ReadonlyArray<{ id: ProxyMode; label: string; description: string }> = [
  { id: 'none', label: '끔', description: '공개 API만 사용합니다. 막히면 붙여넣기로 넘어갑니다.' },
  {
    id: 'jina',
    label: '공개 리더 프록시',
    description: 'r.jina.ai로 본문을 읽습니다. 블로그가 CORS를 막아도 텍스트를 가져옵니다.',
  },
  { id: 'custom', label: '내 프록시', description: '직접 만든 Cloudflare Worker 주소를 앞에 붙입니다.' },
];

const YOUTUBE_PATTERN =
  /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i;

export function absoluteUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function parseSourceUrl(input: string): SourceDescriptor {
  const url = absoluteUrl(input);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'web', url, host: '', label: SOURCE_LABEL.web };
  }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  const path = parsed.pathname;

  const youtubeMatch = url.match(YOUTUBE_PATTERN);
  if (youtubeMatch && (host.endsWith('youtube.com') || host === 'youtu.be')) {
    const videoId = youtubeMatch[1]!;
    const canonical = `https://www.youtube.com/watch?v=${videoId}`;
    return {
      kind: 'youtube',
      url: canonical,
      host,
      label: SOURCE_LABEL.youtube,
      videoId,
      oembedUrl: `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`,
    };
  }

  if (host === 'blog.naver.com' || host === 'm.blog.naver.com') {
    const segments = path.split('/').filter(Boolean);
    const blogId = parsed.searchParams.get('blogId') ?? segments[0] ?? '';
    const logNo = parsed.searchParams.get('logNo') ?? segments[1] ?? '';
    return {
      kind: 'naver-blog',
      url,
      host,
      label: SOURCE_LABEL['naver-blog'],
      blogId,
      logNo,
      rssUrl: blogId !== '' ? `https://rss.blog.naver.com/${blogId}.xml` : undefined,
    };
  }

  if (host.endsWith('.tistory.com') || host === 'tistory.com') {
    return {
      kind: 'tistory',
      url,
      host,
      label: SOURCE_LABEL.tistory,
      rssUrl: `${parsed.origin}/rss`,
    };
  }

  if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
    return { kind: 'instagram', url, host, label: SOURCE_LABEL.instagram };
  }

  return { kind: 'web', url, host, label: SOURCE_LABEL.web };
}

export function proxyUrlFor(url: string, proxy: ProxyMode, customPrefix = ''): string | null {
  if (proxy === 'jina') return `https://r.jina.ai/${url}`;
  if (proxy === 'custom') {
    const prefix = customPrefix.trim();
    if (prefix === '') return null;
    // 사용자가 {url} 자리를 넣으면 그 자리에, 아니면 뒤에 붙인다.
    return prefix.includes('{url}') ? prefix.replace('{url}', encodeURIComponent(url)) : `${prefix}${url}`;
  }
  return null;
}

export interface FeedItem {
  title: string;
  link: string;
  description: string;
  imageUrl?: string;
}

export interface ParsedArticle {
  title: string;
  body: string;
  imageUrls: string[];
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function unCdata(text: string): string {
  const match = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return match ? match[1]! : text;
}

function tagText(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return '';
  return decodeHtmlEntities(unCdata(match[1]!)).trim();
}

function resolveUrl(candidate: string, baseUrl: string): string {
  const value = candidate.trim().replace(/&amp;/g, '&');
  if (value === '' || value.startsWith('data:') || value.startsWith('javascript:')) return '';
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value.startsWith('http') ? value : '';
  }
}

const IMAGE_NOISE = /(logo|icon|emoji|btn|button|banner|spacer|blank|pixel|profile|avatar|badge|sprite)/i;

function pickImages(html: string, baseUrl: string, limit = 8): string[] {
  const found: string[] = [];
  const push = (raw: string): void => {
    const url = resolveUrl(raw, baseUrl);
    if (url === '' || found.includes(url)) return;
    if (/\.(svg|gif)(\?|$)/i.test(url)) return;
    if (IMAGE_NOISE.test(url)) return;
    found.push(url);
  };

  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  const ogReversed = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  const twitter = html.match(/<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
  if (og) push(og[1]!);
  else if (ogReversed) push(ogReversed[1]!);
  if (twitter) push(twitter[1]!);

  const imgPattern = /<img\b[^>]*>/gi;
  for (const tag of html.match(imgPattern) ?? []) {
    const src = tag.match(/\b(?:data-src|data-lazy-src|src)=["']([^"']+)["']/i);
    if (!src) continue;
    const width = tag.match(/\bwidth=["']?(\d+)/i);
    const height = tag.match(/\bheight=["']?(\d+)/i);
    if (width && Number(width[1]) < 200) continue;
    if (height && Number(height[1]) < 200) continue;
    push(src[1]!);
    if (found.length >= limit) break;
  }
  return found.slice(0, limit);
}

function readableBody(html: string): string {
  let scope = html;
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const postView = html.match(/<div[^>]+id=["']postViewArea["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  const entryContent = html.match(/<div[^>]+class=["'][^"']*entry-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (article) scope = article[1]!;
  else if (postView) scope = postView[1]!;
  else if (entryContent) scope = entryContent[1]!;
  else {
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    scope = body ? body[1]! : html;
  }

  const cleaned = scope
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<figure[\s\S]*?<\/figure>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(cleaned)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line.length >= 2)
    .filter((line) => !/^(목록|이전|다음|댓글|공유|구독|로그인|카테고리|블로그 홈)$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanTitle(raw: string): string {
  return decodeHtmlEntities(raw)
    .replace(/\s*[|:·-]\s*(네이버 블로그|티스토리|TISTORY|NAVER Blog)\s*$/i, '')
    .replace(/\s*\|\s*[^|]{2,20}$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseArticleHtml(html: string, baseUrl: string): ParsedArticle {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = cleanTitle(ogTitle?.[1] ?? titleTag?.[1] ?? '');
  return {
    title,
    body: readableBody(html),
    imageUrls: pickImages(html, baseUrl),
  };
}

/**
 * r.jina.ai의 마크다운 응답. 앞머리에 Title/URL Source가 붙고, 본문은
 * "Markdown Content:" 뒤부터다.
 */
export function parseReaderMarkdown(markdown: string, baseUrl: string): ParsedArticle {
  const titleMatch = markdown.match(/^\s*Title:\s*(.+)$/m);
  const title = cleanTitle(titleMatch?.[1] ?? '');
  const contentIndex = markdown.indexOf('Markdown Content:');
  const content = contentIndex >= 0 ? markdown.slice(contentIndex + 'Markdown Content:'.length) : markdown;

  const imageUrls: string[] = [];
  for (const match of content.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
    const url = resolveUrl(match[1]!, baseUrl);
    if (url !== '' && !imageUrls.includes(url) && !IMAGE_NOISE.test(url) && !/\.(svg|gif)(\?|$)/i.test(url)) {
      imageUrls.push(url);
    }
  }

  const body = content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`>]/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 2)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, body, imageUrls: imageUrls.slice(0, 8) };
}

export function parseFeedXml(xml: string): { title: string; items: FeedItem[] } {
  const channel = xml.match(/<channel\b[^>]*>([\s\S]*?)<\/channel>/i);
  const feedTitle = channel ? tagText(channel[1]!, 'title') : tagText(xml, 'title');
  const items: FeedItem[] = [];

  const itemBlocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]!);
  const entryBlocks = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]!);
  const blocks = itemBlocks.length > 0 ? itemBlocks : entryBlocks;

  for (const block of blocks) {
    const title = tagText(block, 'title');
    let link = tagText(block, 'link');
    if (link === '') {
      const href = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      link = href ? decodeHtmlEntities(href[1]!) : '';
    }
    const rawDescription = tagText(block, 'description') || tagText(block, 'content:encoded') || tagText(block, 'summary') || tagText(block, 'content');
    const description = rawDescription.includes('<') ? stripHtml(rawDescription) : rawDescription.replace(/\s+/g, ' ').trim();
    const media = block.match(/<media:content[^>]+url=["']([^"']+)["']/i) ?? block.match(/<enclosure[^>]+url=["']([^"']+)["']/i);
    const inlineImage = rawDescription.match(/<img[^>]+src=["']([^"']+)["']/i);
    items.push({
      title,
      link,
      description,
      imageUrl: media?.[1] ?? inlineImage?.[1],
    });
  }

  return { title: cleanTitle(feedTitle), items };
}

/** 문장 단위로 쪼갠다. 한국어 종결(다./요./까?)과 줄바꿈을 모두 경계로 본다. */
export function splitSentences(text: string): string[] {
  const normalized = text
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (normalized === '') return [];

  const pieces = normalized
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((piece) => piece.replace(/^[\s·•\-–*①-⑳0-9.)]+/u, '').trim())
    .filter((piece) => piece.length >= 12)
    .filter((piece) => !/^(구독|공유|댓글|좋아요|팔로우|Copyright|ⓒ)/i.test(piece))
    .filter((piece) => !/^https?:\/\//i.test(piece));

  return [...new Set(pieces)];
}

const SENTENCE_END = /[.!?…]$/;

/** 영상에 올릴 한 줄. 문장이 길면 단어 경계에서 자르고 말줄임. */
export function captionFor(sentence: string, maxChars = 26): string {
  const clean = sentence
    .replace(/\s+/g, ' ')
    .replace(/^[\s·•\-–*]+/u, '')
    .replace(/\s*[.!?…]+$/, '')
    .trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > maxChars * 0.45 ? cut.slice(0, lastSpace) : cut;
  return `${base.trim()}…`;
}

export interface ImportedCutSpec {
  caption: string;
  note: string;
  imageUrl?: string;
  durationSec: number;
}

export interface BuildCutsInput {
  title: string;
  body: string;
  imageUrls?: readonly string[];
  maxCuts?: number;
}

/**
 * 제목 + 본문 + 사진 → 컷 목록.
 * 첫 컷은 훅(제목), 마지막 컷은 저장 유도, 가운데는 본문 문장 순서 그대로.
 */
export function buildImportedCuts(input: BuildCutsInput): ImportedCutSpec[] {
  const maxCuts = Math.max(2, input.maxCuts ?? 6);
  const images = input.imageUrls ?? [];
  const title = input.title.trim() !== '' ? input.title.trim() : '오늘의 기록';
  const sentences = splitSentences(input.body)
    .filter((sentence) => sentence !== title)
    .slice(0, Math.max(0, maxCuts - 2));

  const specs: ImportedCutSpec[] = [];
  specs.push({
    caption: captionFor(title, 24),
    note: title,
    imageUrl: images[0],
    durationSec: 2.6,
  });

  if (sentences.length > 0) {
    sentences.forEach((sentence, index) => {
      specs.push({
        caption: captionFor(sentence, 28),
        note: SENTENCE_END.test(sentence) ? sentence : `${sentence}.`,
        imageUrl: images[(index + 1) % Math.max(1, images.length)],
        durationSec: 3.2,
      });
    });
  } else {
    specs.push({
      caption: '사진으로 먼저 보여드릴게요',
      note: '올린 사진을 순서대로 배치합니다.',
      imageUrl: images[1 % Math.max(1, images.length)],
      durationSec: 3,
    });
  }

  specs.push({
    caption: '저장해두고 천천히 해보세요',
    note: '도움이 됐다면 저장해두고 하나씩 따라 해보세요.',
    imageUrl: images[Math.min(images.length - 1, 2)] || undefined,
    durationSec: 2.6,
  });

  return specs;
}

export interface ImportAttempt {
  route: 'oembed' | 'direct' | 'rss' | 'proxy';
  ok: boolean;
  detail: string;
}

export interface ImportOutcome {
  status: 'ok' | 'blocked' | 'failed';
  source: SourceDescriptor;
  title: string;
  body: string;
  imageUrls: string[];
  cuts: ImportedCutSpec[];
  via: ImportAttempt['route'] | 'none';
  attempts: ImportAttempt[];
  message: string;
}

export interface ImportOptions {
  fetchImpl?: typeof fetch;
  proxy?: ProxyMode;
  proxyPrefix?: string;
  maxCuts?: number;
}

const FETCH_TIMEOUT_MS = 12_000;

async function requestText(fetchImpl: typeof fetch, url: string): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const response = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: '',
      error: error instanceof Error ? error.message : '요청 실패',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function thinBody(body: string): boolean {
  // 두 문장 남짓이면 본문으로 본다. 그보다 짧으면 목록·안내 문구만 긁힌 것이다.
  return body.replace(/\s+/g, '').length < 80;
}

/**
 * 링크 → 컷 대본. fetch를 주입받아 테스트에서 네트워크 없이 같은 경로를 검증한다.
 */
export async function importFromUrl(input: string, options: ImportOptions = {}): Promise<ImportOutcome> {
  const fetchImpl = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
  const source = parseSourceUrl(input);
  const attempts: ImportAttempt[] = [];
  const maxCuts = options.maxCuts ?? 6;

  if (input.trim() === '') {
    return {
      status: 'failed',
      source,
      title: '',
      body: '',
      imageUrls: [],
      cuts: [],
      via: 'none',
      attempts,
      message: '링크를 입력해 주세요.',
    };
  }

  if (!fetchImpl) {
    return {
      status: 'failed',
      source,
      title: '',
      body: '',
      imageUrls: [],
      cuts: [],
      via: 'none',
      attempts,
      message: '이 브라우저에서는 가져오기를 쓸 수 없습니다. 본문을 붙여넣어 주세요.',
    };
  }

  if (source.kind === 'instagram') {
    return {
      status: 'blocked',
      source,
      title: '',
      body: '',
      imageUrls: [],
      cuts: [],
      via: 'none',
      attempts,
      message: '인스타그램은 로그인 없이 본문을 읽을 수 없습니다. 캡처 이미지와 글을 붙여넣어 주세요.',
    };
  }

  if (source.kind === 'youtube' && source.oembedUrl) {
    const result = await requestText(fetchImpl, source.oembedUrl);
    if (result.ok) {
      try {
        const meta = JSON.parse(result.text) as { title?: string; author_name?: string; thumbnail_url?: string };
        const title = (meta.title ?? '').trim();
        attempts.push({ route: 'oembed', ok: true, detail: 'oEmbed 응답을 받았습니다.' });
        const thumbnail = meta.thumbnail_url ?? (source.videoId ? `https://i.ytimg.com/vi/${source.videoId}/hqdefault.jpg` : '');
        return {
          status: 'ok',
          source,
          title,
          body: '',
          imageUrls: thumbnail ? [thumbnail] : [],
          cuts: buildImportedCuts({ title: title || '유튜브 영상', body: '', imageUrls: thumbnail ? [thumbnail] : [], maxCuts }),
          via: 'oembed',
          attempts,
          message:
            '유튜브는 제목과 썸네일만 공개 API로 가져옵니다. 영상 설명을 아래에 붙여넣으면 컷이 더 채워집니다.',
        };
      } catch {
        attempts.push({ route: 'oembed', ok: false, detail: 'oEmbed 응답을 해석하지 못했습니다.' });
      }
    } else {
      attempts.push({ route: 'oembed', ok: false, detail: result.error ?? `HTTP ${result.status}` });
    }
  }

  const direct = await requestText(fetchImpl, source.url);
  if (direct.ok && direct.text.length > 0) {
    const parsed = parseArticleHtml(direct.text, source.url);
    if (!thinBody(parsed.body)) {
      attempts.push({ route: 'direct', ok: true, detail: `본문 ${parsed.body.length}자를 읽었습니다.` });
      return {
        status: 'ok',
        source,
        title: parsed.title,
        body: parsed.body,
        imageUrls: parsed.imageUrls,
        cuts: buildImportedCuts({ title: parsed.title, body: parsed.body, imageUrls: parsed.imageUrls, maxCuts }),
        via: 'direct',
        attempts,
        message: `${source.label}에서 제목·본문·사진을 가져왔습니다.`,
      };
    }
    attempts.push({ route: 'direct', ok: false, detail: '본문이 비어 있거나 너무 짧습니다.' });
  } else {
    attempts.push({ route: 'direct', ok: false, detail: direct.error ?? `HTTP ${direct.status}` });
  }

  if (source.rssUrl) {
    const rss = await requestText(fetchImpl, source.rssUrl);
    if (rss.ok && rss.text.includes('<')) {
      const feed = parseFeedXml(rss.text);
      const first = feed.items[0];
      if (first) {
        const body = [first.description, ...feed.items.slice(1, 4).map((item) => item.title)].join('\n');
        if (!thinBody(body)) {
          attempts.push({ route: 'rss', ok: true, detail: `RSS에서 글 ${feed.items.length}개를 읽었습니다.` });
          const images = [first.imageUrl, ...feed.items.map((item) => item.imageUrl)].filter(
            (url): url is string => typeof url === 'string' && url !== '',
          );
          return {
            status: 'ok',
            source,
            title: first.title,
            body,
            imageUrls: images.slice(0, 8),
            cuts: buildImportedCuts({ title: first.title, body, imageUrls: images, maxCuts }),
            via: 'rss',
            attempts,
            message: 'RSS에서 가장 최근 글을 가져왔습니다.',
          };
        }
      }
      attempts.push({ route: 'rss', ok: false, detail: 'RSS에 읽을 만한 본문이 없습니다.' });
    } else {
      attempts.push({ route: 'rss', ok: false, detail: rss.error ?? `HTTP ${rss.status}` });
    }
  }

  const proxyUrl = proxyUrlFor(source.url, options.proxy ?? 'none', options.proxyPrefix);
  if (proxyUrl) {
    const proxied = await requestText(fetchImpl, proxyUrl);
    if (proxied.ok && proxied.text.length > 0) {
      const parsed = parseReaderMarkdown(proxied.text, source.url);
      if (!thinBody(parsed.body)) {
        attempts.push({ route: 'proxy', ok: true, detail: `프록시로 본문 ${parsed.body.length}자를 읽었습니다.` });
        return {
          status: 'ok',
          source,
          title: parsed.title,
          body: parsed.body,
          imageUrls: parsed.imageUrls,
          cuts: buildImportedCuts({ title: parsed.title, body: parsed.body, imageUrls: parsed.imageUrls, maxCuts }),
          via: 'proxy',
          attempts,
          message: '프록시를 거쳐 본문을 가져왔습니다. 사진은 보호되어 있어 직접 올려야 할 수 있습니다.',
        };
      }
      attempts.push({ route: 'proxy', ok: false, detail: '프록시 응답에 본문이 없습니다.' });
    } else {
      attempts.push({ route: 'proxy', ok: false, detail: proxied.error ?? `HTTP ${proxied.status}` });
    }
  }

  return {
    status: 'blocked',
    source,
    title: '',
    body: '',
    imageUrls: [],
    cuts: [],
    via: 'none',
    attempts,
    message:
      source.kind === 'naver-blog'
        ? '네이버 블로그는 브라우저 직접 요청을 막습니다(CORS). 본문을 붙여넣거나 프록시를 켜 주세요.'
        : '이 사이트는 브라우저에서 본문을 읽도록 허용하지 않습니다(CORS). 본문을 붙여넣어 주세요.',
  };
}

import { describe, expect, it, vi } from 'vitest';
import {
  buildImportedCuts,
  captionFor,
  decodeHtmlEntities,
  importFromUrl,
  parseArticleHtml,
  parseFeedXml,
  parseReaderMarkdown,
  parseSourceUrl,
  proxyUrlFor,
  splitSentences,
  stripHtml,
} from '../web/model/creator/importSource';

/**
 * 링크 가져오기 파서.
 *
 * 네이버·티스토리·유튜브가 실제로 돌려주는 모양(HTML/RSS/oEmbed/리더 마크다운)을
 * 고정해 두고, CORS로 막히는 경로까지 mock fetch로 확인한다.
 */

const ARTICLE_HTML = `<!doctype html>
<html><head>
<title>3평 주방 수납 정리법 : 네이버 블로그</title>
<meta property="og:title" content="3평 주방 수납 정리법" />
<meta property="og:image" content="https://postfiles.pstatic.net/MjAy/image_01.jpg?type=w800" />
</head><body>
<div id="postViewArea">
  <p>3평 주방은 수납장 문 안쪽 10cm를 먼저 봅니다.</p>
  <p>냄비 뚜껑은 문 안쪽 선반에 세워 두면 한 줄로 정리됩니다.</p>
  <p>용기 높이를 맞추면 남는 공간이 눈에 보이고, 같은 크기만 남기면 채울 곳이 줄어듭니다.</p>
  <p><img src="https://postfiles.pstatic.net/MjAy/image_02.jpg?type=w800" width="800" height="600"></p>
  <p><img src="/static/logo.png" width="60" height="20"></p>
</div>
<script>console.log('not body')</script>
</body></html>`;

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>숭구리의 기록</title>
<item>
  <title><![CDATA[3평 주방 수납 정리법]]></title>
  <link>https://blog.naver.com/shye_s/223456789</link>
  <description><![CDATA[<p>3평 주방은 수납장 문 안쪽 10cm를 먼저 봅니다.</p><p>냄비 뚜껑은 문 안쪽 선반에 세워 두면 한 줄로 정리됩니다.</p><img src="https://postfiles.pstatic.net/rss_01.jpg" />]]></description>
</item>
</channel></rss>`;

const ATOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>티스토리 글</title>
<entry>
  <title>겨울 제주 2박3일</title>
  <link href="https://example.tistory.com/12" />
  <summary>제주 동쪽은 바람이 덜 불어서 겨울에도 걷기 좋았습니다.</summary>
  <media:content url="https://blog.example.com/jeju.jpg" />
</entry>
</feed>`;

const JINA_MARKDOWN = `Title: 3평 주방 수납 정리법
URL Source: https://blog.naver.com/shye_s/223456789
Markdown Content:
# 3평 주방 수납 정리법

3평 주방은 수납장 문 안쪽 10cm를 먼저 봅니다.

![Image 1: 문 안쪽 선반](https://postfiles.pstatic.net/jina_01.jpg?type=w800)

냄비 뚜껑은 **문 안쪽 선반**에 세워 두면 한 줄로 정리됩니다.

용기 높이를 맞추면 남는 공간이 눈에 보이고, 같은 크기만 남기면 채울 곳이 줄어듭니다.

[원문 보기](https://blog.naver.com/shye_s)
`;

describe('source url 파싱', () => {
  it('유튜브 주소 세 가지 모양을 모두 같은 영상으로 읽는다', () => {
    const watch = parseSourceUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s');
    const short = parseSourceUrl('https://youtu.be/dQw4w9WgXcQ');
    const shorts = parseSourceUrl('youtube.com/shorts/dQw4w9WgXcQ');
    expect(watch.kind).toBe('youtube');
    expect(watch.videoId).toBe('dQw4w9WgXcQ');
    expect(short.videoId).toBe('dQw4w9WgXcQ');
    expect(shorts.kind).toBe('youtube');
    expect(watch.oembedUrl).toContain('youtube.com/oembed');
    expect(watch.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('네이버 블로그·티스토리·인스타를 구분하고 RSS 후보를 만든다', () => {
    const naver = parseSourceUrl('https://blog.naver.com/shye_s/223456789');
    expect(naver.kind).toBe('naver-blog');
    expect(naver.blogId).toBe('shye_s');
    expect(naver.logNo).toBe('223456789');
    expect(naver.rssUrl).toBe('https://rss.blog.naver.com/shye_s.xml');

    const tistory = parseSourceUrl('https://docu.tistory.com/12');
    expect(tistory.kind).toBe('tistory');
    expect(tistory.rssUrl).toBe('https://docu.tistory.com/rss');

    const instagram = parseSourceUrl('https://www.instagram.com/reel/CxYz123/');
    expect(instagram.kind).toBe('instagram');
  });

  it('프로토콜이 없으면 https로 붙이고, 알 수 없는 사이트는 일반 웹으로 둔다', () => {
    expect(parseSourceUrl('blog.naver.com/shye_s').url).toBe('https://blog.naver.com/shye_s');
    expect(parseSourceUrl('https://example.com/a/b').kind).toBe('web');
    expect(parseSourceUrl('').url).toBe('');
  });

  it('프록시 주소를 만든다(공개 리더·사용자 워커)', () => {
    expect(proxyUrlFor('https://blog.naver.com/a/1', 'jina')).toBe('https://r.jina.ai/https://blog.naver.com/a/1');
    expect(proxyUrlFor('https://a.com/1', 'custom', 'https://w.dev/?url=')).toBe('https://w.dev/?url=https://a.com/1');
    expect(proxyUrlFor('https://a.com/1', 'custom', 'https://w.dev/?u={url}')).toContain(encodeURIComponent('https://a.com/1'));
    expect(proxyUrlFor('https://a.com/1', 'custom', '')).toBeNull();
    expect(proxyUrlFor('https://a.com/1', 'none')).toBeNull();
  });
});

describe('HTML / RSS / 마크다운 파서', () => {
  it('HTML에서 제목·본문·사진을 뽑고 로고 이미지는 버린다', () => {
    const parsed = parseArticleHtml(ARTICLE_HTML, 'https://blog.naver.com/shye_s/223456789');
    expect(parsed.title).toBe('3평 주방 수납 정리법');
    expect(parsed.body).toContain('수납장 문 안쪽 10cm');
    expect(parsed.body).toContain('한 줄로 정리됩니다');
    expect(parsed.body).not.toContain('console.log');
    expect(parsed.imageUrls[0]).toContain('image_01.jpg');
    expect(parsed.imageUrls.some((url) => url.includes('image_02.jpg'))).toBe(true);
    expect(parsed.imageUrls.some((url) => url.includes('logo.png'))).toBe(false);
  });

  it('RSS를 읽어 최근 글과 사진을 돌려준다', () => {
    const feed = parseFeedXml(RSS_XML);
    expect(feed.title).toBe('숭구리의 기록');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.title).toBe('3평 주방 수납 정리법');
    expect(feed.items[0]!.description).toContain('냄비 뚜껑');
    expect(feed.items[0]!.imageUrl).toContain('rss_01.jpg');
  });

  it('Atom 피드도 같은 모양으로 읽는다', () => {
    const feed = parseFeedXml(ATOM_XML);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.title).toBe('겨울 제주 2박3일');
    expect(feed.items[0]!.link).toBe('https://example.tistory.com/12');
    expect(feed.items[0]!.imageUrl).toContain('jeju.jpg');
  });

  it('리더 프록시의 마크다운에서 제목·본문·사진을 뽑는다', () => {
    const parsed = parseReaderMarkdown(JINA_MARKDOWN, 'https://blog.naver.com/shye_s/223456789');
    expect(parsed.title).toBe('3평 주방 수납 정리법');
    expect(parsed.body).toContain('수납장 문 안쪽 10cm');
    expect(parsed.body).not.toContain('**');
    expect(parsed.body).not.toContain('Markdown Content');
    expect(parsed.imageUrls[0]).toContain('jina_01.jpg');
  });

  it('엔티티와 태그를 정리한다', () => {
    expect(decodeHtmlEntities('&lt;p&gt; &amp; &#39;따옴표&#39; &nbsp;')).toContain("'따옴표'");
    expect(stripHtml('<p>안녕<br>하세요</p><script>bad()</script>')).toBe('안녕 하세요');
  });
});

describe('본문 → 컷', () => {
  it('문장을 나누고 짧은 자막을 만든다', () => {
    const sentences = splitSentences(
      '3평 주방은 수납장 문 안쪽 10cm를 먼저 봅니다. 냄비 뚜껑은 문 안쪽 선반에 세워 두면 한 줄로 정리됩니다!\n용기 높이를 맞추면 남는 공간이 눈에 보입니다.',
    );
    expect(sentences).toHaveLength(3);
    expect(captionFor(sentences[1]!, 20)).toMatch(/…$/);
    expect(captionFor('짧은 문장', 20)).toBe('짧은 문장');
  });

  it('첫 컷은 제목, 마지막 컷은 저장 유도, 사진은 순서대로 붙인다', () => {
    const cuts = buildImportedCuts({
      title: '3평 주방 수납 정리법',
      body: '3평 주방은 수납장 문 안쪽 10cm를 먼저 봅니다. 냄비 뚜껑은 문 안쪽 선반에 세워 두면 한 줄로 정리됩니다.',
      imageUrls: ['https://a.com/1.jpg', 'https://a.com/2.jpg', 'https://a.com/3.jpg'],
      maxCuts: 5,
    });
    expect(cuts.length).toBe(4);
    expect(cuts[0]!.caption).toContain('3평 주방');
    expect(cuts.at(-1)!.caption).toContain('저장');
    expect(cuts[0]!.imageUrl).toBe('https://a.com/1.jpg');
    expect(cuts[1]!.imageUrl).toBe('https://a.com/2.jpg');
    expect(cuts[1]!.note.endsWith('.')).toBe(true);
  });

  it('본문이 없으면 사진 안내 컷을 넣어 빈 대본을 만들지 않는다', () => {
    const cuts = buildImportedCuts({ title: '제목만 있는 글', body: '', imageUrls: [] });
    expect(cuts.length).toBe(3);
    expect(cuts[1]!.caption).toContain('사진');
  });
});

describe('가져오기 경로', () => {
  const fetchOk = (body: string) =>
    vi.fn(async () => ({ ok: true, status: 200, text: async () => body })) as unknown as typeof fetch;

  it('유튜브는 oEmbed로 제목·썸네일을 가져온다', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          title: '부산 신혼집 3평 주방',
          author_name: '숭구리',
          thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        }),
    })) as unknown as typeof fetch;

    const outcome = await importFromUrl('https://youtu.be/dQw4w9WgXcQ', { fetchImpl });
    expect(outcome.status).toBe('ok');
    expect(outcome.via).toBe('oembed');
    expect(outcome.title).toBe('부산 신혼집 3평 주방');
    expect(outcome.imageUrls[0]).toContain('hqdefault');
    expect(outcome.cuts.length).toBeGreaterThanOrEqual(2);
    expect(outcome.message).toContain('제목과 썸네일');
  });

  it('블로그 직접 요청이 막히면 프록시로 이어서 읽는다', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://r.jina.ai/')) {
        return { ok: true, status: 200, text: async () => JINA_MARKDOWN };
      }
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const outcome = await importFromUrl('https://blog.naver.com/shye_s/223456789', { fetchImpl, proxy: 'jina' });
    expect(outcome.status).toBe('ok');
    expect(outcome.via).toBe('proxy');
    expect(outcome.body).toContain('수납장 문 안쪽');
    expect(outcome.attempts.map((attempt) => attempt.route)).toEqual(['direct', 'rss', 'proxy']);
  });

  it('직접 HTML을 읽을 수 있으면 프록시를 쓰지 않는다', async () => {
    const fetchImpl = fetchOk(ARTICLE_HTML);
    const outcome = await importFromUrl('https://docu.tistory.com/12', { fetchImpl });
    expect(outcome.status).toBe('ok');
    expect(outcome.via).toBe('direct');
    expect(outcome.cuts.length).toBeGreaterThan(2);
    expect(outcome.attempts[0]!.ok).toBe(true);
  });

  it('모든 경로가 막히면 붙여넣기로 안내한다', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const outcome = await importFromUrl('https://blog.naver.com/shye_s/223456789', { fetchImpl });
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('CORS');
    expect(outcome.cuts).toEqual([]);
  });

  it('인스타그램은 시도하지 않고 이유를 알려 준다', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const outcome = await importFromUrl('https://www.instagram.com/reel/CxYz123/', { fetchImpl });
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('로그인');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('빈 링크는 실패로 끝난다', async () => {
    const outcome = await importFromUrl('   ', {});
    expect(outcome.status).toBe('failed');
  });
});

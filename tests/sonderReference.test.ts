import { describe, expect, it } from 'vitest';
import { IDENTITY_PRESETS } from '../src/services/sonder/identity';
import { analyzeReference, oembedUrlFor, parseReferenceUrl, readOembed, splitSentences } from '../src/services/sonder/reference';
import { levelOf, medianOf, multiplierOf, summarizeVault, viralVerdict, VIRAL_THRESHOLD } from '../src/services/sonder/viral';
import type { TrendItem } from '../src/services/sonder/types';

const TRANSCRIPT = `3평 주방에서 매번 냄비를 꺼내다 부딪혔습니다.
수납장 문 안쪽 10cm를 그냥 버리고 있었거든요.
문 안쪽에 얇은 선반을 달고, 냄비 뚜껑은 같은 크기끼리 묶었습니다.
그다음 용기 높이를 맞춰서 세로로 세웠어요.
한 달 써보니 꺼내는 시간이 3초에서 1초로 줄었습니다.
오늘은 한 칸만 비워보세요. 저장해두고 천천히 해보세요.`;

describe('배수 계산', () => {
  it('중간값은 짝수 개면 가운데 두 값의 평균이다', () => {
    expect(medianOf([10, 20, 30])).toBe(20);
    expect(medianOf([10, 20, 30, 40])).toBe(25);
    expect(medianOf([])).toBe(0);
  });

  it('조회수를 평소 중간값으로 나눈 배수를 소수 둘째 자리까지 낸다', () => {
    expect(multiplierOf(82000, 19000)).toBe(4.32);
    expect(multiplierOf(0, 19000)).toBeNull();
    expect(multiplierOf(100, 0)).toBeNull();
  });

  it('3배 이상만 바이럴로 부른다', () => {
    expect(VIRAL_THRESHOLD).toBe(3);
    expect(levelOf(3)).toBe('viral');
    expect(levelOf(2.99)).toBe('above');
    expect(levelOf(1.2)).toBe('near');
    expect(levelOf(0.4)).toBe('below');
    expect(levelOf(null)).toBe('unknown');
  });

  it('판정 문장에 계산에 쓴 숫자가 들어간다', () => {
    const verdict = viralVerdict(82000, 19000);
    expect(verdict.level).toBe('viral');
    expect(verdict.note).toContain('19,000회');
    expect(verdict.note).toContain('4.3배');
  });

  it('보관함 요약은 바이럴만 따로 세고 가장 많이 쓴 훅을 고른다', () => {
    const base = { url: '', author: '', transcript: '', note: '', savedAt: '2026-11-23T00:00:00.000Z' };
    const items: TrendItem[] = [
      {
        ...base,
        id: 'a',
        title: 'A',
        views: 90000,
        medianViews: 20000,
        multiplier: 4.5,
        level: 'viral',
        structure: { hookPattern: 'numbers' } as TrendItem['structure'],
      },
      {
        ...base,
        id: 'b',
        title: 'B',
        views: 40000,
        medianViews: 20000,
        multiplier: 2,
        level: 'above',
        structure: { hookPattern: 'numbers' } as TrendItem['structure'],
      },
      {
        ...base,
        id: 'c',
        title: 'C',
        views: 20000,
        medianViews: 20000,
        multiplier: 1,
        level: 'near',
        structure: { hookPattern: 'contrarian' } as TrendItem['structure'],
      },
    ];
    const summary = summarizeVault(items);
    expect(summary.count).toBe(3);
    expect(summary.viralCount).toBe(1);
    expect(summary.avgMultiplier).toBe(2.5);
    expect(summary.topPattern).toBe('numbers');
    expect(summary.patternCounts[0]).toEqual({ pattern: 'numbers', count: 2 });
  });
});

describe('참고 영상 주소', () => {
  it('유튜브·인스타·틱톡 주소에서 id를 꺼내고 정규 주소로 바꾼다', () => {
    expect(parseReferenceUrl('https://youtu.be/abc123XYZ').canonical).toBe('https://www.youtube.com/watch?v=abc123XYZ');
    expect(parseReferenceUrl('https://www.youtube.com/shorts/abc123XYZ?si=x').platform).toBe('youtube');
    expect(parseReferenceUrl('https://www.youtube.com/watch?v=abc123XYZ&t=3').id).toBe('abc123XYZ');
    expect(parseReferenceUrl('https://www.instagram.com/reel/Cxyz123/').canonical).toBe(
      'https://www.instagram.com/reel/Cxyz123/',
    );
    expect(parseReferenceUrl('https://www.tiktok.com/@quoguri/video/7300000000000000000').platform).toBe('tiktok');
    expect(parseReferenceUrl('메모에 적은 링크 없음').platform).toBe('other');
  });

  it('공개 oEmbed가 있는 곳만 주소를 만든다', () => {
    const youtube = parseReferenceUrl('https://youtu.be/abc123XYZ');
    expect(oembedUrlFor(youtube, 'https://youtu.be/abc123XYZ')).toContain('youtube.com/oembed');
    const instagram = parseReferenceUrl('https://www.instagram.com/reel/Cxyz123/');
    expect(oembedUrlFor(instagram, 'https://www.instagram.com/reel/Cxyz123/')).toBeNull();
  });

  it('oEmbed 응답에서 제목과 작성자만 읽는다', () => {
    expect(readOembed({ title: '3평 주방 수납', author_name: '숭구리' })).toEqual({
      title: '3평 주방 수납',
      author: '숭구리',
      thumbnailUrl: '',
    });
    expect(readOembed({})).toBeNull();
    expect(readOembed('제목')).toBeNull();
  });
});

describe('구조 읽기', () => {
  it('문장을 줄바꿈과 마침표로 나누되 숫자로 시작하는 문장은 살린다', () => {
    const sentences = splitSentences('3평 주방에서 부딪혔습니다.\n\n1. 문 안쪽을 씁니다. 저장하세요!');
    expect(sentences[0]).toBe('3평 주방에서 부딪혔습니다.');
    expect(sentences[1]).toBe('문 안쪽을 씁니다.');
    expect(sentences[2]).toBe('저장하세요!');
  });

  it('자막에서 네 박자와 전환 시점을 뽑는다', () => {
    const analysis = analyzeReference({
      url: 'https://www.youtube.com/shorts/abc123XYZ',
      title: '3평 주방 수납',
      transcript: TRANSCRIPT,
      durationSec: 32,
    });
    const { structure } = analysis;
    expect(structure.durationSec).toBe(32);
    expect(structure.basis).toEqual(['title', 'transcript', 'duration']);
    expect(structure.beats).toHaveLength(4);
    expect(structure.beats[0]?.beat).toBe('hook');
    expect(structure.beats[3]?.beat).toBe('cta');
    expect(structure.transitions).toHaveLength(3);
    expect(structure.transitions[0]).toBeGreaterThan(0);
    expect(structure.transitions[2]).toBeLessThan(32);
    const ratioSum = structure.beats.reduce((sum, beat) => sum + beat.ratio, 0);
    expect(ratioSum).toBeGreaterThan(0.95);
    expect(ratioSum).toBeLessThan(1.05);
    expect(structure.cta).toContain('저장');
    expect(structure.goal).toBe('save');
    expect(structure.signals.length).toBeGreaterThanOrEqual(3);
  });

  it('첫 문장의 숫자로 숫자형 훅을 읽는다', () => {
    const { structure } = analyzeReference({ title: '3평 주방 수납', transcript: TRANSCRIPT, durationSec: 30 });
    expect(structure.hookPattern).toBe('numbers');
  });

  it('자막이 없으면 제목으로 훅만 읽고 박자는 기본 배분으로 나눈다', () => {
    const { structure } = analyzeReference({ title: '주방 수납, 왜 매번 막힐까요?', durationSec: 20 });
    expect(structure.hookPattern).toBe('question');
    expect(structure.basis).toEqual(['title', 'duration']);
    expect(structure.signals.some((signal) => signal.includes('기본 배분'))).toBe(true);
    expect(structure.beats.map((beat) => beat.beat)).toEqual(['hook', 'problem', 'solution', 'cta']);
  });

  it('제목도 자막도 없으면 구조를 만들지 않는다', () => {
    expect(() => analyzeReference({ url: 'https://youtu.be/abc123XYZ' })).toThrow(/제목이나 자막/);
  });

  it('채널 정체성 프리셋은 말투와 금지 표현을 갖고 있다', () => {
    expect(IDENTITY_PRESETS).toHaveLength(3);
    expect(IDENTITY_PRESETS[0]?.banned.length).toBeGreaterThan(0);
    expect(IDENTITY_PRESETS.every((identity) => identity.posture.length > 0)).toBe(true);
  });
});

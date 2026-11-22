import type { CreatorCut, DisclosureInfo } from './types';

/**
 * 게시물 캡션. 공정위(경제적 이해관계) 문구를 캡션에도 자동으로 넣는다.
 *
 * 영상 안에 배지를 넣는 것과 별개로, 인스타·유튜브는 "설명란에도 표기"를
 * 요구한다(공정위 추천·보증 심사지침). 그래서 같은 disclosure 문장을 여기서도
 * 쓴다 — 사용자가 두 번 쓰지 않게.
 */

export interface CaptionInput {
  cuts: readonly CreatorCut[];
  disclosure: DisclosureInfo;
  handle: string;
  hashtags?: readonly string[];
  /** 2,200자(인스타 한도)에서 자른다. */
  limit?: number;
}

export const DEFAULT_HASHTAGS = ['#숏폼', '#릴스', '#카드뉴스', '#일상기록'];

export function buildPostCaption(input: CaptionInput): string {
  const { cuts, disclosure, handle, hashtags = DEFAULT_HASHTAGS, limit = 2200 } = input;
  const hook = cuts[0]?.caption?.trim() ?? '';
  const notes = cuts
    .slice(1)
    .map((cut) => cut.note.trim())
    .filter((note) => note !== '' && note !== hook);

  const parts: string[] = [];
  if (hook !== '') parts.push(hook);
  if (notes.length > 0) {
    const body = notes.slice(0, 5).map((note) => `· ${note}`).join('\n');
    parts.push(body);
  }
  if (disclosure.sentence !== '') parts.push(disclosure.sentence);
  const tags = hashtags
    .map((tag) => tag.trim())
    .filter((tag) => tag.startsWith('#'))
    .slice(0, 30)
    .join(' ');
  if (tags !== '') parts.push(tags);
  if (handle !== '') parts.push(handle);

  const text = parts.join('\n\n');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** 해시태그 자동 제안 — 주제 단어에서 만든다. */
export function suggestHashtags(topic: string, extra: readonly string[] = []): string[] {
  const words = topic
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 2)
    .slice(0, 4)
    .map((word) => `#${word}`);
  return [...new Set([...DEFAULT_HASHTAGS, ...words, ...extra])].slice(0, 30);
}

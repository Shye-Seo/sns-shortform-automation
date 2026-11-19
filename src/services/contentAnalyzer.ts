import type { AngleId, ChannelId, ReferenceAnalysis } from '../types/plan';
import { ANGLE_BY_ID, CHANNEL_LABEL } from './patternLibrary';

/**
 * Reference analysis.
 *
 * Paste a Reels script, a Shorts title/description, a longform chapter list or
 * a blog post and this returns the structure that made it work in words we can
 * reuse: which hook style opens it, how many numbered steps it commits to,
 * where it asks for a save, and what to leave out when the same idea becomes a
 * 30-second vertical video. It reads text only — no network, no guessing from
 * a URL it cannot open.
 */

const STEP_MARKER = /^\s*(?:\d+[.)]|[①②③④⑤⑥⑦⑧⑨⑩]|[-•·*]|첫째|둘째|셋째|넷째|다섯째|여섯째|step\s?\d+|단계\s?\d+)/i;
const SAVE_WORDS = /(저장|스크랩|보관|북마크|나중에 다시|다시 보기)/g;
const SHARE_WORDS = /(공유|보내|태그|친구에게|같이 보)/g;

function squeeze(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function quote(text: string, max = 80): string {
  const clean = squeeze(text);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function stripMarkers(line: string): string {
  return line.replace(STEP_MARKER, '').replace(/^#+\s*/, '').replace(/^[^\w가-힣]+/, '').trim();
}

function detectHookAngle(hook: string, lines: string[]): AngleId | null {
  const head = `${hook} ${lines.slice(1, 3).join(' ')}`;
  if (/하지 ?마|안 됩니다|아닙니다|그만|버리|틀렸|no longer/i.test(hook)) return 'contrarian';
  if (/전\s?후|비포|애프터|달라졌|바뀐|after/i.test(head)) return 'before-after';
  if (/\?|나요|까요|왜 |어떻게 /.test(hook)) return 'problem-solve';
  if (/\d+\s?(?:가지|개|초|분|위|%|배|번|단계)|숫자/.test(hook)) return 'numbers';
  if (STEP_MARKER.test(hook) || /체크리스트|리스트|순서|준비물/.test(hook)) return 'checklist';
  if (/\d+\s?(?:가지|개|초|분)/.test(lines.join(' '))) return 'checklist';
  return null;
}

function classifyLine(line: string, index: number, total: number): { label: string; step: number } {
  if (index === 0) return { label: '훅', step: 0 };
  if (index === total - 1) return { label: 'CTA', step: index };
  if (STEP_MARKER.test(line)) return { label: '단계', step: index };
  if (/문제|이유|원인|실수|아쉬|단점/.test(line)) return { label: '문제/공감', step: index };
  return { label: '본문', step: index };
}

export function analyzeReference(text: string, channel: ChannelId = 'instagram-reels'): ReferenceAnalysis {
  const rawLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const headingLines = rawLines.filter((line) => /^#{1,6}\s/.test(line));
  const lines = rawLines.map((line) => line.replace(/^#{1,6}\s*/, '').trim()).filter(Boolean);
  const body = lines.join(' ');
  const sentences = body
    .split(/(?<=[.!?。！？])\s+|(?<=다\.)\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 4);
  const hook = lines[0] ?? '';
  const hookAngle = detectHookAngle(hook, lines);
  const stepLines = lines.filter((line) => STEP_MARKER.test(line));
  const ctaLine = lines.length > 1 ? (lines[lines.length - 1] as string) : null;

  const structure = lines.map((line, index) => {
    const { label, step } = classifyLine(line, index, lines.length);
    return { step, label, quote: quote(stripMarkers(line)) };
  });

  const saveTriggers = Array.from(new Set((body.match(SAVE_WORDS) ?? []).map((word) => word.trim())));
  const shareTriggers = Array.from(new Set((body.match(SHARE_WORDS) ?? []).map((word) => word.trim())));
  const questionCount = (body.match(/\?/g) ?? []).length;
  const numberCount = (body.match(/\d+(?:[.,]\d+)?/g) ?? []).length;
  const avgSentenceChars =
    sentences.length === 0
      ? 0
      : Math.round(sentences.reduce((sum, sentence) => sum + sentence.length, 0) / sentences.length);

  const titlePatterns = Array.from(
    new Set(
      [...headingLines.map((line) => line.replace(/^#+\s*/, '')), hook]
        .filter((line) => line.length > 0)
        .filter((line) => /\d|후기|정리|조건|방법|비교|추천|이유|체크/.test(line))
        .map((line) => quote(line, 50)),
    ),
  ).slice(0, 4);

  const advice: string[] = [];
  const channelLabel = CHANNEL_LABEL[channel];

  if (hookAngle) {
    advice.push(
      `첫 줄이 «${ANGLE_BY_ID[hookAngle].label}» 훅입니다. 이 주제도 같은 앵글로 열면 이탈 지점이 같습니다.`,
    );
  } else {
    advice.push('첫 줄에서 훅 유형이 뚜렷하지 않습니다. 질문·숫자·결과 중 하나로 다시 써야 합니다.');
  }
  if (stepLines.length >= 2) {
    advice.push(
      `번호가 붙은 단계 ${stepLines.length}개 — 숏폼은 앞의 ${Math.min(3, stepLines.length)}개만 쓰고, 나머지는 롱폼 챕터와 블로그 소제목으로 넘깁니다.`,
    );
  }
  if (saveTriggers.length > 0) {
    advice.push(
      `저장 유도가 ${saveTriggers.length}번 나옵니다. 숏폼에서는 CTA 앞에 한 번만 두고, 블로그에는 «스크랩» 문장으로 옮깁니다.`,
    );
  }
  if (shareTriggers.length > 0) {
    advice.push(`공유 유도(${shareTriggers.join(', ')})는 릴스 DM 공유용으로만 남기고 쇼츠에서는 빼는 편이 자연스럽습니다.`);
  }
  if (avgSentenceChars > 45) {
    advice.push(`문장이 평균 ${avgSentenceChars}자로 깁니다. 숏폼 자막은 30자 안쪽으로 끊어야 한 줄에 들어옵니다.`);
  }
  if (numberCount === 0) {
    advice.push('숫자가 하나도 없습니다. 제목에 개수나 시간을 넣으면 클릭 이유가 생깁니다.');
  } else if (numberCount >= 3) {
    advice.push(`숫자 ${numberCount}개 — 그중 하나만 남겨 훅에 쓰고, 나머지는 본문 근거로 내립니다.`);
  }
  if (channel === 'naver-blog' || channel === 'tistory' || channel === 'wordpress') {
    advice.push(
      `${channelLabel} 레퍼런스: 소제목 ${headingLines.length}개, 평균 문장 ${avgSentenceChars}자. 같은 소제목 순서를 블로그 뼈대에 그대로 씁니다.`,
    );
  } else {
    advice.push(`${channelLabel} 레퍼런스: ${structure.length}개 문장 블록을 4비트(훅·문제·해결·CTA)로 접습니다.`);
  }

  const signals = [
    hook.length > 0,
    stepLines.length > 0,
    saveTriggers.length > 0 || shareTriggers.length > 0,
    ctaLine !== null,
    numberCount > 0,
    lines.length >= 4,
  ].filter(Boolean).length;

  return {
    channel,
    charCount: body.length,
    lineCount: lines.length,
    sentenceCount: sentences.length,
    avgSentenceChars,
    hookQuote: quote(hook),
    hookStyle: hookAngle ? ANGLE_BY_ID[hookAngle].hookStyle : '판별 불가',
    hookAngle,
    structure: structure.slice(0, 12),
    numberedSteps: stepLines.length,
    questionCount,
    numberCount,
    saveTriggers,
    shareTriggers,
    ctaQuote: ctaLine ? quote(stripMarkers(ctaLine)) : null,
    titlePatterns,
    advice,
    confidence: Math.round((signals / 6) * 100) / 100,
  };
}

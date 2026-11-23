/**
 * 채널 정체성(voice.md).
 *
 * 계정마다 말투·타깃·고정 강점·금지 표현을 따로 둔다. 기획안은 이 값을 실제로
 * 읽어서 후킹 문장을 고르고, 금지 표현을 검사하고, 캡션 끝에 시그니처를 붙인다.
 * 프리셋은 승혜 님의 세 계정을 기준으로 둔 시작점이고, 화면에서 고치거나 새로
 * 만들 수 있다.
 */
import { sonderId, type ChannelIdentity, type IdentityDraft } from './types';

export const IDENTITY_STORAGE_KEY = 'shortform.sonder.identity.v1';

const now = (): string => new Date().toISOString();

export const IDENTITY_PRESETS: ChannelIdentity[] = [
  {
    id: 'identity_living',
    name: '일상·리빙',
    handle: '@shye__s',
    posture: '부산 신혼집 살림을 직접 해보고 남는 것만 기록하는 계정',
    audience: '결혼 1~3년 차, 집 꾸미기와 살림을 막 시작한 2030',
    voice: '문장은 짧게 끊고, 숫자와 실제로 써 본 기간을 먼저 말한다. 감탄 대신 시행착오를 그대로 적는다.',
    strengths: ['3평 주방 실측 수납', '한 달 써 보고 남긴 것만 소개', '가격과 교체 주기까지 적기'],
    banned: ['완벽', '무조건', '역대급', '인생템'],
    signature: ['오늘도 하나만 남기고 갑니다'],
    updatedAt: '2026-11-23T00:00:00.000Z',
  },
  {
    id: 'identity_travel',
    name: '여행·빈티지 디카',
    handle: '@ddung_guri',
    posture: '빈티지 디카로 부산과 제주 동네를 걷는 기록',
    audience: '필름 감성 사진을 찾는 2030, 주말에 동네 한 바퀴 도는 사람',
    voice: '장면을 먼저 보여 주고 정보는 한 줄로 붙인다. 감정어는 아끼고, 이동 시간과 요금은 정확히 적는다.',
    strengths: ['디카 원본 색 그대로', '골목 단위 동선', '이동 시간·입장료 표기'],
    banned: ['핫플', '인생샷', '무조건 가야'],
    signature: ['필름 한 롤, 하루 한 동네'],
    updatedAt: '2026-11-23T00:00:00.000Z',
  },
  {
    id: 'identity_tech',
    name: '테크·브랜딩 (quoguri)',
    handle: 'quoguri',
    posture: '직접 만든 자동화 도구를 개발자 관점에서 검증해 공유하는 계정',
    audience: '혼자 콘텐츠를 운영하는 1인 크리에이터와 주니어 개발자',
    voice: '결론을 먼저 쓰고 근거는 수치와 재현 절차로 붙인다. 형용사 대신 화면과 코드로 말한다.',
    strengths: ['직접 써 본 도구만 다룸', '그대로 따라 할 수 있는 설정', '실패한 방법도 같이 기록'],
    banned: ['혁신적', '압도적', 'AI가 다 해줍니다'],
    signature: ['코드와 화면으로 확인한 것만 말합니다'],
    updatedAt: '2026-11-23T00:00:00.000Z',
  },
];

/**
 * 기획 문장에서 걷어내는 상투어. 채널의 금지 표현과 별개로, 어느 채널이든
 * 숏폼 대본에서 힘이 빠지는 말들이다. 대체어가 있으면 바꾸고, 없으면 지운다.
 */
const HYPE_REPLACEMENTS: Array<{ pattern: RegExp; replace: string }> = [
  { pattern: /완벽(한|하게|히)?/g, replace: '쓸 만한' },
  { pattern: /무조건/g, replace: '대부분' },
  { pattern: /역대급/g, replace: '꽤 큰' },
  { pattern: /인생템/g, replace: '오래 쓴 물건' },
  { pattern: /혁신적(인)?/g, replace: '새로운' },
  { pattern: /압도적(인)?/g, replace: '눈에 띄는' },
  { pattern: /핫플/g, replace: '사람이 몰리는 곳' },
  { pattern: /인생샷/g, replace: '건진 사진' },
];

export function emptyIdentity(): IdentityDraft {
  return {
    name: '',
    handle: '',
    posture: '',
    audience: '',
    voice: '',
    strengths: [],
    banned: [],
    signature: [],
  };
}

const cleanList = (values: string[] | undefined): string[] =>
  (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, 12);

/** 화면·API 어디서 들어와도 같은 모양이 되게 만든다. */
export function normalizeIdentity(draft: IdentityDraft): ChannelIdentity {
  const name = (draft.name ?? '').trim().slice(0, 40);
  if (name.length === 0) throw new Error('채널 이름을 넣어 주세요');
  return {
    id: draft.id && draft.id.trim().length > 0 ? draft.id.trim() : sonderId('identity'),
    name,
    handle: (draft.handle ?? '').trim().slice(0, 40),
    posture: (draft.posture ?? '').trim().slice(0, 160),
    audience: (draft.audience ?? '').trim().slice(0, 160),
    voice: (draft.voice ?? '').trim().slice(0, 400),
    strengths: cleanList(draft.strengths),
    banned: cleanList(draft.banned),
    signature: cleanList(draft.signature),
    updatedAt: now(),
  };
}

/**
 * 문장에서 상투어를 걷어낸다. 금지 표현을 지우기만 하면 문장이 끊기므로,
 * 뜻이 통하는 대체어가 있는 것만 바꾸고 나머지는 검사 결과로 남긴다.
 */
export function applyVoice(text: string): string {
  let next = text;
  for (const rule of HYPE_REPLACEMENTS) {
    next = next.replace(rule.pattern, rule.replace);
  }
  return next.replace(/\s{2,}/g, ' ').trim();
}

/** 대본·캡션에 실제로 들어간 금지 표현만 찾는다. */
export function findBanned(text: string, banned: string[]): string[] {
  const hits: string[] = [];
  for (const word of banned) {
    const needle = word.trim();
    if (needle.length === 0) continue;
    if (text.includes(needle) && !hits.includes(needle)) hits.push(needle);
  }
  return hits;
}

/** 계정별 voice.md — 사람이 읽고 다른 도구에도 붙여 넣을 수 있는 형태. */
export function renderVoiceDoc(identity: ChannelIdentity): string {
  const lines: string[] = [
    `# ${identity.name}${identity.handle ? ` (${identity.handle})` : ''}`,
    '',
    identity.posture ? `> ${identity.posture}` : '> 한 줄 정체성을 아직 정하지 않았습니다.',
    '',
    '## 타깃',
    identity.audience || '- 아직 정하지 않았습니다.',
    '',
    '## 말투',
    identity.voice || '- 아직 정하지 않았습니다.',
    '',
    '## 고정 강점',
    ...(identity.strengths.length > 0 ? identity.strengths.map((item) => `- ${item}`) : ['- 없음']),
    '',
    '## 쓰지 않는 표현',
    ...(identity.banned.length > 0 ? identity.banned.map((item) => `- ${item}`) : ['- 없음']),
    '',
    '## 캡션 마무리',
    ...(identity.signature.length > 0 ? identity.signature.map((item) => `- ${item}`) : ['- 없음']),
  ];
  return `${lines.join('\n')}\n`;
}

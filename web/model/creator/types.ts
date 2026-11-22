/**
 * 실사용 스튜디오의 데이터 모델.
 *
 * 이 모델은 "엔진이 계산한 텍스트"가 아니라 "사용자가 실제로 넣은 사진·영상"을
 * 다룬다. 컷 하나가 곧 프레임 하나이고, 렌더러(MediaRecorder)와 카드뉴스
 * 렌더러가 같은 컷 배열을 읽으므로 영상과 카드뉴스가 서로 다른 말을 하지 않는다.
 */

export type MediaKind = 'image' | 'video' | 'placeholder';

/** Ken Burns(켄 번스) 효과 — 정지 사진에 움직임을 주는 네 가지 방식. */
export type KenBurns = 'none' | 'in' | 'out' | 'left' | 'right';

export type CaptionPosition = 'top' | 'middle' | 'bottom';

/** 자막 배경: 어두운 박스 / 폭 전체 띠 / 외곽선만. */
export type CaptionBackground = 'solid' | 'band' | 'outline';

/** 컷 전환: 부드럽게 겹치기 / 바로 자르기 / 옆에서 밀기. */
export type Transition = 'fade' | 'cut' | 'slide';

export type Disclosure = 'none' | 'self' | 'sponsored' | 'paid' | 'coupang';

export interface CreatorCut {
  id: string;
  kind: MediaKind;
  /** 업로드 파일의 object URL 또는 원격 이미지 URL. placeholder면 빈 문자열. */
  src: string;
  /** 사용자가 알아볼 이름(파일명). */
  name: string;
  width: number;
  height: number;
  /** 이 컷이 화면에 머무는 시간. */
  durationSec: number;
  kenBurns: KenBurns;
  /** 영상에 크게 올라가는 한 줄. */
  caption: string;
  /** 카드뉴스 본문으로 쓰는 설명. */
  note: string;
  captionPosition: CaptionPosition;
  captionBackground: CaptionBackground;
  transition: Transition;
  /** 미디어가 없을 때 칠하는 그라데이션 시작색. */
  accent: string;
  /** 업로드한 영상의 원본 길이(초). 정지 이미지면 undefined. */
  videoDurationSec?: number;
  /** 영상에서 쓰기 시작할 지점(초). */
  trimStartSec?: number;
  /** 이 컷을 만든 출처: 직접 올림 / 링크 가져오기 / 주제 엔진. */
  origin: 'upload' | 'url' | 'topic' | 'sample';
  /** 영상 컷 목록에 보여 줄 첫 프레임(data URL). */
  poster?: string;
}

export interface DisclosureInfo {
  id: Disclosure;
  label: string;
  /** 영상·카드에 붙는 짧은 표기. */
  badge: string;
  /** 캡션·카드 하단에 그대로 쓰는 문장. */
  sentence: string;
}

export const DISCLOSURES: readonly DisclosureInfo[] = [
  { id: 'none', label: '없음', badge: '', sentence: '' },
  { id: 'self', label: '내돈내산', badge: '#내돈내산', sentence: '이 콘텐츠는 제가 직접 구매한 제품으로 만들었습니다.' },
  { id: 'sponsored', label: '제품협찬', badge: '#제품협찬', sentence: '이 콘텐츠는 업체로부터 제품을 제공받아 작성했습니다.' },
  { id: 'paid', label: '원고료', badge: '#원고료', sentence: '이 콘텐츠는 업체로부터 원고료를 받고 작성했습니다.' },
  {
    id: 'coupang',
    label: '쿠팡파트너스',
    badge: '#쿠팡파트너스',
    sentence: '이 콘텐츠는 쿠팡파트너스 활동의 일환으로 수수료를 받을 수 있습니다.',
  },
];

export function disclosureOf(id: Disclosure): DisclosureInfo {
  return DISCLOSURES.find((item) => item.id === id) ?? DISCLOSURES[0]!;
}

export const CAPTION_POSITION_LABEL: Record<CaptionPosition, string> = {
  top: '위',
  middle: '가운데',
  bottom: '아래',
};

export const CAPTION_BACKGROUND_LABEL: Record<CaptionBackground, string> = {
  solid: '어두운 박스',
  band: '띠',
  outline: '외곽선',
};

export const KEN_BURNS_LABEL: Record<KenBurns, string> = {
  none: '고정',
  in: '천천히 확대',
  out: '천천히 축소',
  left: '왼쪽으로',
  right: '오른쪽으로',
};

export const TRANSITION_LABEL: Record<Transition, string> = {
  fade: '겹쳐 넘김',
  cut: '바로 자름',
  slide: '옆에서 밀기',
};

const ACCENTS = ['#2f5fa8', '#1f7a68', '#8a4f9e', '#a8622f', '#3c6f9c', '#7a6a2f'];

let sequence = 0;

/** 고유 id. crypto.randomUUID는 file://에서도 동작하지만 구형 사파리를 위해 fallback. */
export function newCutId(prefix = 'cut'): string {
  sequence += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${sequence}-${random}`;
}

export interface NewCutInput {
  kind?: MediaKind;
  src?: string;
  name?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  caption?: string;
  note?: string;
  origin?: CreatorCut['origin'];
  videoDurationSec?: number;
  accent?: string;
  poster?: string;
}

export function makeCut(input: NewCutInput = {}): CreatorCut {
  const index = sequence;
  return {
    id: newCutId(),
    kind: input.kind ?? 'placeholder',
    src: input.src ?? '',
    name: input.name ?? '빈 컷',
    width: input.width ?? 1080,
    height: input.height ?? 1920,
    durationSec: Math.min(15, Math.max(0.5, input.durationSec ?? 3)),
    kenBurns: 'in',
    caption: input.caption ?? '',
    note: input.note ?? '',
    captionPosition: 'bottom',
    captionBackground: 'solid',
    transition: 'fade',
    accent: input.accent ?? ACCENTS[index % ACCENTS.length]!,
    videoDurationSec: input.videoDurationSec,
    trimStartSec: 0,
    origin: input.origin ?? 'upload',
    poster: input.poster,
  };
}

/** 새 프로젝트를 열었을 때 보이는 기본 컷 — 빈 화면 대신 바로 만져볼 수 있게. */
export function sampleCuts(): CreatorCut[] {
  const specs: Array<{ caption: string; note: string; accent: string }> = [
    { caption: '3평 주방, 이렇게 바꿨어요', note: '부산 신혼집 3평 주방. 수납장 문턱부터 정리했습니다.', accent: '#2f5fa8' },
    { caption: '문 안쪽 10cm를 씁니다', note: '문 안쪽에 얇은 선반을 달면 냄비 뚜껑이 한 줄로 들어갑니다.', accent: '#1f7a68' },
    { caption: '같은 크기로 맞춰 담기', note: '용기 높이를 맞추면 남는 공간이 눈에 보입니다.', accent: '#8a4f9e' },
    { caption: '저장해두고 천천히 해보세요', note: '오늘은 한 칸만 비워도 충분합니다.', accent: '#a8622f' },
  ];
  return specs.map((spec, index) =>
    makeCut({
      kind: 'placeholder',
      name: `샘플 컷 ${index + 1}`,
      caption: spec.caption,
      note: spec.note,
      durationSec: 3,
      origin: 'sample',
      accent: spec.accent,
    }),
  );
}

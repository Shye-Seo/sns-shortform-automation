/**
 * Sonder식 기획 루프의 데이터 모델.
 *
 * 이 루프는 세 단계다.
 *  1) 채널 정체성 — 이 계정이 어떤 말투로, 누구에게, 무엇을 반복해서 말하는가.
 *  2) 트렌드 보관함 — 참고 영상이 평소보다 몇 배 터졌는지(배수)와, 그 영상이 쓴
 *     구조(훅 패턴·박자·전환 시점·CTA)를 남긴다.
 *  3) 합체 기획안 — 빌린 구조에 내 말투를 얹어 후킹 3안·컷별 자막·박자표·캡션을
 *     만들고, 올린 뒤의 성과를 다시 1)과 3)의 입력으로 돌려준다.
 *
 * 여기에는 계산이 없다. 계산은 `viral.ts`·`reference.ts`·`planner.ts`·
 * `performance.ts`가 하고, 이 파일은 그 사이에서 오가는 모양만 정한다.
 */

/** 대본의 네 박자. `src/services/scriptEngine`의 Beat와 같은 이름을 쓴다. */
export type BeatKey = 'hook' | 'problem' | 'solution' | 'cta';

/** 참고 영상의 첫 문장이 어떤 방식으로 시선을 잡았는가. */
export type HookPattern = 'question' | 'numbers' | 'howto' | 'contrarian' | 'story';

/** 마지막 문장이 요구한 행동. 대본의 CTA 목표로 그대로 넘긴다. */
export type PlanGoal = 'save' | 'comment' | 'follow' | 'link';

export const HOOK_PATTERN_LABEL: Record<HookPattern, string> = {
  question: '질문형',
  numbers: '숫자형',
  howto: '방법형',
  contrarian: '역발상형',
  story: '이야기형',
};

export const PLAN_GOAL_LABEL: Record<PlanGoal, string> = {
  save: '저장',
  comment: '댓글',
  follow: '팔로우',
  link: '링크',
};

export interface ChannelIdentity {
  id: string;
  /** 계정 이름. 목록과 기획안에 이 이름으로 나온다. */
  name: string;
  /** 핸들(@shye__s). 비어 있어도 된다. */
  handle: string;
  /** 한 줄 정체성 — "부산 신혼집 살림을 직접 해보고 남는 것만 기록". */
  posture: string;
  /** 누구에게 말하는가. */
  audience: string;
  /** 말투 규칙 — 문장 길이, 숫자를 쓰는 방식, 감정어를 아끼는 정도. */
  voice: string;
  /** 반복해서 말해도 되는 고정 강점. */
  strengths: string[];
  /** 쓰지 않기로 한 표현. 대본·캡션에서 검사한다. */
  banned: string[];
  /** 캡션 마지막에 붙는 한 줄. */
  signature: string[];
  updatedAt: string;
}

/** 저장 전 입력. id가 있으면 그 채널을 고치고, 없으면 새로 만든다. */
export interface IdentityDraft {
  id?: string;
  name: string;
  handle?: string;
  posture?: string;
  audience?: string;
  voice?: string;
  strengths?: string[];
  banned?: string[];
  signature?: string[];
}

export type ViralLevel = 'viral' | 'above' | 'near' | 'below' | 'unknown';

export interface ViralVerdict {
  views: number;
  medianViews: number;
  /** 조회수 ÷ 평소 중간값. 계산할 수 없으면 null. */
  multiplier: number | null;
  level: ViralLevel;
  label: string;
  /** 판정을 그렇게 읽은 이유 한 줄. */
  note: string;
}

export interface BorrowedBeat {
  beat: BeatKey;
  label: string;
  /** 참고 영상에서 이 구간이 맡은 일. */
  intent: string;
  startSec: number;
  endSec: number;
  /** 전체 길이에서 차지하는 비율(0~1). */
  ratio: number;
}

export interface BorrowedStructure {
  /** 첫 문장의 패턴. 기획안의 훅 앵글을 고르는 데 쓴다. */
  hookPattern: HookPattern;
  hookLine: string;
  beats: BorrowedBeat[];
  /** 박자가 바뀌는 시점(초). 훅→문제, 문제→해결, 해결→마무리. */
  transitions: number[];
  cta: string;
  /** 마지막 문장이 요구한 행동. 읽지 못하면 null. */
  goal: PlanGoal | null;
  /** 초당 음절. 빠른 편인지 느린 편인지 판단하는 값. */
  pace: number;
  durationSec: number;
  /** 어디를 보고 그렇게 읽었는지. 화면에 근거로 그대로 보여 준다. */
  signals: string[];
  /** 제목·자막·길이 중 무엇으로 계산했는지. */
  basis: Array<'title' | 'transcript' | 'duration'>;
}

export interface TrendItem {
  id: string;
  url: string;
  title: string;
  author: string;
  transcript: string;
  views: number;
  medianViews: number;
  multiplier: number | null;
  level: ViralLevel;
  structure: BorrowedStructure;
  note: string;
  savedAt: string;
}

export type HookId = 'A' | 'B' | 'C';

export interface PlanHook {
  id: HookId;
  pattern: HookPattern;
  text: string;
  /** 이 안을 왜 이렇게 썼는지. */
  reason: string;
}

export interface PlanScene {
  beat: BeatKey;
  label: string;
  startSec: number;
  endSec: number;
  narration: string;
  /** 화면에 올리는 자막 한 줄. */
  caption: string;
}

export interface BeatComparison {
  beat: BeatKey;
  label: string;
  borrowedRatio: number;
  planRatio: number;
  borrowedSec: number;
  planSec: number;
  deltaSec: number;
}

export interface PlanCheck {
  bannedHits: string[];
  hookSec: number;
  totalSec: number;
  /** 빌린 박자와 이 대본의 차이 중 눈에 띄는 것. */
  rhythmNotes: string[];
}

export interface ContentPlan {
  id: string;
  topic: string;
  identityId: string;
  identityName: string;
  trendId: string | null;
  trendTitle: string;
  goal: PlanGoal;
  structure: BorrowedStructure;
  hooks: PlanHook[];
  chosenHook: HookId;
  scenes: PlanScene[];
  beatTable: BeatComparison[];
  caption: string;
  hashtags: string[];
  checks: PlanCheck;
  notes: string[];
  /** 대본을 만든 주체. 'rules'는 내장 문장 엔진이다. */
  source: 'rules' | 'openai' | 'anthropic';
  createdAt: string;
}

export interface PerformanceLog {
  id: string;
  planId: string | null;
  title: string;
  hookPattern: HookPattern;
  /** 올린 날짜(YYYY-MM-DD). */
  postedAt: string;
  views: number;
  saves: number;
  shares: number;
  follows: number;
  /** 그때 그 계정의 평소 조회수 중간값. 배수를 다시 계산하는 데 쓴다. */
  medianViews: number;
  multiplier: number | null;
  createdAt: string;
}

export interface PatternRow {
  pattern: HookPattern;
  count: number;
  /** 저장 ÷ 조회수 평균(가중). */
  saveRate: number;
  avgMultiplier: number | null;
}

export interface PerformanceSummary {
  count: number;
  views: number;
  saves: number;
  shares: number;
  saveRate: number;
  avgMultiplier: number | null;
  viralCount: number;
  bestPattern: HookPattern | null;
  patternRows: PatternRow[];
  /** 다음 기획안에 그대로 보여 줄 한 줄들. */
  notes: string[];
}

/** 저장된 항목의 id. crypto.randomUUID가 없는 환경(구형 사파리)도 있다. */
export function sonderId(prefix: string): string {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${random}`;
}

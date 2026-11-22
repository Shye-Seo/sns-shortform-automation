import type { AngleId } from '../types/plan';
import type { CtaGoal } from '../types/script';

/**
 * 도메인 문장 은행의 형태.
 *
 * 문장 슬롯
 *   {n}/{n은}/{n이}/{n을}/{n과}/{n도}  주제의 짧은 이름(조사 포함)
 *   {p}/{p은}/{p도}                    장소
 *   {d}                                도메인의 핵심 변수("이동 동선")
 *   {persona}                          사람 묘사("퇴사한 30대 개발자")
 *
 * 규칙: 해결 단계는 "바로 촬영할 수 있는 행동"이어야 한다. "기준을 하나로
 * 줄이세요" 같은 문장은 어느 도메인에나 붙는 말이라 여기에 쓰지 않는다.
 */
export interface ScriptDomainBank {
  /** 앵글별 훅. 앞의 두 개가 기본이고, 변주가 돌면 순서대로 돈다. */
  hooks: Record<AngleId, string[]>;
  problems: string[];
  steps: string[];
  ctas: Record<CtaGoal, string[]>;
  screens: { hook: string[]; problem: string[]; step: string[]; cta: string[] };
  visuals: string[];
}

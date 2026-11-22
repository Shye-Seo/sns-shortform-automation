import { SPEECH_RATE } from '../lib/text';
import type { Angle } from '../types/plan';
import type { CtaGoal, Language } from '../types/script';
import type { ScriptDomainProfile } from './scriptDomains';

/**
 * 사용자가 직접 연결한 LLM(OpenAI·Anthropic)에 보내는 대본 요청.
 *
 * 내장 엔진과 같은 계약을 쓴다: 훅은 3.5초 안에, 해결 단계는 바로 촬영할 수 있는
 * 행동, 마지막은 유도 하나. 다른 점은 **그 주제의 실제 확인 포인트를 프롬프트에
 * 넣는다**는 것이다. 그러지 않으면 모델이 "기준을 하나로 줄이세요" 같은 어느
 * 주제에나 붙는 문장을 돌려준다.
 *
 * 이 파일은 브라우저 번들에서도 쓰이므로 Node 전용 모듈을 import하지 않는다.
 */

export interface AiPromptInput {
  topic: string;
  durationSec: number;
  language: Language;
  angle?: Angle;
  ctaGoal?: CtaGoal;
  domain: ScriptDomainProfile;
}

export interface AiPrompt {
  system: string;
  user: string;
}

const CTA_GOAL_KO: Record<CtaGoal, string> = {
  save: '저장',
  comment: '댓글',
  follow: '팔로우',
  link: '프로필 링크',
};

export function buildAiScriptPrompt(input: AiPromptInput): AiPrompt {
  const { topic, durationSec, language, domain } = input;
  const ko = language === 'ko';
  const syllablesPerSecond = SPEECH_RATE[language].syllablesPerSecond;
  // 훅 3.5초, 장면 사이 여백을 뺀 실제 발화 예산.
  const capacity = Math.floor((durationSec - 2.2) * syllablesPerSecond);
  const pack = domain.knowledge?.pack ?? null;

  const system = ko
    ? [
        '당신은 한국 2030 시청자를 위한 릴스·쇼츠 4비트 대본 작가입니다.',
        '첫 3.5초 안에 스크롤을 멈추게 하는 훅을 쓰고, 이어서 구체적인 문제 하나,',
        '바로 실행할 수 있는 해결 3개, 마지막에 유도 하나를 씁니다.',
        '광고 문구, 확인되지 않은 수치·효능, 어느 주제에나 붙는 일반론을 쓰지 않습니다.',
        '문장은 짧게, 말하듯이 씁니다. 반드시 JSON 객체 하나만 출력합니다.',
      ].join(' ')
    : [
        'You write 4-beat Reels/Shorts scripts for a Korean 2030 audience.',
        'Hook within the first 3.5 seconds, one concrete problem, three actionable steps, one CTA.',
        'No ad copy, no unverified numbers or claims, no generic advice that fits any topic.',
        'Short spoken sentences. Output exactly one JSON object.',
      ].join(' ');

  const lines: string[] = [
    `topic: ${topic}`,
    `topic area: ${domain.label} (${domain.detail})`,
    `audience: ${domain.knowledge?.pack.subject ?? domain.name}`,
    `target length: ${durationSec}s`,
    `speech budget: about ${capacity} syllables at ${syllablesPerSecond} syllables/sec`,
    `hook must finish by 3.5s`,
    input.angle ? `angle: ${input.angle.label} (${input.angle.hookStyle})` : 'angle: pick the one that fits the topic',
    `cta goal: ${CTA_GOAL_KO[input.ctaGoal ?? 'save']}`,
  ];

  if (pack) {
    lines.push(
      '',
      ko ? '[이 주제에서 실제로 확인해야 하는 포인트]' : '[facts to ground the script]',
      ...pack.steps.map((step) => `- ${step}`),
      ko ? '[근거] ' + pack.basis : `[basis] ${pack.basis}`,
      ko
        ? '숫자·기한·금액은 공고나 계약서에서 확인해야 하는 값이므로 단정하지 말고 "공고에서 확인"으로 남깁니다.'
        : 'Leave changing numbers and deadlines as "check the current notice".',
    );
  }

  lines.push(
    '',
    ko ? '[쓰지 말 것]' : '[avoid]',
    ko ? '- "기준을 하나로 줄이세요", "매일 반복되는 동작에 붙이세요" 같은 범용 조언' : '- generic advice',
    ko ? '- 실제로 확인하지 않은 통계, 수익률, 효능' : '- unverified statistics, returns, health claims',
    ko ? '- 같은 문장의 반복, 주제어의 기계적 반복' : '- repeated sentences and mechanical topic repetition',
    '',
    ko ? '[출력 형식]' : '[output]',
    '{"title":string,"scenes":[{"beat":"hook"|"problem"|"solution"|"cta","narration":string,"onScreenText":string,"emphasis":string[],"visual":string}],"hashtags":string[]}',
    ko
      ? '장면은 hook 1개, problem 1개, solution 3개, cta 1개. narration은 한국어 구어체. onScreenText는 10자 이내.'
      : 'Exactly one hook, one problem, three solutions, one cta. onScreenText under 10 characters.',
  );

  return { system, user: lines.join('\n') };
}

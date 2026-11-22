import { describe, expect, it } from 'vitest';
import { classifyScriptDomain, SCRIPT_DOMAIN_BANKS, SCRIPT_DOMAIN_IDS } from '../src/services/scriptDomains';
import { inspectDrafts, writeDomainDrafts } from '../src/services/domainScriptWriter';
import { writeTopicDrafts } from '../src/services/topicDraftWriter';
import { KNOWLEDGE_PACKS, matchKnowledgePacks, resolveKnowledge } from '../src/services/topicKnowledge';
import { createScriptEngine } from '../src/services/scriptEngine';
import { estimateSpeechSeconds } from '../src/lib/text';

/**
 * 2026-11-22 피드백 회귀 방지.
 *
 * "주제에 '전세사기 주의할점'을 넣으면 일상으로 인식해서 대본이 엉망이 된다."
 * 이 테스트는 승혜 님의 실제 SNS 주제로 (1) 도메인이 맞게 갈리는지, (2) 지식 팩이
 * 실제 확인 항목(등기부등본·확정일자·HUG 등)을 말하는지, (3) 일상 문장이 새지
 * 않는지를 고정한다.
 */

interface TopicCase {
  topic: string;
  domain: string;
  pack: string;
  /** 해결 단계에 반드시 나와야 하는 실제 정보. */
  mustMention: string[];
  /** 이 주제에 나오면 안 되는 다른 도메인의 문장. */
  mustNotMention?: string[];
}

const CASES: TopicCase[] = [
  {
    topic: '전세사기 주의할점',
    domain: 'home',
    pack: 'jeonse-fraud',
    mustMention: ['등기부등본', '전입신고', '확정일자', 'HUG'],
    mustNotMention: ['하루의 장면', '편집은 그날', '아침에 컷 세 개'],
  },
  {
    topic: '청년 월세 지원금 신청법',
    domain: 'info',
    pack: 'youth-rent',
    mustMention: ['무주택', '주소', '이체'],
    mustNotMention: ['이동 동선', '카메라를 켜두고'],
  },
  {
    topic: '빈티지 디카 입문 추천',
    domain: 'camera',
    pack: 'vintage-digicam',
    mustMention: ['배터리', '화이트밸런스', '노출'],
    mustNotMention: ['이동 동선', '수납용품'],
  },
  {
    topic: '데스크테리어 조명 추천',
    domain: 'desk',
    pack: 'desk-lighting',
    mustMention: ['간접등', '색온도', '밝기'],
    mustNotMention: ['이동 동선', '재료를 먼저'],
  },
  {
    topic: '스드메 예산 짜는 법',
    domain: 'wedding',
    pack: 'sdeume',
    mustMention: ['견적', '드레스', '날짜'],
    mustNotMention: ['이동 동선', '하루의 장면'],
  },
  {
    topic: '영어 회화 공부법',
    domain: 'language',
    pack: 'speaking',
    mustMention: ['문장', '녹음'],
    mustNotMention: ['이동 동선', '수납'],
  },
  {
    topic: '챗GPT 업무 자동화',
    domain: 'tech',
    pack: 'chatgpt-work',
    mustMention: ['프롬프트', '출력 형식'],
    mustNotMention: ['이동 동선', '재료를 먼저'],
  },
  {
    topic: '다꾸 입문',
    domain: 'diary',
    pack: 'dacco',
    mustMention: ['스티커', '한 줄'],
    mustNotMention: ['이동 동선', '주방'],
  },
  {
    topic: '실업급여 신청 방법',
    domain: 'info',
    pack: 'unemployment',
    mustMention: ['이직확인서', '고용24'],
  },
  {
    topic: '부산 신혼집 3평 주방 수납 정리법',
    domain: 'living',
    pack: 'kitchen-storage',
    mustMention: ['상부장', '용기'],
    mustNotMention: ['이동 동선'],
  },
];

function textOf(drafts: ReturnType<typeof writeDomainDrafts>['drafts']): string {
  return drafts.map((draft) => draft.narration).join(' ');
}

describe('승혜 님 SNS 주제 분류', () => {
  it.each(CASES)('$topic → $domain / $pack', ({ topic, domain, pack }) => {
    const profile = classifyScriptDomain(topic);
    expect(profile.id, topic).toBe(domain);
    expect(profile.knowledge?.pack.id, topic).toBe(pack);
    expect(profile.knowledge?.pack.basis.length, topic).toBeGreaterThan(10);
  });

  it('12개 SNS 주제가 모두 서로 다른 도메인으로 갈린다', () => {
    const topics = [
      '전세사기 주의할점',
      '청년 월세 지원금 신청법',
      '스드메 예산 짜는 법',
      '겨울 제주 여행 2박3일 코스',
      '빈티지 디카 입문 추천',
      '주 3회 러닝 루틴',
      '영어 회화 공부법',
      '챗GPT 업무 자동화',
      '데스크테리어 조명 추천',
      '다꾸 입문',
      '봄웜라 립 추천',
      '퇴사한 30대 개발자의 일상',
    ];
    const domains = topics.map((topic) => classifyScriptDomain(topic).id);
    expect(new Set(domains).size).toBeGreaterThanOrEqual(10);
  });

  it('띄어쓰기가 없거나 합성어여도 이름에서 형식어를 떼어낸다', () => {
    expect(classifyScriptDomain('전세사기주의할점').name).toBe('전세사기');
    expect(classifyScriptDomain('전세사기 주의할점').name).toBe('전세사기');
    expect(classifyScriptDomain('빈티지 디카 입문 추천').name).toBe('빈티지 디카');
    expect(classifyScriptDomain('데스크테리어 조명 추천').name).toBe('데스크 조명');
    expect(classifyScriptDomain('영어 회화 공부법').name).toBe('영어 회화');
    expect(classifyScriptDomain('다꾸 입문').name).toBe('다꾸');
  });

  it('장르 어미(…일상)는 지식 팩보다 우선한다', () => {
    // 디카·챗GPT 단어가 있어도 영상의 형식이 일상 브이로그면 일상으로 쓴다.
    const profile = classifyScriptDomain('빈티지 디카 들고 다니는 일상 브이로그');
    expect(profile.id).toBe('daily');
    expect(profile.knowledge).toBeNull();
  });
});

describe('지식 팩 기반 4비트 대본', () => {
  it.each(CASES)('$topic 대본이 실제 확인 항목을 말한다', ({ topic, mustMention, mustNotMention }) => {
    const result = writeTopicDrafts({ topic, durationSec: 45, variation: 0, angle: 'auto' });
    const text = textOf(result.drafts);

    for (const word of mustMention) {
      expect(text, `${topic}: ${word}`).toContain(word);
    }
    for (const word of mustNotMention ?? []) {
      expect(text, `${topic}: ${word}`).not.toContain(word);
    }

    const report = inspectDrafts(result.drafts, result.scriptDomain);
    expect(report.hookOk, `${topic}: ${result.drafts[0]?.narration}`).toBe(true);
    expect(report.topicMentions, topic).toBeLessThanOrEqual(2);
    expect(report.repeatedLines, topic).toEqual([]);
    expect(report.emptyScenes, topic).toBe(0);
  });

  it('전세사기 대본이 등기부등본·확정일자·HUG를 순서대로 말한다', () => {
    const result = writeTopicDrafts({ topic: '전세사기 주의할점', durationSec: 45, variation: 0, angle: 'auto' });
    const steps = result.drafts.filter((draft) => draft.beat === 'solution').map((draft) => draft.narration);
    expect(steps.length).toBeGreaterThanOrEqual(4);
    expect(steps[0]).toContain('등기부등본');
    expect(steps[1]).toContain('확정일자');
    expect(steps.join(' ')).toContain('HUG');
    expect(result.hashtags).toContain('#전세사기');
  });

  it('지식 팩의 화면 자막이 말하는 단계와 같은 순서다', () => {
    const result = writeTopicDrafts({ topic: '전세사기 주의할점', durationSec: 60, variation: 0, angle: 'auto' });
    const steps = result.drafts.filter((draft) => draft.beat === 'solution');
    expect(steps[0]?.onScreenText).toBe('등기부등본');
    expect(steps[1]?.onScreenText).toContain('확정일자');
    expect(steps[2]?.onScreenText).toContain('완납증명');
    expect(steps[3]?.onScreenText).toContain('HUG');
  });

  it('같은 주제를 여러 번 눌러도 단계가 겹치지 않고 앵글이 돈다', () => {
    const hooks = new Set<string>();
    const angles = new Set<string>();
    for (let variation = 0; variation < 6; variation += 1) {
      const result = writeTopicDrafts({ topic: '전세사기 주의할점', durationSec: 45, variation, angle: 'auto' });
      hooks.add(result.drafts[0]!.narration);
      angles.add(result.angle.id);
      expect(inspectDrafts(result.drafts, result.scriptDomain).hookOk).toBe(true);
    }
    expect(hooks.size).toBeGreaterThanOrEqual(5);
    expect(angles.size).toBeGreaterThanOrEqual(4);
  });

  it('60초·30초 모두 3.5초 훅과 발화 예산 안에 들어온다', async () => {
    const engine = createScriptEngine();
    for (const targetDurationSec of [30, 45, 60]) {
      const { script } = await engine.craft({
        topic: '전세사기 주의할점',
        language: 'ko',
        targetDurationSec,
        speed: 1,
        hookType: 'howto',
        ctaGoal: 'save',
      });
      expect(script.scenes[0]!.beat).toBe('hook');
      expect(script.scenes[0]!.durationSec, `${targetDurationSec}s`).toBeLessThanOrEqual(3.5);
      expect(script.metrics.totalDurationSec).toBeLessThanOrEqual(targetDurationSec + 0.01);
      expect(estimateSpeechSeconds(script.scenes[0]!.narration, { language: 'ko' })).toBeLessThanOrEqual(3.5);
      expect(script.hashtags.length).toBeGreaterThan(2);
    }
  });
});

describe('도메인·지식 팩 무결성', () => {
  it('19개 도메인 모두 6단계·5앵글·4유도 문장을 가진다', () => {
    for (const id of SCRIPT_DOMAIN_IDS) {
      const bank = SCRIPT_DOMAIN_BANKS[id];
      expect(bank, id).toBeDefined();
      expect(bank.steps.length, id).toBeGreaterThanOrEqual(6);
      expect(bank.problems.length, id).toBeGreaterThanOrEqual(4);
      expect(Object.keys(bank.hooks).length, id).toBe(5);
      for (const [angle, hooks] of Object.entries(bank.hooks)) {
        expect(hooks.length, `${id}/${angle}`).toBeGreaterThanOrEqual(1);
      }
      for (const goal of ['save', 'comment', 'follow', 'link'] as const) {
        expect(bank.ctas[goal]?.length, `${id}/${goal}`).toBeGreaterThanOrEqual(1);
      }
      expect(bank.visuals.length, id).toBeGreaterThanOrEqual(3);
    }
  });

  it('지식 팩마다 단계·근거·태그가 채워져 있고 슬롯이 남지 않는다', () => {
    for (const pack of KNOWLEDGE_PACKS) {
      expect(pack.steps.length, pack.id).toBeGreaterThanOrEqual(3);
      expect(pack.problems.length, pack.id).toBeGreaterThanOrEqual(3);
      expect(pack.basis.length, pack.id).toBeGreaterThan(10);
      for (const line of [...pack.steps, ...pack.problems, ...Object.values(pack.hooks ?? {}).flat()]) {
        // 남는 슬롯이 없어야 한다. {n}·{n은}·{p}·{d}·{persona}만 허용한다.
        const stripped = line
          .replace(/\{n[은이가을를과도]?\}/gu, '')
          .replace(/\{p[은도]?\}/gu, '')
          .replace(/\{d\}/gu, '')
          .replace(/\{persona\}/gu, '');
        expect(stripped, pack.id).not.toContain('{');
        expect(line.trim().length, pack.id).toBeGreaterThan(5);
      }
      // 팩의 이름은 3.2초 훅에 들어갈 수 있는 길이여야 한다.
      expect(Array.from(pack.subject).length, pack.id).toBeLessThanOrEqual(12);
    }
  });

  it('팩 점수가 주제에 맞는 도메인을 가장 세게 당긴다', () => {
    const matches = matchKnowledgePacks('전세사기 주의할점');
    expect(matches[0]?.pack.id).toBe('jeonse-fraud');
    expect(resolveKnowledge('청년 월세 지원금 신청법', 'info')?.pack.id).toBe('youth-rent');
    // 월세 단어가 집 도메인 팩에도 걸리지만, 점수가 높은 쪽이 이긴다.
    expect(matchKnowledgePacks('청년 월세 지원금 신청법')[0]?.pack.id).toBe('youth-rent');
  });
});

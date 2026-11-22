import { describe, expect, it } from 'vitest';
import { classifyScriptDomain, SCRIPT_DOMAIN_BANKS, SCRIPT_DOMAIN_IDS } from '../src/services/scriptDomains';
import { inspectDrafts, writeDomainDrafts } from '../src/services/domainScriptWriter';
import { writeTopicDrafts } from '../src/services/topicDraftWriter';
import { buildStudioModel, draftBeatScene } from '../web/model/studio';
import { estimateSpeechSeconds } from '../src/lib/text';

/**
 * 2026-11-21 피드백 회귀 방지.
 *
 * "퇴사한 30대 개발자의 일상"을 넣었더니 "길게 쓰기부터 버리세요",
 * "제목과 첫 문장만 다시 씁니다"가 나왔다. 분류가 '개발'만 보고 커리어 문서
 * 카테고리를 골랐고, 그 은행이 글쓰기 조언이었기 때문이다. 이 테스트는
 * (1) 형식(일상)이 소재(개발)를 이긴다는 것, (2) 도메인마다 다른 문장이
 * 나온다는 것, (3) 주제어가 기계적으로 반복되지 않는다는 것을 고정한다.
 */

const DAILY_TOPIC = '퇴사한 30대 개발자의 일상';

/** 예전 구현이 이 주제에 넣던 글쓰기 템플릿. 하나라도 나오면 회귀다. */
const WRITING_TEMPLATE_FRAGMENTS = [
  '길게 쓰기',
  '제목과 첫 문장만',
  '결과물을 한 줄로',
  '링크는 하나로 모읍니다',
  '3초 안에 이해되는지',
  '쓸모없는 문장',
];

function allText(drafts: ReturnType<typeof writeDomainDrafts>['drafts']): string {
  return drafts.map((draft) => draft.narration).join(' ');
}

describe('주제 도메인 분류', () => {
  it('7개 이상 도메인을 형식과 소재로 구분한다', () => {
    const cases: Array<[string, string]> = [
      [DAILY_TOPIC, 'daily'],
      ['주말 아침 브이로그', 'daily'],
      ['퇴사 후 첫 달 정리', 'career'],
      ['개발자 이직 포트폴리오 정리', 'career'],
      ['팔꿈치 마사지기 리뷰', 'product'],
      ['봄웜라 립 추천', 'beauty'],
      ['부산 신혼집 3평 주방 수납 정리법', 'living'],
      ['냉장고 재료로 10분 저녁', 'recipe'],
      ['겨울 제주 여행 2박3일 코스', 'travel'],
      ['부산 전포 카페 리스트', 'cafe'],
      ['월급 관리 고정지출 점검', 'money'],
      ['인스타 릴스 대본 쓰는 법', 'content'],
      ['청약 1순위 조건', 'info'],
      ['주 3회 러닝 루틴', 'care'],
    ];
    for (const [topic, domain] of cases) {
      expect(classifyScriptDomain(topic).id, topic).toBe(domain);
    }
    expect(new Set(cases.map(([, domain]) => domain)).size).toBeGreaterThanOrEqual(7);
  });

  it('장르 어미가 소재 단어를 이긴다', () => {
    // '개발'은 커리어 단서지만, 끝이 '일상'이라 영상의 형식은 일상 기록이다.
    const profile = classifyScriptDomain(DAILY_TOPIC);
    expect(profile.label).toBe('일상·브이로그');
    expect(profile.persona).toContain('개발자');
    expect(profile.name).toBe('개발자의 일상');
  });

  it('장소는 도시보다 동네를 먼저 잡고, 기간은 2박3일을 통째로 읽는다', () => {
    const cafe = classifyScriptDomain('부산 전포 카페 리스트');
    expect(cafe.place).toBe('전포');
    expect(cafe.name).toBe('전포 카페');

    const travel = classifyScriptDomain('겨울 제주 여행 2박3일 코스');
    expect(travel.name).toBe('제주 2박3일');
  });
});

describe('도메인별 4비트 대본', () => {
  it('"퇴사한 30대 개발자의 일상"이 일상 기록으로 쓰인다', () => {
    const result = writeTopicDrafts({ topic: DAILY_TOPIC, durationSec: 45, variation: 0, angle: 'auto' });
    const text = allText(result.drafts);

    for (const fragment of WRITING_TEMPLATE_FRAGMENTS) {
      expect(text, fragment).not.toContain(fragment);
    }
    expect(text).toMatch(/하루|아침|기록|카메라|저녁/);
    expect(result.drafts[0]?.beat).toBe('hook');
    expect(result.drafts.at(-1)?.beat).toBe('cta');
    expect(result.drafts.filter((draft) => draft.beat === 'solution').length).toBeGreaterThanOrEqual(2);
  });

  it('주제어를 문장마다 반복하지 않는다', () => {
    for (const topic of [DAILY_TOPIC, '부산 신혼집 3평 주방 수납 정리법', '겨울 제주 여행 2박3일 코스']) {
      const result = writeTopicDrafts({ topic, durationSec: 45, variation: 0, angle: 'auto' });
      const report = inspectDrafts(result.drafts, result.scriptDomain);
      expect(report.topicMentions, topic).toBeLessThanOrEqual(2);
      expect(report.repeatedLines, topic).toEqual([]);
      expect(report.emptyScenes, topic).toBe(0);
    }
  });

  it('도메인 19종 모두 4비트를 만들고 문장을 마무리한다', () => {
    const samples: Record<(typeof SCRIPT_DOMAIN_IDS)[number], string> = {
      home: '전세사기 주의할점',
      info: '청약 1순위 조건',
      money: '월급 관리 고정지출 점검',
      wedding: '스드메 예산 짜는 법',
      travel: '겨울 제주 여행 2박3일 코스',
      camera: '빈티지 디카 입문 추천',
      care: '주 3회 러닝 루틴',
      language: '영어 회화 공부법',
      tech: '챗GPT 업무 자동화',
      desk: '데스크테리어 조명 추천',
      diary: '다꾸 입문',
      beauty: '봄웜라 립 추천',
      daily: DAILY_TOPIC,
      career: '퇴사 후 첫 달 정리',
      product: '팔꿈치 마사지기 리뷰',
      living: '부산 신혼집 3평 주방 수납 정리법',
      recipe: '냉장고 재료로 10분 저녁',
      cafe: '부산 전포 카페 리스트',
      content: '인스타 릴스 대본 쓰는 법',
    };

    for (const id of SCRIPT_DOMAIN_IDS) {
      const topic = samples[id];
      const result = writeTopicDrafts({ topic, durationSec: 45, variation: 0, angle: 'auto' });
      const beats = result.drafts.map((draft) => draft.beat);

      expect(result.scriptDomain.id, topic).toBe(id);
      expect(beats[0], topic).toBe('hook');
      expect(beats.at(-1), topic).toBe('cta');
      expect(beats.filter((beat) => beat === 'solution').length, topic).toBeGreaterThanOrEqual(2);
      for (const draft of result.drafts) {
        expect(draft.narration.trim(), `${topic} / ${draft.beat}`).not.toBe('');
        // 훅만 마침표를 생략한다(마침표 0.24초가 3.5초 상한을 잡아먹는다). 나머지는 문장으로 끝난다.
        if (draft.beat !== 'hook') {
          expect(draft.narration.trim(), `${topic} / ${draft.beat}`).toMatch(/[.?!]$/);
        }
        expect(draft.narration, `${topic} / ${draft.beat}`).not.toContain('{');
        expect(draft.narration, `${topic} / ${draft.beat}`).not.toContain('…');
      }
      const hook = result.drafts[0]!.narration;
      expect(estimateSpeechSeconds(hook, { language: 'ko' }), `${topic}: ${hook}`).toBeLessThanOrEqual(3.5);
    }
  });

  it('같은 주제로 눌러도 훅·앵글·단계가 함께 바뀐다', () => {
    const hooks = new Set<string>();
    const angles = new Set<string>();
    const steps = new Set<string>();
    if (SCRIPT_DOMAIN_BANKS.daily.steps.length < 6) throw new Error('daily 은행이 6단계 미만입니다');

    for (let variation = 0; variation < 6; variation += 1) {
      const result = writeTopicDrafts({ topic: DAILY_TOPIC, durationSec: 45, variation, angle: 'auto' });
      hooks.add(result.drafts[0]!.narration);
      angles.add(result.angle.id);
      steps.add(
        result.drafts
          .filter((draft) => draft.beat === 'solution')
          .map((draft) => draft.narration)
          .join(' '),
      );
    }

    expect(hooks.size).toBe(6);
    expect(angles.size).toBe(5);
    expect(steps.size).toBeGreaterThan(1);
  });

  it('30·45·60초 모두 목표 길이와 3.5초 훅 안에 들어온다', () => {
    for (const durationSec of [30, 45, 60]) {
      const drafts = draftBeatScene(DAILY_TOPIC, durationSec, 0, 'auto');
      const model = buildStudioModel({
        topic: DAILY_TOPIC,
        durationSec,
        speed: 1,
        language: 'ko',
        drafts,
        compress: true,
      });
      expect(model.overrunSec, `${durationSec}s`).toBe(0);
      expect(model.totalDurationSec, `${durationSec}s`).toBeLessThanOrEqual(durationSec + 0.01);
      expect(model.scenes[0]!.durationSec, `${durationSec}s`).toBeLessThanOrEqual(3.5);
      // 훅이 압축 과정에서 "개발자의 일상"만 남는 식으로 잘리지 않는다.
      expect(model.scenes[0]!.narration.length).toBeGreaterThan(10);
    }
  });
});

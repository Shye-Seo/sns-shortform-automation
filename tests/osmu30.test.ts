import { describe, expect, it } from 'vitest';
import { OSMU_LIMITS, convertToOsmu } from '../src/services/osmuConverter';
import { draftBeatScene } from '../web/model/studio';
import { planCrossChannel } from '../src/services/crossChannelPlanner';

/**
 * `crosschannel`(한 편을 세 곳으로) 30초 프리셋 전수 검수.
 *
 * 30초는 이 제품에서 가장 짧은 프리셋이고, 대본 문장이 가장 적다. 그래서
 *  - 블로그 요약이 250자 아래로 내려가 검사에 걸리고,
 *  - 쇼츠 설명이 제목과 훅을 같은 줄에 두 번 쓰고,
 *  - 시간 표시가 낱말 중간에서 잘리는 문제가 드러났다.
 * 아래 테스트는 열두 도메인의 30초 결과를 한 번에 돌려 그 세 가지를 막는다.
 */

const TOPICS = [
  '퇴사한 30대 개발자의 일상',
  '퇴사 후 첫 달 정리',
  '팔꿈치 마사지기 리뷰',
  '봄웜라 립 추천',
  '부산 신혼집 3평 주방 수납 정리법',
  '냉장고 재료로 10분 저녁',
  '겨울 제주 여행 2박3일 코스',
  '부산 전포 카페 리스트',
  '월급 관리 고정지출 점검',
  '인스타 릴스 대본 쓰는 법',
  '청약 1순위 조건',
  '주 3회 러닝 루틴',
];

/** '…'로 잘린 줄이 낱말 중간에서 끊겼는지. 공백·쉼표 뒤에서 잘랐으면 통과. */
function cutsAtWordBoundary(line: string): boolean {
  if (!line.includes('…')) return true;
  const head = line.slice(0, line.indexOf('…'));
  if (head.length === 0) return false;
  // 한글 낱말은 띄어쓰기로 나뉜다. 마지막 글자가 조사 하나만 남은 형태는 실패로 본다.
  return !/(을|를|은|는|이|가|의|에|로|와|과|도)$/u.test(head);
}

describe('30초 프리셋 전수 검수', () => {
  for (const topic of TOPICS) {
    it(`${topic}: 세 포맷 모두 검사를 통과하고 문장이 잘리지 않는다`, () => {
      const scenes = draftBeatScene(topic, 30, 0, 'auto');
      const result = convertToOsmu({ topic, scenes, durationSec: 30 });

      expect(result.formats.map((format) => format.id)).toEqual(['reels', 'shorts', 'summary']);
      expect(result.warnings).toEqual([]);

      for (const format of result.formats) {
        for (const check of format.checks) {
          expect(check.ok, `${format.id}/${check.id}: ${check.detail}`).toBe(true);
        }
      }

      const reels = result.formats[0]!;
      const shorts = result.formats[1]!;
      const summary = result.formats[2]!;

      expect((reels.text.split('\n')[0] ?? '').length).toBeLessThanOrEqual(60);
      expect(shorts.text).toMatch(/\d{2}:\d{2} 훅/);
      expect(shorts.text).toMatch(/\d{2}:\d{2} 마지막 유도/);
      expect(summary.threads!.every((chunk) => chunk.length <= OSMU_LIMITS.threadsPost)).toBe(true);

      // 잘린 줄은 모두 낱말 경계에서 끝난다.
      const clipped = [...reels.text.split('\n'), ...shorts.text.split('\n'), ...summary.text.split('\n')].filter((line) =>
        line.includes('…'),
      );
      for (const line of clipped) {
        expect(cutsAtWordBoundary(line), line).toBe(true);
      }
    });
  }

  it('쇼츠 설명이 제목과 같은 문장을 두 번 쓰지 않는다', () => {
    for (const topic of TOPICS) {
      const scenes = draftBeatScene(topic, 30, 0, 'auto');
      const shorts = convertToOsmu({ topic, scenes, durationSec: 30 }).formats[1]!;
      const lines = shorts.text.split('\n').map((line) => line.trim()).filter(Boolean);
      const [title, , firstLine] = lines;
      expect(firstLine, topic).not.toBe(title);
    }
  });

  it('30초 요약 제목에 "단계로 정리"를 일상·여행에 붙이지 않는다', () => {
    const daily = convertToOsmu({
      topic: '퇴사한 30대 개발자의 일상',
      scenes: draftBeatScene('퇴사한 30대 개발자의 일상', 30, 0, 'auto'),
      durationSec: 30,
    }).formats[2]!;
    expect(daily.text.split('\n')[0]).toContain('일상');
    expect(daily.text.split('\n')[0]).not.toContain('단계로 정리');

    const travel = convertToOsmu({
      topic: '겨울 제주 여행 2박3일 코스',
      scenes: draftBeatScene('겨울 제주 여행 2박3일 코스', 30, 0, 'auto'),
      durationSec: 30,
    }).formats[2]!;
    expect(travel.text.split('\n')[0]).toContain('코스');
  });

  it('해시태그는 주제 도메인에서 나온다(글쓰기 태그가 일상에 붙지 않는다)', () => {
    const daily = convertToOsmu({
      topic: '퇴사한 30대 개발자의 일상',
      scenes: draftBeatScene('퇴사한 30대 개발자의 일상', 30, 0, 'auto'),
      durationSec: 30,
    }).formats[0]!;
    expect(daily.hashtags.join(' ')).not.toMatch(/#포트폴리오|#결과한줄|#첫문장/);
    expect(daily.hashtags.join(' ')).toMatch(/#일상|#브이로그/);
  });

  it('크로스채널 기획도 30초에서 같은 대본을 쓴다', () => {
    const plan = planCrossChannel({ topic: '퇴사한 30대 개발자의 일상', durationSec: 30, variation: 0 });
    const shortsText = plan.shorts.scenes.map((scene) => scene.narration).join(' ');
    expect(shortsText).toMatch(/하루|아침|기록/);
    expect(shortsText).not.toMatch(/길게 쓰기|제목과 첫 문장/);
    expect(plan.blog.intro).not.toContain('길게 쓰기');
    expect(plan.longform.coldOpen.length).toBeGreaterThan(10);
  });
});

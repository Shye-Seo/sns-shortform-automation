import { describe, expect, it } from 'vitest';
import { SCAN_RULES, scanUploadContent } from '../src/services/complianceScanner';
import { buildStudioModel, draftBeatScene } from '../web/model/studio';
import { scanStudioModel } from '../web/model/compliance';

/**
 * 발행 전 점검은 "내려갈 이유"를 발행 버튼 전에 알려 주는 장치다.
 * 두 방향을 모두 고정한다: 규제 표현은 실제로 잡고, 정상 대본에는 헛짚지 않는다.
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

function modelOf(topic: string) {
  return buildStudioModel({
    topic,
    durationSec: 45,
    speed: 1,
    language: 'ko',
    drafts: draftBeatScene(topic, 45, 0, 'auto'),
    compress: true,
  });
}

describe('규제·금칙 표현 검사', () => {
  it('의료 효능·최저가 보장은 차단한다', () => {
    const report = scanUploadContent({
      scenes: [
        { beat: 'hook', narration: '이 크림은 피부 재생에 부작용이 없습니다.' },
        { beat: 'cta', narration: '국내 유일 최저가 보장입니다.' },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.blocking).toBeGreaterThanOrEqual(3);
    const labels = report.findings.map((finding) => finding.label);
    expect(labels).toContain('재생·노화방지·면역력 단정');
    expect(labels).toContain('부작용 없음 단정');
    expect(labels).toContain('최저가 보장');
    // 원문과 고칠 방법을 함께 보여준다.
    for (const finding of report.findings.filter((item) => item.severity === 'block')) {
      expect(finding.matched.length).toBeGreaterThan(1);
      expect(finding.suggestion.length).toBeGreaterThan(10);
    }
  });

  it('전화번호·주민등록번호는 정책 위반으로 차단한다', () => {
    const report = scanUploadContent({
      scenes: [{ beat: 'cta', narration: '자세한 건 010-1234-5678로 주세요.' }],
      caption: '계좌 110-123-456789 로 입금 주세요',
    });
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.label)).toEqual(
      expect.arrayContaining(['전화번호 노출', '계좌번호 형태']),
    );
  });

  it('정상 대본에는 걸리지 않는다(도메인 12종)', () => {
    for (const topic of TOPICS) {
      const report = scanStudioModel(modelOf(topic));
      const found = report.findings.filter((finding) => finding.severity !== 'info');
      expect(found, `${topic}: ${JSON.stringify(found)}`).toEqual([]);
      expect(report.ok).toBe(true);
    }
  });

  it('규칙 목록은 사람이 읽을 이름과 고칠 방법을 갖는다', () => {
    for (const rule of SCAN_RULES) {
      expect(rule.label.length).toBeGreaterThan(2);
      expect(rule.suggestion.length).toBeGreaterThan(10);
      expect(rule.pattern.flags.includes('u')).toBe(true);
    }
  });
});

describe('9:16 안전영역 검사', () => {
  it('자막 박스를 넘는 줄과 겹침을 잡는다', () => {
    const report = scanUploadContent({
      scenes: [{ beat: 'hook', narration: '아주 긴 자막 한 줄입니다' }],
      safeArea: {
        captionWidthPx: 120,
        fontPx: 44,
        cues: [{ index: 1, startSec: 0, lines: ['아주 긴 자막 한 줄입니다 정말로 길게'] }],
        collisions: [{ layer: '자막', zone: 'action-rail', overlapPx: 24 }],
      },
    });

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.label)).toEqual(
      expect.arrayContaining(['자막이 9:16 안전영역을 넘음', '플랫폼 UI와 겹침']),
    );
  });

  it('훅이 3.5초를 넘으면 차단한다', () => {
    const report = scanUploadContent({
      scenes: [{ beat: 'hook', narration: '훅' }],
      safeArea: { captionWidthPx: 900, fontPx: 44, hookDurationSec: 4.2 },
    });
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.label).toBe('훅 3.5초 초과');
  });

  it('캡션·해시태그 상한을 넘으면 알린다', () => {
    const report = scanUploadContent({
      scenes: [{ beat: 'hook', narration: '훅' }],
      caption: '가'.repeat(2_201),
      hashtags: Array.from({ length: 10 }, (_, index) => `#태그${index}`),
      limits: { captionChars: 2_200, hashtagMax: 8 },
    });
    expect(report.findings.map((finding) => finding.label)).toEqual(
      expect.arrayContaining(['캡션 길이 초과', '해시태그 과다']),
    );
  });
});

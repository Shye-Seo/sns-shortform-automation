import type { Angle, AngleId, ChannelId, ChannelPattern } from '../types/plan';

/**
 * Why an angle, not a hook template list.
 *
 * Five angles cover the hooks that actually hold on Korean shortform: point at
 * the blocker, promise a number, hand over a checklist, show the after, or
 * break the consensus. Each angle fixes the *shape* of the whole script, so
 * pressing "regenerate" moves the script to a different shape instead of
 * reshuffling synonyms while the captions stay the same.
 */

export const ANGLE_LIST: Angle[] = [
  {
    id: 'problem-solve',
    label: '문제해결형',
    hookStyle: '질문형 · 막히는 지점 지적',
    bestFor: '검색 의도가 분명한 생활 문제(수납, 조건, 동선)',
    outline: ['훅: 지금 막히는 장면을 그대로 말한다', '문제: 왜 반복되는지 한 문장', '해결: 실행 순서 2~4개', 'CTA: 저장 또는 댓글'],
  },
  {
    id: 'numbers',
    label: '숫자비교형',
    hookStyle: '숫자 제시형 · 기대치 고정',
    bestFor: '시간·비용·개수로 약속할 수 있는 주제',
    outline: ['훅: 숫자로 결과를 먼저 말한다', '문제: 숫자가 안 나오는 이유', '해결: 숫자를 만드는 조건 2~4개', 'CTA: 같은 기준으로 다시 보기'],
  },
  {
    id: 'checklist',
    label: '체크리스트형',
    hookStyle: '목록 예고형 · 순서 보장',
    bestFor: '신청·구매·여행처럼 빠뜨리면 되돌리기 어려운 주제',
    outline: ['훅: 확인해야 할 개수를 먼저 말한다', '문제: 하나 빠질 때 생기는 일', '해결: 체크 항목을 순서대로', 'CTA: 저장해서 그대로 따라 하기'],
  },
  {
    id: 'before-after',
    label: '비포애프터형',
    hookStyle: '결과 선노출형 · 변화 비교',
    bestFor: '리뷰·인테리어·운동처럼 눈에 보이는 변화가 있는 주제',
    outline: ['훅: 바뀐 결과를 먼저 보여준다', '문제: 바꾸기 전 상태', '해결: 무엇을 바꿨는지 2~4개', 'CTA: 전후 비교 다시 보기'],
  },
  {
    id: 'contrarian',
    label: '반전형',
    hookStyle: '통념 반박형 · 결론 뒤집기',
    bestFor: '다들 같은 방법을 말하는 주제(수납템, 다이어트, 재테크)',
    outline: ['훅: 흔한 조언을 부정한다', '문제: 그 조언이 실패하는 이유', '해결: 빼야 하는 것과 남길 것', 'CTA: 반대 의견 댓글로 받기'],
  },
];

export const ANGLE_BY_ID: Record<AngleId, Angle> = ANGLE_LIST.reduce(
  (map, angle) => ({ ...map, [angle.id]: angle }),
  {} as Record<AngleId, Angle>,
);

export const CHANNEL_LABEL: Record<ChannelId, string> = {
  'instagram-reels': '인스타그램 릴스',
  'youtube-shorts': '유튜브 쇼츠',
  'youtube-longform': '유튜브 롱폼',
  'naver-blog': '네이버 블로그',
  tistory: '티스토리',
  wordpress: '워드프레스',
};

/**
 * Structural patterns per channel.
 *
 * These are the repeated skeletons visible in public creator guides and in the
 * top posts of each channel, written as design rules rather than as measured
 * statistics — no engagement percentage is claimed here. Numbers that do appear
 * (hook window, caption limits) are platform limits or writing constraints, not
 * performance data.
 */
export const PATTERN_LIBRARY: ChannelPattern[] = [
  {
    channel: 'instagram-reels',
    label: '인스타그램 릴스',
    format: '9:16 · 15~45초 · 자막 중심',
    hookWindowSec: 1.5,
    lengthNote: '15~30초가 저장률에 유리하고, 45초를 넘기면 완주 전에 이탈이 늘어난다.',
    segments: [
      { beat: '훅', purpose: '화면·자막·소리 중 둘을 동시에 바꿔 스크롤을 멈춘다', sharePct: 12 },
      { beat: '공감/문제', purpose: '시청자가 겪는 장면을 한 문장으로 재현한다', sharePct: 20 },
      { beat: '해결', purpose: '손으로 따라 할 수 있는 순서만 남긴다', sharePct: 50 },
      { beat: '저장 트리거', purpose: 'CTA 전에 "다시 볼 이유"를 한 번 더 준다', sharePct: 8 },
      { beat: 'CTA', purpose: '저장·댓글·프로필 링크 중 하나만 요청한다', sharePct: 10 },
    ],
    hookStyles: ['첫 프레임 자막 + 움직임', '질문형 자막', '결과 선노출', '숫자 약속'],
    saveTriggers: ['나중에 다시 볼 때', '저장해두면', '순서대로 따라 하기'],
    shareTriggers: ['친구에게 보내기', '같이 사는 사람에게'],
    titleRule: '첫 줄이 곧 제목 — 검색어를 앞에, 감정어는 뒤에',
    captionRule: '첫 2줄 안에 결론, 그 다음 줄에 이유, 마지막 줄에 질문. 해시태그는 5~8개.',
    seoRule: '릴스는 프로필 내 검색과 키워드 자막으로 노출된다. 핵심 명사를 자막과 캡션에 같은 말로 쓴다.',
    failureModes: ['인사말로 시작', '자막 2줄 초과', '정보를 3개 이상 한 화면에 몰아넣기'],
    source: '공개 크리에이터 가이드와 상위 릴스에서 반복되는 구조를 규칙화한 휴리스틱(성과 수치 실측 아님)',
  },
  {
    channel: 'youtube-shorts',
    label: '유튜브 쇼츠',
    format: '9:16 · 20~50초 · 검색 유입',
    hookWindowSec: 2,
    lengthNote: '20~40초가 검색·추천 양쪽에 무난하고, 루프가 되면 다시보기가 붙는다.',
    segments: [
      { beat: '훅', purpose: '결론 또는 결과를 첫 2초에 말한다', sharePct: 15 },
      { beat: '이유/문제', purpose: '왜 그렇게 되는지 한 문장', sharePct: 20 },
      { beat: '실행', purpose: '단계별로 말하고 화면에 번호를 띄운다', sharePct: 50 },
      { beat: '루프/CTA', purpose: '첫 장면으로 자연스럽게 되돌리거나 구독을 한 번만', sharePct: 15 },
    ],
    hookStyles: ['결론 먼저', '숫자 약속', '실패 장면 먼저', '질문형'],
    saveTriggers: ['저장', '나중에 보려면'],
    shareTriggers: ['공유', '친구 태그'],
    titleRule: '제목에 검색 키워드 + 얻는 것. 40자 안쪽, #Shorts는 붙이지 않아도 된다.',
    captionRule: '설명란 2줄 요약 + 관련 링크 1개. 해시태그는 3개 이내.',
    seoRule: '쇼츠는 유튜브 검색 결과에 뜬다. 제목·설명·첫 자막의 키워드를 일치시킨다.',
    failureModes: ['구독 요청을 반복', '10초 넘는 인트로', '자막 없이 말로만 전달'],
    source: '유튜브 공식 쇼츠 가이드의 길이·형식 권고와 상위 채널의 반복 구조 정리',
  },
  {
    channel: 'youtube-longform',
    label: '유튜브 롱폼',
    format: '16:9 · 5~10분 · 챕터',
    hookWindowSec: 15,
    lengthNote: '5~8분이 정보형 주제의 완주율과 검색 노출 사이에서 무난하다.',
    segments: [
      { beat: '콜드오픈', purpose: '결과·실패 장면을 먼저 보여주고 약속을 말한다', sharePct: 8 },
      { beat: '로드맵', purpose: '이 영상에서 다룰 목차를 예고한다', sharePct: 7 },
      { beat: '본문 1~3', purpose: '챕터마다 하나의 질문에만 답한다', sharePct: 60 },
      { beat: '중간 CTA', purpose: '40% 지점에서 구독 대신 다음 챕터 예고', sharePct: 5 },
      { beat: '정리/엔드스크린', purpose: '요약 3줄 + 다음 영상 링크', sharePct: 20 },
    ],
    hookStyles: ['결과 선노출', '실패 사례', '질문 던지기', '비포애프터'],
    saveTriggers: ['나중에 다시 보기', '북마크'],
    shareTriggers: ['관련 있는 사람에게 공유'],
    titleRule: '검색 키워드 앞, 약속 뒤. 60자 안쪽. 썸네일 문구는 3~5단어.',
    captionRule: '설명란 첫 2줄에 요약, 이어서 챕터 타임스탬프, 마지막에 블로그 링크.',
    seoRule: '챕터 제목이 곧 검색어. 자동 생성 챕터를 쓰지 말고 키워드로 직접 단다.',
    failureModes: ['인트로 30초 초과', '챕터 없이 한 덩어리', '중간 광고 전환 실패'],
    source: '유튜브 챕터·설명란 공식 규칙과 정보형 상위 채널의 공통 구성 정리',
  },
  {
    channel: 'naver-blog',
    label: '네이버 블로그',
    format: '1,500~2,500자 · 사진 10~20장 · 목차',
    hookWindowSec: 0,
    lengthNote: '1,500~2,500자가 검색 상위에 남는 경우가 많고, 표·사진이 체류 시간을 만든다.',
    segments: [
      { beat: '제목', purpose: '검색 키워드 + 조건 + 후기 단어', sharePct: 5 },
      { beat: '인사/요약', purpose: '결론 3줄을 먼저 준다', sharePct: 10 },
      { beat: '목차', purpose: 'H2로 소제목을 나눈다', sharePct: 5 },
      { beat: '본문', purpose: '단계·사진·표로 근거를 붙인다', sharePct: 65 },
      { beat: '주의/FAQ', purpose: '빠뜨리기 쉬운 조건을 모은다', sharePct: 10 },
      { beat: '마무리', purpose: '대가성 문구와 함께 링크', sharePct: 5 },
    ],
    hookStyles: ['키워드 + 후기', '숫자 정리', '조건 비교', '전후 사진'],
    saveTriggers: ['스크랩', '저장'],
    shareTriggers: ['공유하기'],
    titleRule: '핵심 키워드를 앞에, 뒤에 "정리/후기/조건" 같은 검색어를 붙인다. 30자 안쪽.',
    captionRule: '첫 문단에 결론, 사진마다 설명 한 줄, 표는 3열 이내.',
    seoRule: '같은 키워드를 제목·첫 문단·소제목에 자연스럽게 반복. 링크는 본문 하단에 몰아 넣는다.',
    failureModes: ['첫 문단 인사만', '사진 설명 없음', '외부 링크를 본문 상단에 배치'],
    source: '네이버 블로그 검색 노출 방식과 상위 글의 공통 구성(목차·사진·표) 정리',
  },
  {
    channel: 'tistory',
    label: '티스토리',
    format: '1,200~2,000자 · H2 구조 · 검색',
    hookWindowSec: 0,
    lengthNote: '1,200~2,000자에 H2 5~7개가 읽기와 검색 모두에 적당하다.',
    segments: [
      { beat: '제목', purpose: '검색 키워드 + 숫자/조건', sharePct: 5 },
      { beat: '요약 박스', purpose: '3줄 요약을 인용 박스로', sharePct: 10 },
      { beat: 'H2 본문', purpose: '한 소제목에 한 질문', sharePct: 60 },
      { beat: '표/비교', purpose: '선택 기준을 표로 고정', sharePct: 15 },
      { beat: '마무리/링크', purpose: '내부 링크 2개 + 다음 글', sharePct: 10 },
    ],
    hookStyles: ['숫자 정리', '비교표', '조건 체크'],
    saveTriggers: ['북마크', '스크랩'],
    shareTriggers: ['공유'],
    titleRule: '키워드 + 숫자(3가지·5분) 조합이 클릭이 잘 나온다. 35자 안쪽.',
    captionRule: '도입 2~3문장, 소제목마다 결론 먼저, 표로 기준 정리.',
    seoRule: 'H2에 롱테일 키워드를 넣고, 메타 설명은 120~150자로 직접 쓴다.',
    failureModes: ['이미지 없이 텍스트만', '소제목 없이 장문', '메타 설명 비워두기'],
    source: '티스토리 검색 유입 글의 공통 구성(요약 박스·H2·표) 정리',
  },
  {
    channel: 'wordpress',
    label: '워드프레스',
    format: '1,800~2,500단어 · SEO · FAQ',
    hookWindowSec: 0,
    lengthNote: '1,800자 이상 + FAQ 블록이 구글 롱테일과 스니펫에 유리하다.',
    segments: [
      { beat: 'SEO 제목', purpose: '60자 이내, 키워드 앞배치', sharePct: 5 },
      { beat: '도입', purpose: '문제·결론·읽는 순서를 3문장에', sharePct: 10 },
      { beat: 'H2 본문', purpose: '질문형 소제목으로 검색 의도 대응', sharePct: 55 },
      { beat: '표/체크리스트', purpose: '스니펫 후보 블록', sharePct: 15 },
      { beat: 'FAQ', purpose: 'People Also Ask 대응 3~5개', sharePct: 10 },
      { beat: 'CTA/내부링크', purpose: '관련 글 3개 + 신청·구매 링크', sharePct: 5 },
    ],
    hookStyles: ['질문형 H2', '정의 먼저', '비교표', '체크리스트'],
    saveTriggers: ['북마크', 'PDF로 저장'],
    shareTriggers: ['공유', '링크 복사'],
    titleRule: 'SEO 제목 60자 이내, H1 하나, 키워드는 제목·첫 문단·H2에 한 번씩.',
    captionRule: '메타 설명 155자 이내. 도입 3문장 안에 결론. 목차 블록을 상단에.',
    seoRule: '내부 링크 3개, 이미지 alt에 키워드, FAQ 스키마, URL은 짧은 영문 슬러그.',
    failureModes: ['키워드 과밀', 'H1 여러 개', '내부 링크 없음'],
    source: '구글 검색 품질 가이드와 워드프레스 SEO 플러그인의 공통 권고 정리',
  },
];

export const PATTERN_BY_CHANNEL: Record<ChannelId, ChannelPattern> = PATTERN_LIBRARY.reduce(
  (map, pattern) => ({ ...map, [pattern.channel]: pattern }),
  {} as Record<ChannelId, ChannelPattern>,
);

/** Short label used in the console's "적용한 패턴" list. */
export function patternLabel(channel: ChannelId): string {
  return PATTERN_BY_CHANNEL[channel].label;
}

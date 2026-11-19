import { topicHeadKeyword } from '../lib/text';
import type { Language } from '../types/script';
import type { TopicCategory, TopicProfile } from '../types/plan';

/**
 * Topic understanding before anything is written.
 *
 * A template that only swaps the noun ("주방수납 → 제주여행") produces the same
 * script with a different word in it, which is exactly the failure this module
 * exists to stop. Classification picks the category lever (travel talks about
 * moving between places, a product review talks about noise and weight, a
 * benefit application talks about eligibility and documents), so the lines that
 * follow are about this topic rather than about a placeholder.
 */

export interface CategoryMeta {
  label: string;
  detail: string;
  audience: string;
  /** Words that pull a topic into this category. Scored, not first-match. */
  cues: RegExp;
}

export const CATEGORY_META: Record<TopicCategory, CategoryMeta> = {
  travel: {
    label: '여행·나들이',
    detail: '이동 동선',
    audience: '주말과 연차로 움직이는 2030',
    cues: /여행|제주|부산|강릉|경주|서울|속초|전주|숙소|호텔|펜션|항공|비행기|렌터카|코스|당일치기|1박|2박|3박|캠핑|해외|일본|오사카|도쿄|다낭|방콕|여행지|드라이브|나들이/,
  },
  product: {
    label: '제품·리뷰',
    detail: '소음·무게·충전',
    audience: '사기 전에 비교하는 2030',
    cues: /리뷰|후기|사용기|내돈내산|언박싱|개봉|가전|마사지기|청소기|가습기|공기청정기|이어폰|헤드폰|키보드|마우스|모니터|노트북|태블릿|선풍기|드라이어|추천템|가성비|스펙|비교/,
  },
  info: {
    label: '정보·조건',
    detail: '자격 조건',
    audience: '조건을 확인해야 하는 신청자',
    cues: /청약|조건|자격|신청|서류|지원금|실업급여|급여|연말정산|세금|환급|대출|금리|보험|정부|정책|공고|마감|기한|1순위|2순위|특별공급|가점|계약|제도/,
  },
  recipe: {
    label: '요리·식단',
    detail: '재료 순서',
    audience: '평일 저녁 10분으로 해결하는 1~2인 가구',
    cues: /레시피|요리|반찬|식단|냉장고|전자레인지|에어프라이어|오븐|재료|만들기|간단|한그릇|도시락|다이어트식|단백질|샐러드|국|찌개|볶음/,
  },
  home: {
    label: '수납·인테리어·살림',
    detail: '비우는 순서',
    audience: '신혼·1인 가구',
    cues: /수납|정리|인테리어|주방|청소|빨래|살림|이사|신혼집|원룸|오피스텔|가구|커튼|조명|욕실|베란다|창고|정돈/,
  },
  beauty: {
    label: '뷰티',
    detail: '톤과 사용량',
    audience: '색조·스킨 관심 많은 2030 여성',
    cues: /뷰티|화장품|스킨|로션|세럼|크림|선크림|메이크업|색조|쿠션|립|아이섀도|향수|헤어|샴푸|네일|톤|봄웜|여름쿨|피부|모공|각질/,
  },
  money: {
    label: '돈·재테크',
    detail: '고정지출',
    audience: '월급 관리가 필요한 사회초년생',
    cues: /재테크|적금|예금|주식|ETF|펀드|연금|ISA|절약|가계부|부수입|환전|달러|엔화|유로|투자|배당|청약통장|비상금|월급|지출/,
  },
  care: {
    label: '건강·운동',
    detail: '자세와 강도',
    audience: '운동·건강을 다시 시작하는 2030',
    cues: /운동|헬스|요가|필라테스|스트레칭|러닝|산책|건강|영양제|유산소|근력|체중|감량|수면|자세|통증|재활|홈트/,
  },
  work: {
    label: '커리어·생산성',
    detail: '결과물 첫 문장',
    audience: '이직·포트폴리오를 준비하는 개발자·기획자',
    cues: /이력서|면접|포트폴리오|노션|생산성|공부|자격증|개발|커리어|채용|공고|깃허브|깃허브|프로젝트|협업|회의|업무|일정|루틴|습관/,
  },
  daily: {
    label: '일상·브이로그',
    detail: '반복 동작',
    audience: '2030 일상 기록',
    cues: /브이로그|일상|기록|하루|주말|아침|저녁|휴일|vlog|루틴|기분|취미/,
  },
};

const FORMAT_WORDS =
  /(리뷰|후기|사용기|사용 후기|내돈내산|언박싱|개봉기|정리법|정리|방법|총정리|꿀팁|노하우|가이드|체크리스트|리스트|모음|추천|비교|조건|자격|신청|순위|알아보기|하는 ?법|하는법|하기|3가지|세 가지|가지|완전정복|끝장|총정리편)$/;

const GENERIC_TOKENS = new Set([
  '코스', '정리', '방법', '조건', '후기', '리뷰', '추천', '순서', '리스트', '체크리스트', '완성', '사용기',
  '가이드', '꿀팁', '비교', '총정리', '모음', '노하우', '루틴', '일상',
]);

const SEASONS: Array<{ season: TopicProfile['season']; cues: RegExp }> = [
  { season: 'winter', cues: /겨울|12월|1월|2월|연말|크리스마스|한파/ },
  { season: 'spring', cues: /봄|3월|4월|5월|벚꽃/ },
  { season: 'summer', cues: /여름|6월|7월|8월|휴가|장마|더위/ },
  { season: 'autumn', cues: /가을|9월|10월|11월|단풍/ },
];

function cleanSubject(topic: string): string {
  let subject = topic.replace(/[[\]{}"']/g, '').replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const next = subject.replace(new RegExp(`\\s+${FORMAT_WORDS.source}`), '');
    if (next === subject) break;
    subject = next.trim();
  }
  return subject.length === 0 ? topic.trim() : subject;
}

export function detectCategory(topic: string): TopicCategory {
  let best: TopicCategory = 'daily';
  let bestScore = 0;
  for (const category of Object.keys(CATEGORY_META) as TopicCategory[]) {
    if (category === 'daily') continue;
    const meta = CATEGORY_META[category];
    const matches = topic.match(new RegExp(meta.cues.source, 'g'));
    const score = matches ? matches.length * 2 + Math.min(2, matches[0].length / 4) : 0;
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}

export function detectIntent(topic: string): TopicProfile['intent'] {
  if (/리뷰|후기|사용기|내돈내산|써봤|언박싱|개봉/.test(topic)) return 'review';
  if (/비교|vs|차이|고르는|어느 ?쪽/.test(topic)) return 'compare';
  if (/체크리스트|조건|자격|서류|신청|순위|1순위|가점|기한/.test(topic)) return 'checklist';
  if (/뜻|이란|정리|총정리|가이드|방법|하는 ?법|어떻게/.test(topic)) return 'howto';
  if (/브이로그|일상|기록|하루|vlog/.test(topic)) return 'story';
  return 'info';
}

export function classifyTopic(topic: string, language: Language = 'ko'): TopicProfile {
  const trimmed = topic.replace(/\s+/g, ' ').trim();
  const safeTopic = trimmed.length >= 2 ? trimmed : '오늘의 주제';
  const category = detectCategory(safeTopic);
  const meta = CATEGORY_META[category];
  const subject = cleanSubject(safeTopic);
  const head = topicHeadKeyword(safeTopic, language);
  const meaningful = subject
    .split(/\s+/)
    .map((token) => token.replace(/[^가-힣A-Za-z0-9]/g, ''))
    .filter((token) => token.length >= 2 && !/^\d/.test(token) && !GENERIC_TOKENS.has(token));
  const core =
    head && !/^\d/.test(head) && head.length >= 2
      ? head
      : (meaningful[meaningful.length - 1] ?? meaningful[0] ?? subject);
  const season = SEASONS.find((entry) => entry.cues.test(safeTopic))?.season ?? null;
  const numbers = safeTopic.match(/\d+(?:\.\d+)?\s?(?:평|초|분|시간|km|kg|원|만원|개|가지|번|일|주|개월|년|순위|%)?/g) ?? [];

  return {
    topic: safeTopic,
    subject: subject.length > 0 ? subject : safeTopic,
    core: core.length > 12 ? core.slice(0, 12) : core,
    category,
    categoryLabel: meta.label,
    detail: meta.detail,
    intent: detectIntent(safeTopic),
    audience: meta.audience,
    season,
    modifiers: safeTopic
      .split(/\s+/)
      .map((token) => token.replace(/[^가-힣A-Za-z0-9]/g, ''))
      .filter((token) => token.length >= 2 && token !== core && !FORMAT_WORDS.test(token))
      .slice(0, 4),
    numbers: numbers.slice(0, 3),
  };
}

import type { Language } from '../types/script';
import { matchKnowledgePacks, resolveKnowledge, type KnowledgeMatch } from './topicKnowledge';

/**
 * 주제 도메인과 도메인별 분류기.
 *
 * 2026-11-22 전면 개편 배경(승혜 님 피드백):
 *   "주제에 '전세사기 주의할점'을 넣으면 일상으로 인식해서 대본이 엉망이 된다.
 *    내 SNS 계정들(일상·웨딩·여행·디카·운동·집·정책-지원금·외국어·테크·
 *    데스크테리어·다이어리·기록) 주제에 맞게 연관된 내용을 추천해줘."
 *
 * 고친 방식:
 *  1) 도메인을 승혜 님의 실제 SNS 주제 기준 19개로 나눴다. 집·부동산(home)과
 *     살림(living)을 분리했고, 웨딩·디카·외국어·테크·데스크테리어·다이어리를
 *     새로 넣었다. 정책·지원금은 info, 재테크는 money, 운동·다이어트는 care가 맡는다.
 *  2) 지식 팩(topicKnowledge)이 주제에서 걸리면 그 도메인에 점수를 더 준다.
 *     "전세사기"가 등기부등본·확정일자·HUG를 아는 이유가 여기 있다.
 *  3) 이름 추출을 고쳤다. "전세사기 주의할점"처럼 붙여 쓴 주제에서 '주의할점'을
 *     이름으로 쓰지 않고, 형식어(추천·입문·신청법·공부법·주의할점)를 떼어낸다.
 *
 * 도메인 id는 저장된 대본·테스트와 호환되도록 유지하고, 라벨만 새 주제에 맞췄다.
 */

export const SCRIPT_DOMAIN_IDS = [
  'home',
  'info',
  'money',
  'wedding',
  'travel',
  'camera',
  'care',
  'language',
  'tech',
  'desk',
  'diary',
  'beauty',
  'daily',
  'career',
  'product',
  'living',
  'recipe',
  'cafe',
  'content',
] as const;
export type ScriptDomainId = (typeof SCRIPT_DOMAIN_IDS)[number];

export { SCRIPT_DOMAIN_BANKS, SCRIPT_DOMAIN_TAGS, SCRIPT_DOMAIN_TITLE_SUFFIX } from './domainBanks';

export interface ScriptDomainMeta {
  id: ScriptDomainId;
  label: string;
  /** 훅과 문제가 가리키는 변수. "이동 동선", "계약과 서류"처럼 명사구. */
  detail: string;
  audience: string;
  /** 가중치가 붙은 단서. 같은 단어라도 도메인마다 다른 무게를 준다. */
  cues: Array<[RegExp, number]>;
}

export const SCRIPT_DOMAIN_META: Record<ScriptDomainId, ScriptDomainMeta> = {
  home: {
    id: 'home',
    label: '집·부동산',
    detail: '계약과 서류',
    audience: '전세·월세 계약을 앞둔 2030',
    cues: [
      [/(부동산|전세|월세|보증금|임대차|등기부등본|집주인|매매|전입신고|확정일자)$/u, 8],
      [/전세\s?사기|등기부등본|보증금|임대차|전입신고|확정일자|HUG|전세\s?보증|특약|중개사|부동산|월세|반전세|매매|집주인|전세|이사|입주/gu, 4],
    ],
  },
  info: {
    id: 'info',
    label: '정책·지원금',
    detail: '자격과 기한',
    audience: '조건을 확인해야 하는 신청자',
    cues: [
      [/(지원금|실업급여|장려금|공고|자격|신청|서류|조건|연말정산|환급|세금)$/u, 7],
      [/지원금|실업급여|구직급여|장려금|청년\s?정책|정부|정책|건강보험|건보|연말정산|세금|환급|경정청구|공고|자격|신청|서류|마감|기한|조건|청약|1순위|2순위|특별공급|가점|제도/gu, 4],
    ],
  },
  money: {
    id: 'money',
    label: '재테크·돈',
    detail: '고정지출',
    audience: '월급 관리가 필요한 사회초년생',
    cues: [
      [/(재테크|적금|예금|가계부|절약|비상금|ETF|ISA)$/u, 7],
      [/재테크|적금|예금|주식|ETF|펀드|연금|ISA|절약|가계부|부수입|환전|달러|엔화|유로|투자|배당|비상금|월급|고정지출|지출|구독료|보험료|청약통장/gu, 4],
    ],
  },
  wedding: {
    id: 'wedding',
    label: '웨딩·결혼준비',
    detail: '예산과 순서',
    audience: '결혼을 준비하는 예비부부',
    cues: [
      [/(웨딩|스드메|청첩장|결혼준비|신혼여행|예물|혼수|하객|본식|드레스)$/u, 9],
      [/웨딩|스드메|스튜디오|드레스|메이크업|청첩장|하객|본식|예물|혼수|예단|결혼\s?준비|신혼여행|답례품/gu, 5],
    ],
  },
  travel: {
    id: 'travel',
    label: '여행·나들이',
    detail: '이동 동선',
    audience: '주말과 연차로 움직이는 2030',
    cues: [
      [/(여행|코스|당일치기|1박|2박|3박|숙소|항공권)$/u, 8],
      [/여행|제주|강릉|경주|속초|전주|여수|숙소|호텔|펜션|항공|비행기|렌터카|코스|당일치기|1박|2박|3박|캠핑|해외|일본|오사카|도쿄|다낭|방콕|드라이브|나들이/gu, 3],
    ],
  },
  camera: {
    id: 'camera',
    label: '디카·사진',
    detail: '빛과 색감',
    audience: '필름 감성으로 기록하는 2030',
    cues: [
      [/(디카|카메라|필카|색감|보정|필름|사진)$/u, 9],
      [/빈티지\s?디카|디카|CCD|디지털\s?카메라|필름\s?카메라|필카|카메라|렌즈|삼각대|현상|색감|보정|라이트룸|프리셋|화밸|노출|필름/gu, 4],
    ],
  },
  care: {
    id: 'care',
    label: '운동·다이어트',
    detail: '자세와 강도',
    audience: '운동을 다시 시작하는 2030',
    cues: [
      [/(운동|헬스|요가|필라테스|스트레칭|러닝|홈트|다이어트)$/u, 8],
      [/운동|헬스|요가|필라테스|스트레칭|러닝|달리기|홈트|다이어트|식단|칼로리|체중|감량|유산소|근력|영양제|수면|자세|통증|재활|공복/gu, 4],
    ],
  },
  language: {
    id: 'language',
    label: '외국어공부',
    detail: '매일 쓰는 문장',
    audience: '말하기를 다시 시작하는 2030',
    cues: [
      [/(영어|회화|일본어|중국어|단어|문법|토익|오픽|튜터링)$/u, 9],
      [/영어|회화|스피킹|일본어|중국어|스페인어|단어|보카|문법|토익|토플|오픽|아이엘츠|JLPT|HSK|튜터|튜터링|원어민|원서|공부법/gu, 5],
    ],
  },
  tech: {
    id: 'tech',
    label: '테크·AI',
    detail: '도구를 붙이는 순서',
    audience: '일을 줄이고 싶은 2030',
    cues: [
      [/(AI|챗GPT|클로드|노션|자동화|앱|프롬프트|테크)$/u, 9],
      [/챗\s?GPT|GPT|클로드|Claude|제미나이|Gemini|인공지능|AI|노션|Notion|자동화|프롬프트|생산성|워크플로|단축어|맥북|아이폰|갤럭시|테크|앱/gu, 4],
    ],
  },
  desk: {
    id: 'desk',
    label: '데스크테리어',
    detail: '높이와 조명',
    audience: '책상에서 오래 일하는 2030',
    cues: [
      [/(데스크테리어|책상|모니터암|거치대|조명|케이블)$/u, 9],
      [/데스크테리어|책상|모니터\s?암|거치대|조명|스탠드|무드등|케이블|마우스패드|키보드|모니터|의자/gu, 4],
    ],
  },
  diary: {
    id: 'diary',
    label: '다이어리·기록',
    detail: '매일 한 줄',
    audience: '기록을 다시 시작하는 2030',
    cues: [
      [/(다이어리|다꾸|플래너|굿노트|만년필|저널|회고|기록)$/u, 8],
      [/다이어리|다꾸|플래너|굿노트|만년필|스티커|저널|회고|기록\s?습관|주간\s?리뷰|기록/gu, 3],
    ],
  },
  beauty: {
    id: 'beauty',
    label: '뷰티·패션·리뷰',
    detail: '톤과 사용량',
    audience: '색조·스킨을 비교하는 2030',
    cues: [
      [/(립|쿠션|섀도|톤|화장품|스킨|세럼|코디|착샷)$/u, 6],
      [/화장품|스킨|로션|세럼|크림|선크림|메이크업|색조|쿠션|립|아이섀도|향수|헤어|샴푸|네일|톤|봄웜|여름쿨|피부|모공|각질|파운데이션|블러셔|틴트|코디|패션|옷|착샷|체험단/gu, 4],
    ],
  },
  daily: {
    id: 'daily',
    label: '일상·브이로그',
    detail: '하루의 장면',
    audience: '하루를 기록하는 2030',
    cues: [
      [/(일상|브이로그|vlog|일기|하루살이|루틴)$/u, 9],
      [/브이로그|일상|일기|하루|주말|아침|저녁|루틴|집콕|휴일|혼밥|퇴근|출근|기록/gu, 3],
    ],
  },
  career: {
    id: 'career',
    label: '퇴사·커리어·개발',
    detail: '다음 한 걸음',
    audience: '이직·복귀를 준비하는 개발자·기획자',
    cues: [
      [/(커리어|이직|포트폴리오|이력서|면접)$/u, 7],
      [/퇴사|이직|커리어|개발자|개발|포트폴리오|이력서|면접|채용|깃허브|사이드\s?프로젝트|코딩|부트캠프|연봉|경력직|신입|취준|구직/gu, 3],
    ],
  },
  product: {
    id: 'product',
    label: '제품 리뷰',
    detail: '소음·무게·유지비',
    audience: '사기 전에 비교하는 2030',
    cues: [
      [/(리뷰|후기|사용기|언박싱|내돈내산)$/u, 7],
      [/마사지기|청소기|가습기|공기청정기|이어폰|헤드폰|마우스|노트북|태블릿|선풍기|드라이어|가전|언박싱|개봉|스펙|리뷰|후기|사용기|내돈내산|가성비|제품/gu, 3],
    ],
  },
  living: {
    id: 'living',
    label: '살림·수납',
    detail: '비우는 순서',
    audience: '신혼·1인 가구',
    cues: [
      [/(수납|인테리어|살림|정리법|주방)$/u, 7],
      [/수납|인테리어|주방|청소|빨래|살림|신혼집|원룸|오피스텔|가구|커튼|욕실|베란다|정돈/gu, 3],
    ],
  },
  recipe: {
    id: 'recipe',
    label: '요리·레시피',
    detail: '재료 순서',
    audience: '평일 저녁 10분으로 해결하는 1~2인 가구',
    cues: [
      [/(레시피|요리|식단|반찬|재료)$/u, 7],
      [/레시피|요리|반찬|재료|냉장고|전자레인지|에어프라이어|오븐|한그릇|도시락|샐러드|찌개|볶음|저녁|점심/gu, 3],
    ],
  },
  cafe: {
    id: 'cafe',
    label: '카페·맛집',
    detail: '동선과 메뉴',
    audience: '주말에 동네를 도는 2030',
    cues: [
      [/(카페|맛집|디저트|브런치)$/u, 7],
      [/카페|맛집|디저트|브런치|커피|베이커리|빵집|전포|광안리|해운대|연남|성수|을지로|한남|서면|망원/gu, 4],
    ],
  },
  content: {
    id: 'content',
    label: '콘텐츠·글쓰기',
    detail: '첫 문장과 구성',
    audience: '릴스·블로그를 운영하는 1인 크리에이터',
    cues: [
      [/(글쓰기|글쓰는법|대본|썸네일|릴스|쇼츠|블로그)$/u, 7],
      [/블로그|릴스|쇼츠|유튜브|인스타|스레드|콘텐츠|대본|글쓰|썸네일|구독자|조회수|해시태그|촬영|편집|업로드|기획안/gu, 4],
    ],
  },
};

/** 동네 이름을 도시보다 먼저 둔다. "부산 전포 카페"는 전포가 더 구체적이다. */
const PLACES = [
  '전포',
  '광안리',
  '해운대',
  '서면',
  '연남',
  '성수',
  '을지로',
  '한남',
  '망원',
  '제주',
  '부산',
  '서울',
  '강릉',
  '경주',
  '속초',
  '전주',
  '여수',
  '포항',
  '대구',
  '광주',
  '인천',
  '춘천',
  '오사카',
  '도쿄',
  '다낭',
  '방콕',
];

const ROLES = [
  '개발자',
  '디자이너',
  '기획자',
  '마케터',
  '프리랜서',
  '직장인',
  '대학생',
  '주부',
  '취준생',
  '창업자',
  '강사',
  '간호사',
];

/**
 * 주제 끝에 붙는 형식어. 이 말들은 "무엇에 대한 영상인지"를 말하지 않으므로
 * 이름에서 뺀다. "전세사기 주의할점"의 '주의할점'이 이름이 되면, 훅이
 * "주의할점, 한 달이면 달라집니다"처럼 주제를 잃는다.
 */
const FORMAT_WORDS = [
  '정리법',
  '사용기',
  '후기',
  '리뷰',
  '추천',
  '코스',
  '리스트',
  '방법',
  '완성',
  '기록',
  '일상',
  '브이로그',
  '루틴',
  '입문',
  '신청법',
  '공부법',
  '주의할점',
  '주의점',
  '체크리스트',
  '가이드',
  '노하우',
  '꿀팁',
  '총정리',
  '세팅',
  '셋업',
  '장단점',
  '준비물',
  '순서',
  '예산',
  '템플릿',
  '점검',
  '비교',
];

const FORMAT_TAIL = new RegExp(`(?:${FORMAT_WORDS.join('|')})$`, 'u');
/** "… 쓰는 법", "… 짜는 법", "… 고르는 법"처럼 서술이 붙은 꼬리. */
const PREDICATE_TAIL = /\s*(?:(?:쓰는|하는|짜는|고르는|만드는|찾는|보는|입는|먹는|찍는|사는)\s*(?:법|방법))$/u;

export interface ScriptDomainProfile {
  id: ScriptDomainId;
  label: string;
  detail: string;
  topic: string;
  /** 형식어를 뺀 주제("전세사기", "빈티지 디카"). */
  subject: string;
  /** 훅에 넣는 짧은 이름. 지식 팩이 걸리면 팩의 이름을 쓴다. */
  name: string;
  /** 주제 앞부분의 사람 묘사("퇴사한 30대 개발자"). 없으면 ''. */
  persona: string;
  /** 장소가 있으면 그 이름. */
  place: string;
  /** "2박3일", "3평"처럼 주제에 적힌 수치. */
  numbers: string[];
  /** 분류 근거(디버그·콘솔 표시용). */
  evidence: string[];
  /** 걸린 지식 팩. 없으면 null. */
  knowledge: KnowledgeMatch | null;
}

function stripFormatWords(topic: string): string {
  let subject = topic.replace(/[[\]{}"']/g, '').replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const before = subject;
    subject = subject
      .replace(PREDICATE_TAIL, '')
      .replace(FORMAT_TAIL, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (subject === before) break;
  }
  return subject.length === 0 ? topic.trim() : subject;
}

function detectPlace(topic: string): string {
  return PLACES.find((place) => topic.includes(place)) ?? '';
}

function detectPersona(topic: string, head: string): string {
  const role = ROLES.find((candidate) => topic.includes(candidate));
  const tokens = topic.split(/\s+/).filter(Boolean);
  const headIndex = tokens.findIndex((token) => token.replace(/[^\p{L}\p{N}]/gu, '') === head);
  const before = headIndex > 0 ? tokens.slice(0, headIndex) : tokens.slice(0, Math.max(0, tokens.length - 1));
  const cleaned = before
    .map((token) => token.replace(/[^\p{L}\p{N}]/gu, '').replace(/(의|은|는|이|가|을|를)$/u, ''))
    .filter((token) => token.length >= 2 && !FORMAT_TAIL.test(token));
  if (role) {
    const roleIndex = cleaned.findIndex((token) => token.includes(role));
    const kept = cleaned.slice(Math.max(0, roleIndex - 2), roleIndex + 1);
    const persona = (kept.length > 0 ? kept : [role]).join(' ');
    return persona.length <= 18 ? persona : role;
  }
  const joined = cleaned.join(' ').replace(/(의|은|는|이|가|을|를)$/u, '');
  return joined.length >= 3 && joined.length <= 14 ? joined : '';
}

/**
 * 도메인 분류.
 *
 * 1) 도메인별 단서를 가중치로 더한다(같은 단어를 두 번 세지 않는다).
 * 2) 주제에 걸린 지식 팩이 있으면 그 도메인에 6~12점을 더한다. "전세사기"처럼
 *    한 단어로 주제가 정해지는 경우, 일반 단서만으로는 일상으로 떨어진다.
 * 3) 단, "…일상", "…브이로그"로 끝나면 형식이 이기도록 팩 점수를 줄인다.
 * 4) 동점이면 더 좁은 도메인(디카 > 여행, 뷰티 > 제품)이 이긴다.
 */
export function classifyScriptDomain(topic: string, _language: Language = 'ko'): ScriptDomainProfile {
  const trimmed = topic.replace(/\s+/g, ' ').trim();
  const safeTopic = trimmed.length >= 2 ? trimmed : '오늘의 주제';
  const scores = new Map<ScriptDomainId, { score: number; evidence: string[] }>();
  const genreEnding = /(일상|브이로그|vlog)$/u.test(safeTopic);

  for (const id of SCRIPT_DOMAIN_IDS) {
    const meta = SCRIPT_DOMAIN_META[id];
    let score = 0;
    const evidence: string[] = [];
    for (const [pattern, weight] of meta.cues) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      const matches = safeTopic.match(new RegExp(pattern.source, flags));
      if (!matches) continue;
      const unique = Array.from(new Set(matches.map((match) => match.replace(/\s+/g, ''))));
      score += weight * Math.min(2, unique.length);
      evidence.push(...unique.map((match) => `${match}(+${weight})`));
    }
    scores.set(id, { score, evidence });
  }

  // 지식 팩: 주제가 확실한 단어는 그 도메인으로 강하게 당긴다.
  const packMatches = matchKnowledgePacks(safeTopic);
  const packBoostByDomain = new Map<ScriptDomainId, number>();
  for (const match of packMatches) {
    if (packBoostByDomain.has(match.pack.domain)) continue;
    const boost = (6 + Math.min(6, match.score)) * (genreEnding ? 0.4 : 1);
    packBoostByDomain.set(match.pack.domain, boost);
    const entry = scores.get(match.pack.domain);
    if (entry) {
      entry.score += boost;
      entry.evidence.push(`${match.pack.label}(+${Math.round(boost)})`);
    }
  }

  const ranked = [...scores.entries()]
    .filter(([, value]) => value.score > 0)
    .sort((a, b) => b[1].score - a[1].score || domainOrder(a[0]) - domainOrder(b[0]));
  const best = ranked[0]?.[0] ?? 'daily';
  const bestScore = scores.get(best)?.score ?? 0;

  const stripParticle = (token: string): string => token.replace(/(의|은|는|이|가|을|를)$/u, '');
  const subject = stripFormatWords(safeTopic);
  const place = detectPlace(safeTopic);
  const headToken = stripParticle(subject.split(/\s+/).at(-1) ?? subject);
  const persona = detectPersona(safeTopic, headToken);
  const numbers =
    safeTopic.match(/\d+(?:\.\d+)?\s?(?:박\s?\d+\s?일|평|초|분|시간|km|kg|만원|원|개|가지|번|개월|년|주|일|%|명)?/gu) ?? [];
  const headNoun = stripParticle(safeTopic.split(/\s+/).at(-1) ?? safeTopic);
  const knowledge = resolveKnowledge(safeTopic, best);

  return {
    id: best,
    label: SCRIPT_DOMAIN_META[best].label,
    detail: SCRIPT_DOMAIN_META[best].detail,
    topic: safeTopic,
    subject,
    name: travelName(best, knowledge?.pack.subject, shortName({ id: best, subject, place, persona, numbers, headNoun })),
    persona,
    place,
    numbers: numbers.slice(0, 3),
    evidence: (scores.get(best)?.evidence ?? []).slice(0, 4).concat(bestScore === 0 ? ['단서 없음 → 일상'] : []),
    knowledge,
  };
}

/**
 * 여행은 기간이 이름에 남아야 한다("제주 2박3일"). 지식 팩이 "제주 여행"으로
 * 덮으면 훅에서 2박3일이 사라지므로, 기간이 있는 여행은 기존 이름을 쓴다.
 */
function travelName(domain: ScriptDomainId, packSubject: string | undefined, fallback: string): string {
  if (!packSubject) return fallback;
  if (domain === 'travel' && /\d+박/.test(fallback)) return fallback;
  return packSubject;
}

function domainOrder(id: ScriptDomainId): number {
  // 좁은 도메인을 먼저 둔다: 동점일 때 "디카"가 "여행"을, "뷰티"가 "제품"을 이긴다.
  const order: ScriptDomainId[] = [
    'camera',
    'desk',
    'diary',
    'wedding',
    'language',
    'tech',
    'home',
    'beauty',
    'product',
    'recipe',
    'cafe',
    'living',
    'content',
    'info',
    'care',
    'money',
    'career',
    'travel',
    'daily',
  ];
  return order.indexOf(id);
}

function shortName(input: {
  id: ScriptDomainId;
  subject: string;
  place: string;
  persona: string;
  numbers: string[];
  headNoun: string;
}): string {
  const { id, subject, place, persona, numbers, headNoun } = input;
  const duration = numbers.find((value) => /^\d+박/.test(value.trim()));
  if (id === 'travel' && place) {
    return duration ? `${place} ${duration.replace(/\s+/g, '')}` : place;
  }
  if (id === 'cafe' && place) {
    return `${place} 카페`;
  }
  if (id === 'daily') {
    const role = ROLES.find((candidate) => persona.includes(candidate));
    const head = headNoun.length >= 2 && !/\)$/.test(headNoun) ? headNoun : '일상';
    if (role && head !== role) return `${role}의 ${head}`;
    return subject.length <= 12 ? subject : tailPhrase(subject);
  }
  if (subject.length <= 12) return subject;
  return tailPhrase(subject);
}

/** "부산 신혼집 3평 주방 수납" → "주방 수납", "월급 관리 고정지출" → "고정지출". */
function tailPhrase(subject: string): string {
  const tokens = subject.split(/\s+/).filter(Boolean);
  const last = tokens.at(-1) ?? subject;
  const candidate = last.length <= 2 && tokens.length >= 2 ? tokens.slice(-2).join(' ') : last;
  return (candidate.length <= 14 ? candidate : candidate.slice(0, 12)) || subject.slice(0, 12);
}

/** 도메인별 문장 은행의 타입(콘솔·테스트용). */
export type { ScriptDomainBank } from './bankTypes';

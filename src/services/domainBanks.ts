import type { ScriptDomainBank } from './bankTypes';
import type { ScriptDomainId } from './scriptDomains';
import { CULTURE_BANKS } from './banks/cultureBanks';
import { LIFE_BANKS } from './banks/lifeBanks';
import { MONEY_BANKS } from './banks/moneyBanks';

export type { ScriptDomainBank } from './bankTypes';

/**
 * 19개 도메인의 문장 은행을 한곳에 모은다.
 *
 * 승혜 님의 SNS 주제를 기준으로 잡은 도메인:
 *   집·부동산(home) · 정책·지원금(info) · 재테크(money) · 웨딩(wedding)
 *   여행(travel) · 디카(camera) · 운동·다이어트(care) · 외국어(language)
 *   테크·AI(tech) · 데스크테리어(desk) · 다이어리(diary) · 뷰티·패션(beauty)
 *   일상(daily) + 기존에 쓰던 커리어·제품·살림·요리·카페·콘텐츠
 *
 * 도메인을 나누는 기준은 "무엇에 대한 영상인가"가 아니라 "어떤 말로 말하는가"다.
 * 전세사기와 주방 수납은 둘 다 집이지만, 카메라 앞에서 해야 하는 말이 다르다.
 */
export const SCRIPT_DOMAIN_BANKS: Record<ScriptDomainId, ScriptDomainBank> = {
  ...LIFE_BANKS,
  ...MONEY_BANKS,
  ...CULTURE_BANKS,
} as Record<ScriptDomainId, ScriptDomainBank>;

/**
 * 도메인별 해시태그. 대본·OSMU·블로그가 같은 태그 집합을 쓴다.
 * 예전에는 카테고리 은행의 키워드를 썼는데, 일상 기록에 `#포트폴리오`가 붙는
 * 식으로 주제와 태그가 어긋났다.
 */
export const SCRIPT_DOMAIN_TAGS: Record<ScriptDomainId, string[]> = {
  home: ['#전세사기', '#등기부등본', '#전세보증보험', '#부동산', '#확정일자'],
  info: ['#지원금', '#신청방법', '#자격조건', '#정책', '#서류준비'],
  money: ['#재테크', '#고정지출', '#가계부', '#비상금', '#적금'],
  wedding: ['#결혼준비', '#스드메', '#웨딩예산', '#청첩장', '#신혼'],
  travel: ['#여행', '#주말여행', '#여행코스', '#국내여행', '#동선짜기'],
  camera: ['#빈티지디카', '#디카', '#필름감성', '#카메라세팅', '#색감'],
  care: ['#운동루틴', '#다이어트', '#홈트', '#러닝', '#식단'],
  language: ['#영어공부', '#회화', '#외국어', '#공부법', '#튜터링'],
  tech: ['#챗GPT', '#AI활용', '#업무자동화', '#노션', '#생산성'],
  desk: ['#데스크테리어', '#책상셋업', '#조명추천', '#모니터암', '#케이블정리'],
  diary: ['#다꾸', '#다이어리', '#기록', '#플래너', '#굿노트'],
  beauty: ['#뷰티', '#색조추천', '#화장품리뷰', '#발색', '#톤추천'],
  daily: ['#일상', '#브이로그', '#기록', '#하루', '#일상기록'],
  career: ['#커리어', '#이직', '#포트폴리오', '#개발자', '#퇴사'],
  product: ['#내돈내산', '#제품리뷰', '#가성비', '#언박싱', '#제품추천'],
  living: ['#수납정리', '#신혼집', '#살림', '#정리수납', '#주방정리'],
  recipe: ['#간단레시피', '#집밥', '#자취요리', '#전자레인지', '#한그릇'],
  cafe: ['#카페투어', '#카페추천', '#데이트코스', '#브런치', '#카페리스트'],
  content: ['#콘텐츠기획', '#글쓰기', '#릴스', '#썸네일', '#대본쓰기'],
};

/** 게시물 제목에 붙는 말. "… 2단계로 정리"를 일상·여행에 붙이지 않기 위한 표. */
export const SCRIPT_DOMAIN_TITLE_SUFFIX: Record<ScriptDomainId, string> = {
  home: '체크',
  info: '조건',
  money: '점검',
  wedding: '순서',
  travel: '코스',
  camera: '세팅',
  care: '루틴',
  language: '공부법',
  tech: '정리',
  desk: '셋업',
  diary: '기록',
  beauty: '비교',
  daily: '기록',
  career: '정리',
  product: '후기',
  living: '순서',
  recipe: '레시피',
  cafe: '리스트',
  content: '노트',
};

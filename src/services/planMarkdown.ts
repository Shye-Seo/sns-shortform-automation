import type { CrossChannelPlan } from '../types/plan';
import { CHANNEL_LABEL } from './patternLibrary';

/** Human-facing export of a plan: one Markdown file a writer can paste into Notion. */
export function planToMarkdown(plan: CrossChannelPlan): string {
  const lines: string[] = [];
  const profile = plan.profile;

  lines.push(`# ${plan.topic} — 크로스채널 기획안`);
  lines.push('');
  lines.push(`- 분류: ${profile.categoryLabel} · 대상: ${profile.subject} · 레버: ${profile.detail}`);
  lines.push(`- 앵글: ${plan.angle.label} (${plan.angle.hookStyle}) · 변주 ${plan.variation + 1}`);
  lines.push(`- 길이: ${plan.durationSec}초 · CTA: ${plan.ctaGoal} · 엔진: ${plan.engineDetail}`);
  lines.push(`- 생성: ${plan.createdAt}`);
  lines.push('');

  lines.push('## 1. 숏폼 대본 (릴스 · 쇼츠 공통)');
  lines.push('');
  lines.push('| # | 비트 | 나레이션 | 화면 자막 |');
  lines.push('| --- | --- | --- | --- |');
  plan.shorts.scenes.forEach((scene, index) => {
    lines.push(`| ${index + 1} | ${scene.beat} | ${scene.narration} | ${scene.onScreenText ?? ''} |`);
  });
  lines.push('');
  lines.push(`훅 스타일: ${plan.shorts.hookStyle}`);
  lines.push('');
  lines.push('**캡션**');
  lines.push('');
  lines.push('```');
  lines.push(plan.shorts.caption);
  lines.push('```');
  lines.push('');
  lines.push(`해시태그: ${plan.shorts.hashtags.join(' ')}`);
  lines.push('');

  lines.push('## 2. 유튜브 롱폼 목차');
  lines.push('');
  lines.push(`- 제목: ${plan.longform.title}`);
  lines.push(`- 썸네일 문구: ${plan.longform.thumbnailText} · 예상 ${plan.longform.estimatedMinutes}분`);
  lines.push('');
  lines.push(`콜드오픈: ${plan.longform.coldOpen}`);
  lines.push('');
  lines.push('| 챕터 | 시작 | 제목 | 목적 |');
  lines.push('| --- | --- | --- | --- |');
  plan.longform.chapters.forEach((chapter) => {
    const mm = Math.floor(chapter.startSec / 60);
    const ss = String(chapter.startSec % 60).padStart(2, '0');
    lines.push(`| ${chapter.index} | ${mm}:${ss} | ${chapter.title} | ${chapter.purpose} |`);
  });
  lines.push('');
  plan.longform.chapters.forEach((chapter) => {
    lines.push(`### ${chapter.index}. ${chapter.title}`);
    chapter.bullets.forEach((bullet) => lines.push(`- ${bullet}`));
    lines.push('');
  });
  lines.push(`설명란:`);
  lines.push('');
  lines.push('```');
  lines.push(plan.longform.description);
  lines.push('```');
  lines.push('');

  lines.push(`## 3. 블로그 뼈대 (${CHANNEL_LABEL[plan.blog.platform]})`);
  lines.push('');
  lines.push('제목 후보:');
  plan.blog.titleCandidates.forEach((title) => lines.push(`- ${title}`));
  lines.push('');
  lines.push(`- 메타 설명: ${plan.blog.metaDescription}`);
  lines.push(`- 핵심 키워드: ${plan.blog.primaryKeyword} / 보조: ${plan.blog.secondaryKeywords.join(', ')}`);
  lines.push(`- 목표 분량: 약 ${plan.blog.targetChars.toLocaleString('ko-KR')}자`);
  lines.push('');
  lines.push('**도입**');
  lines.push('');
  lines.push(plan.blog.intro);
  lines.push('');
  lines.push('**목차**');
  lines.push('');
  plan.blog.outline.forEach((section, index) => {
    lines.push(`#### H2-${index + 1}. ${section.heading}`);
    section.points.forEach((point) => lines.push(`- ${point}`));
    lines.push('');
  });
  lines.push('**자주 묻는 질문**');
  lines.push('');
  plan.blog.faq.forEach((entry) => {
    lines.push(`- Q. ${entry.question}`);
    lines.push(`  A. ${entry.answer}`);
  });
  lines.push('');
  lines.push('**마무리**');
  lines.push('');
  lines.push(plan.blog.closing);
  lines.push('');
  lines.push(`해시태그: ${plan.blog.hashtags.join(' ')}`);
  lines.push('');
  lines.push('SEO 메모:');
  plan.blog.seoNotes.forEach((note) => lines.push(`- ${note}`));
  lines.push('');

  lines.push('## 4. 리퍼포징 맵');
  lines.push('');
  lines.push('| 숏폼 | 롱폼 챕터 | 블로그 H2 |');
  lines.push('| --- | --- | --- |');
  plan.repurpose.forEach((row) => {
    lines.push(`| ${row.shortsIndex + 1}. ${row.shortsBeat} — ${row.shortsLine} | ${row.longformChapter} | ${row.blogHeading} |`);
  });
  lines.push('');

  if (plan.reference) {
    lines.push('## 5. 레퍼런스 분석');
    lines.push('');
    lines.push(`- 채널: ${CHANNEL_LABEL[plan.reference.channel]} · 문장 ${plan.reference.sentenceCount}개 · 평균 ${plan.reference.avgSentenceChars}자`);
    lines.push(`- 훅: ${plan.reference.hookStyle} — «${plan.reference.hookQuote}»`);
    lines.push(`- 번호 단계: ${plan.reference.numberedSteps}개 · 저장 유도: ${plan.reference.saveTriggers.length}회 · 질문: ${plan.reference.questionCount}개`);
    lines.push(`- CTA: ${plan.reference.ctaQuote ?? '-'}`);
    lines.push('');
    plan.reference.advice.forEach((entry) => lines.push(`- ${entry}`));
    lines.push('');
  }

  lines.push('## 6. 적용한 패턴');
  lines.push('');
  plan.appliedPatterns.forEach((pattern) => lines.push(`- ${pattern.label}: ${pattern.appliedIn}`));
  lines.push('');
  lines.push('## 7. 메모');
  lines.push('');
  plan.notes.forEach((note) => lines.push(`- ${note}`));
  lines.push('');

  return `${lines.join('\n')}`;
}

import { stableHash } from '../lib/ids';
import type {
  AppliedPattern,
  BlogPlan,
  BlogPlatform,
  CrossChannelPlan,
  LongformChapter,
  PlanInput,
  RepurposeRow,
  TopicProfile,
} from '../types/plan';
import type { CtaGoal } from '../types/script';
import type { SceneDraft } from './scriptEngine';
import { analyzeReference } from './contentAnalyzer';
import { PATTERN_BY_CHANNEL, PATTERN_LIBRARY, patternLabel } from './patternLibrary';
import { TOPIC_BANKS } from './topicBanks';
import { badgeFor, resolveAngle, writeTopicDrafts } from './topicDraftWriter';
import { classifyTopic } from './topicProfile';

/**
 * One topic, three channels, one plan.
 *
 * The shortform script is written first because it is the tightest form: if the
 * idea survives 30 seconds it survives a chapter list and an article. The
 * longform chapters and blog sections are then built from the same step lines,
 * which is why the repurposing map can point every Reel scene at the chapter
 * and heading that expands it instead of being a generic "make a blog too".
 */

const INTENT_SUFFIX: Record<TopicProfile['intent'], string> = {
  howto: '방법',
  review: '후기',
  checklist: '조건',
  compare: '비교',
  story: '기록',
  info: '정리',
};

const PLATFORM_CHARS: Record<BlogPlatform, number> = {
  'naver-blog': 2000,
  tistory: 1600,
  wordpress: 2400,
};

function hashOf(text: string): number {
  return parseInt(stableHash(text), 16);
}

function firstClause(text: string, max = 28): string {
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const clean = sentence.replace(/[.!?]$/, '').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > 8 ? cut.slice(0, space) : cut).trim()}…`;
}

export interface LongformDraft {
  title: string;
  coldOpen: string;
  chapters: LongformChapter[];
  estimatedMinutes: number;
  cta: string;
  thumbnailText: string;
  description: string;
}

export function buildLongform(profile: TopicProfile, scenes: SceneDraft[], variation: number): LongformDraft {
  const hook = scenes[0]?.narration ?? profile.subject;
  const problem = scenes.find((scene) => scene.beat === 'problem')?.narration ?? '';
  const steps = scenes.filter((scene) => scene.beat === 'solution');
  const cta = scenes[scenes.length - 1]?.narration ?? '';
  const chapters: LongformChapter[] = [];

  const push = (title: string, purpose: string, bullets: string[], fromShorts: number[]): void => {
    chapters.push({ index: chapters.length + 1, title, startSec: 0, purpose, bullets, fromShorts });
  };

  push(`왜 ${profile.detail}에서 막히는가`, '문제 정의 · 시청자가 겪는 장면을 말로 재현', [problem, `이 영상은 ${profile.subject}를 ${steps.length}단계로 정리합니다.`], [0, 1]);
  steps.forEach((step, index) => {
    push(firstClause(step.narration), `실행 ${index + 1}`, [step.narration, `화면: ${step.visual ?? '실사용 컷'}`], [index + 2]);
  });
  push('정리와 다음 단계', '요약 · 블로그·숏폼 연결', [steps.map((step) => firstClause(step.narration, 22)).join(' · '), cta, `자세한 순서는 블로그 «${profile.subject}» 글에 있습니다.`], [scenes.length - 1]);

  // Chapter length is a writing estimate, then start times are laid end to end.
  let cursor = 0;
  for (const chapter of chapters) {
    const weight = Math.min(2.6, Math.max(0.7, 0.6 + chapter.bullets.join(' ').length / 320));
    chapter.startSec = Math.round(cursor);
    cursor += weight * 60;
  }

  const titleVariants = [
    `${profile.subject}, ${profile.detail}부터 정리하는 순서`,
    `${profile.subject} — ${steps.length}단계면 충분합니다`,
    `${profile.subject} ${INTENT_SUFFIX[profile.intent]} | 직접 해보고 남은 것만`,
  ];
  const title = titleVariants[variation % titleVariants.length] as string;

  return {
    title,
    coldOpen: `${hook} ${problem}`.trim(),
    chapters,
    estimatedMinutes: Math.round((cursor / 60) * 10) / 10,
    cta,
    thumbnailText: `${profile.core} ${steps.length}단계`,
    description: [
      `${profile.subject}에서 실제로 막히는 건 ${profile.detail}입니다. 순서대로 정리했습니다.`,
      `챕터: ${chapters.map((chapter) => chapter.title).slice(0, 4).join(' / ')}`,
      `블로그 원문은 설명란 링크, 30초 요약은 릴스·쇼츠에 있습니다.`,
    ].join('\n'),
  };
}

export function buildBlog(
  profile: TopicProfile,
  scenes: SceneDraft[],
  platform: BlogPlatform,
  variation: number,
): BlogPlan {
  const bank = TOPIC_BANKS[profile.category];
  const hook = scenes[0]?.narration ?? profile.subject;
  const problem = scenes.find((scene) => scene.beat === 'problem')?.narration ?? '';
  const steps = scenes.filter((scene) => scene.beat === 'solution');
  const cta = scenes[scenes.length - 1]?.narration ?? '';
  const keywordSuffix = INTENT_SUFFIX[profile.intent];
  const primaryKeyword = `${profile.subject} ${keywordSuffix}`.trim().slice(0, 40);

  const titlePool = [
    `${profile.subject} ${profile.detail} 정리${profile.season ? ` (${seasonLabel(profile.season)})` : ''}`,
    `${profile.subject}, ${steps.length + 2}가지만 지키면 됩니다`,
    `${profile.subject} ${keywordSuffix} — ${profile.detail}부터 확인하세요`,
    `[${profile.categoryLabel}] ${profile.subject} 순서대로 정리`,
    `${profile.subject} 해보고 남은 것만 (${profile.detail} 체크)`,
  ];
  const titleCandidates = Array.from(new Set(titlePool))
    .map((title) => (platform === 'wordpress' && title.length > 60 ? title.slice(0, 59).trimEnd() : title))
    .slice(0, 4);

  const intro = [
    `${hook}`,
    `${problem}`,
    `${profile.subject}는 ${profile.detail}만 잡으면 나머지가 따라옵니다. 제가 실제로 쓰는 순서를 ${steps.length}단계로 정리했습니다.`,
  ].join(' ');

  const outline = [
    {
      heading: `왜 ${profile.detail}에서 막히는가`,
      points: [problem, `한 번에 다 하려는 계획이 원인입니다. 기준을 하나로 줄이면 판단이 빨라집니다.`],
    },
    ...steps.map((step, index) => ({
      heading: `${index + 1}. ${firstClause(step.narration, 32)}`,
      points: [step.narration, '사진: 이 단계에서 손이 움직이는 장면 1~2장', '체크: 하루에 몇 번 하는지 한 번 세어보기'],
    })),
    {
      heading: `${profile.subject}에서 자주 하는 실수`,
      points: [bank.problems[(hashOf(profile.topic) + variation + 1) % bank.problems.length] as string, '되돌리기 어려운 결정은 마지막에 합니다.'],
    },
  ];

  const faq = bank.faq.map((entry) => ({
    question: entry.question.replace(/\{s\}/g, profile.subject),
    answer: entry.answer.replace(/\{s\}/g, profile.subject),
  }));

  const closing = [cta, `같은 내용을 30초 영상으로도 정리했습니다. 위 릴스·쇼츠를 먼저 보면 순서가 더 빨리 잡힙니다.`].join(' ');

  const hashtags = Array.from(
    new Set(
      platform === 'wordpress'
        ? ['#' + profile.core, '#howto', '#guide']
        : [...[profile.core, ...bank.keywords].map((word) => `#${word.replace(/\s+/g, '')}`), '#일상기록', '#정보공유'],
    ),
  ).slice(0, 10);

  const metaDescription = `${profile.subject}에서 막히는 ${profile.detail}부터 순서대로 정리했습니다. ${steps.length}단계와 자주 하는 실수, 체크리스트까지 한 번에 확인하세요.`.slice(0, 155);

  const seoNotes = [
    PATTERN_BY_CHANNEL[platform].seoRule,
    `핵심 키워드 «${primaryKeyword}»를 제목·첫 문단·첫 H2에 한 번씩 넣습니다.`,
    platform === 'wordpress' ? 'FAQ 블록을 그대로 스키마로 옮길 수 있게 질문·답을 한 문장씩 유지합니다.' : '사진마다 설명 한 줄을 넣어 이미지 검색 유입을 만듭니다.',
  ];

  return {
    platform,
    titleCandidates,
    primaryKeyword,
    secondaryKeywords: [...bank.keywords, `${profile.subject} ${keywordSuffix}`.slice(0, 40)].slice(0, 5),
    metaDescription,
    targetChars: PLATFORM_CHARS[platform],
    intro,
    outline,
    faq,
    closing,
    hashtags,
    seoNotes,
  };
}

function seasonLabel(season: NonNullable<TopicProfile['season']>): string {
  return { spring: '봄', summer: '여름', autumn: '가을', winter: '겨울' }[season];
}

export function buildRepurpose(scenes: SceneDraft[], longform: LongformDraft, blog: BlogPlan): RepurposeRow[] {
  return scenes.map((scene, index) => {
    const chapter =
      longform.chapters.find((candidate) => candidate.fromShorts.includes(index)) ?? longform.chapters[0];
    const heading = blog.outline[Math.min(blog.outline.length - 1, Math.max(0, index - 1))];
    return {
      shortsIndex: index,
      shortsBeat: scene.beat,
      shortsLine: scene.narration,
      longformChapter: chapter ? `${chapter.index}. ${chapter.title}` : '-',
      blogHeading: heading ? heading.heading : '-',
    };
  });
}

export function planCrossChannel(input: PlanInput): CrossChannelPlan {
  const language = input.language ?? 'ko';
  const topic = input.topic.replace(/\s+/g, ' ').trim();
  const variation = Math.max(0, Math.round(input.variation ?? 0));
  const durationSec = Math.min(60, Math.max(10, input.durationSec ?? 45));
  const ctaGoal: CtaGoal = input.ctaGoal ?? 'save';
  const profile = classifyTopic(topic, language);
  const reference = input.reference?.text ? analyzeReference(input.reference.text, input.reference.channel) : null;

  // A pasted reference sets the starting angle; regeneration still rotates it.
  const angleChoice =
    input.angle && input.angle !== 'auto'
      ? input.angle
      : reference?.hookAngle && variation % 5 === 0
        ? reference.hookAngle
        : 'auto';
  const angle = resolveAngle(angleChoice, topic, variation);
  const shortform = writeTopicDrafts({ topic, durationSec, variation, angle: angle.id, ctaGoal, profile });

  const platform: BlogPlatform = input.blogPlatform ?? 'naver-blog';
  const longformDraft = buildLongform(profile, shortform.drafts, variation);
  const blog = buildBlog(profile, shortform.drafts, platform, variation);
  const repurpose = buildRepurpose(shortform.drafts, longformDraft, blog);

  const appliedPatterns: AppliedPattern[] = [
    {
      channel: 'instagram-reels',
      patternId: 'instagram-reels',
      label: patternLabel('instagram-reels'),
      appliedIn: `훅 ${PATTERN_BY_CHANNEL['instagram-reels'].hookWindowSec}초 · ${angle.hookStyle} · CTA 1개`,
    },
    {
      channel: 'youtube-shorts',
      patternId: 'youtube-shorts',
      label: patternLabel('youtube-shorts'),
      appliedIn: `결론 선노출 · 숫자 단계 ${shortform.drafts.filter((draft) => draft.beat === 'solution').length}개 · 검색 제목`,
    },
    {
      channel: 'youtube-longform',
      patternId: 'youtube-longform',
      label: patternLabel('youtube-longform'),
      appliedIn: `콜드오픈 + 챕터 ${longformDraft.chapters.length}개 · 약 ${longformDraft.estimatedMinutes}분`,
    },
    {
      channel: platform,
      patternId: platform,
      label: patternLabel(platform),
      appliedIn: `H2 ${blog.outline.length}개 + FAQ ${blog.faq.length}개 · 약 ${blog.targetChars.toLocaleString('ko-KR')}자`,
    },
  ];

  const notes = [
    `분류: ${profile.categoryLabel} · 앵글 ${angle.label}(${angle.hookStyle}) · 변주 ${variation + 1}`,
    '패턴은 공개 크리에이터 가이드와 상위 글에서 반복되는 구조를 규칙화한 것으로, 성과 수치를 실측한 데이터가 아닙니다.',
    `배지 문구는 주제에서 뽑았습니다: «${badgeFor(profile)}»`,
  ];
  if (reference) {
    notes.push(
      `레퍼런스 분석 신뢰도 ${Math.round(reference.confidence * 100)}% · 번호 단계 ${reference.numberedSteps}개 · 저장 유도 ${reference.saveTriggers.length}회`,
    );
  } else {
    notes.push('레퍼런스를 붙이면 훅 유형·단계 수·저장 유도를 그 글에서 읽어 앵글과 블로그 뼈대에 반영합니다.');
  }

  return {
    topic: profile.topic,
    language,
    profile,
    angle,
    variation,
    ctaGoal,
    durationSec,
    shorts: {
      channel: 'instagram-reels',
      hookStyle: angle.hookStyle,
      scenes: shortform.drafts,
      caption: shortform.caption,
      hashtags: shortform.hashtags,
      pattern: PATTERN_BY_CHANNEL['instagram-reels'],
    },
    longform: {
      title: longformDraft.title,
      coldOpen: longformDraft.coldOpen,
      chapters: longformDraft.chapters,
      estimatedMinutes: longformDraft.estimatedMinutes,
      cta: longformDraft.cta,
      thumbnailText: longformDraft.thumbnailText,
      description: longformDraft.description,
    },
    blog,
    repurpose,
    appliedPatterns,
    reference,
    engine: 'pattern-engine',
    engineDetail: '내장 패턴 엔진 · 외부 API 호출 없음',
    notes,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

/* ── LLM hand-off ─────────────────────────────────────────────────────────── */

export function buildPlannerPrompt(plan: CrossChannelPlan): string {
  const patterns = PATTERN_LIBRARY.map(
    (pattern) =>
      `- ${pattern.label}: ${pattern.format}. 훅 ${pattern.hookWindowSec}초, ${pattern.lengthNote} 구성 ${pattern.segments
        .map((segment) => `${segment.beat} ${segment.sharePct}%`)
        .join(' → ')}`,
  ).join('\n');

  return [
    '너는 한국 숏폼·블로그를 함께 운영하는 콘텐츠 기획자다. 아래 주제 하나를 릴스/쇼츠 대본, 유튜브 롱폼 목차, 블로그 글로 동시에 기획한다.',
    '',
    `주제: ${plan.topic}`,
    `분류: ${plan.profile.categoryLabel} · 핵심 대상: ${plan.profile.subject} · 레버: ${plan.profile.detail}`,
    `앵글: ${plan.angle.label} (${plan.angle.hookStyle}) — ${plan.angle.outline.join(' → ')}`,
    `목표 길이: ${plan.durationSec}초 · CTA: ${plan.ctaGoal}`,
    plan.reference
      ? `레퍼런스 분석: 훅 ${plan.reference.hookStyle}, 번호 단계 ${plan.reference.numberedSteps}개, 저장 유도 ${plan.reference.saveTriggers.length}회, 평균 문장 ${plan.reference.avgSentenceChars}자`
      : '레퍼런스 없음',
    '',
    '채널 패턴(이 구조를 지켜라):',
    patterns,
    '',
    '규칙:',
    '- 과장·낚시 표현 금지. 확인되지 않은 수치·효능 단정 금지.',
    '- 숏폼 장면 수는 4~6개, 각 나레이션은 12~40자, 첫 장면은 3.5초 안에 끝난다.',
    '- 롱폼 챕터는 4~6개, 블로그는 H2 4~7개 + FAQ 2개.',
    '- 블로그 문단은 숏폼과 같은 단계 순서를 쓴다(같은 내용을 길게 푸는 방식).',
    '',
    '아래 JSON 하나만 출력한다. 설명·코드블록 금지.',
    `{
  "shorts": { "hook": "훅 한 문장", "scenes": [{"narration": "", "onScreenText": "", "beat": "hook|problem|solution|cta"}], "caption": "", "hashtags": ["#"] },
  "longform": { "title": "", "coldOpen": "", "chapters": [{"title": "", "purpose": "", "bullets": [""]}], "cta": "", "thumbnailText": "" },
  "blog": { "title": "", "metaDescription": "", "intro": "", "sections": [{"heading": "", "points": [""]}], "faq": [{"question": "", "answer": ""}], "closing": "", "keywords": [""] }
}`,
  ]
    .join('\n');
}

export interface LlmPayload {
  shorts?: {
    hook?: string;
    scenes?: Array<{ narration?: string; onScreenText?: string; beat?: string }>;
    caption?: string;
    hashtags?: string[];
  };
  longform?: {
    title?: string;
    coldOpen?: string;
    chapters?: Array<{ title?: string; purpose?: string; bullets?: string[] }>;
    cta?: string;
    thumbnailText?: string;
  };
  blog?: {
    title?: string;
    metaDescription?: string;
    intro?: string;
    sections?: Array<{ heading?: string; points?: string[] }>;
    faq?: Array<{ question?: string; answer?: string }>;
    closing?: string;
    keywords?: string[];
  };
}

/** Overlay a model's rewrite on the pattern plan, keeping ids and linkage intact. */
export function applyLlmPlan(base: CrossChannelPlan, payload: LlmPayload, model: string): CrossChannelPlan {
  const scenes = base.shorts.scenes.map((scene, index) => {
    const written = payload.shorts?.scenes?.[index];
    if (!written?.narration) return scene;
    return {
      ...scene,
      narration: written.narration.trim(),
      onScreenText: (written.onScreenText ?? scene.onScreenText ?? '').slice(0, 42) || scene.onScreenText,
    };
  });

  const chapters = base.longform.chapters.map((chapter, index) => {
    const written = payload.longform?.chapters?.[index];
    if (!written) return chapter;
    return {
      ...chapter,
      title: (written.title ?? chapter.title).slice(0, 80),
      purpose: (written.purpose ?? chapter.purpose).slice(0, 120),
      bullets: (written.bullets ?? chapter.bullets).filter(Boolean).slice(0, 5),
    };
  });

  const outline = base.blog.outline.map((section, index) => {
    const written = payload.blog?.sections?.[index];
    if (!written) return section;
    return { heading: (written.heading ?? section.heading).slice(0, 80), points: (written.points ?? section.points).filter(Boolean).slice(0, 5) };
  });

  const faq = payload.blog?.faq?.length
    ? payload.blog.faq
        .filter((entry) => entry.question && entry.answer)
        .slice(0, 5)
        .map((entry) => ({ question: entry.question!.trim(), answer: entry.answer!.trim() }))
    : base.blog.faq;

  const blogTitle = payload.blog?.title?.trim();
  const titleCandidates = blogTitle
    ? [blogTitle, ...base.blog.titleCandidates.filter((title) => title !== blogTitle)].slice(0, 4)
    : base.blog.titleCandidates;

  const longform = {
    ...base.longform,
    title: payload.longform?.title?.trim() || base.longform.title,
    coldOpen: payload.longform?.coldOpen?.trim() || base.longform.coldOpen,
    chapters,
    cta: payload.longform?.cta?.trim() || base.longform.cta,
    thumbnailText: payload.longform?.thumbnailText?.trim() || base.longform.thumbnailText,
  };

  const blog: BlogPlan = {
    ...base.blog,
    titleCandidates,
    metaDescription: (payload.blog?.metaDescription?.trim() || base.blog.metaDescription).slice(0, 155),
    intro: payload.blog?.intro?.trim() || base.blog.intro,
    outline,
    faq,
    closing: payload.blog?.closing?.trim() || base.blog.closing,
    secondaryKeywords: payload.blog?.keywords?.length ? payload.blog.keywords.slice(0, 6) : base.blog.secondaryKeywords,
  };

  return {
    ...base,
    shorts: {
      ...base.shorts,
      scenes,
      caption: payload.shorts?.caption?.trim() || base.shorts.caption,
      hashtags: payload.shorts?.hashtags?.length ? payload.shorts.hashtags.slice(0, 10) : base.shorts.hashtags,
    },
    longform,
    blog,
    repurpose: buildRepurpose(scenes, { ...base.longform, ...longform }, blog),
    engine: 'claude',
    engineDetail: `Claude(${model})로 재작성 · 패턴 엔진 결과를 검증 후 덮어씀`,
    notes: [...base.notes, `LLM 재작성: ${model} · 장면 ${scenes.length}개, 챕터 ${chapters.length}개, H2 ${outline.length}개`],
  };
}

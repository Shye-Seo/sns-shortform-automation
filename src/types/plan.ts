import type { CtaGoal, Language } from './script';
import type { SceneDraft } from '../services/scriptEngine';

/**
 * Cross-channel planning types.
 *
 * A shortform script never lives alone: the same topic has to survive as a
 * Reels caption, a Shorts description, a longform chapter list and a blog
 * article that can rank. These types describe one topic planned across every
 * channel at once, with the repurposing map that ties the pieces together.
 */

export const CHANNELS = [
  'instagram-reels',
  'youtube-shorts',
  'youtube-longform',
  'naver-blog',
  'tistory',
  'wordpress',
] as const;
export type ChannelId = (typeof CHANNELS)[number];

export const BLOG_PLATFORMS = ['naver-blog', 'tistory', 'wordpress'] as const;
export type BlogPlatform = (typeof BLOG_PLATFORMS)[number];

export const ANGLES = ['problem-solve', 'numbers', 'checklist', 'before-after', 'contrarian'] as const;
export type AngleId = (typeof ANGLES)[number];
export type AngleChoice = AngleId | 'auto';

export const TOPIC_CATEGORIES = [
  'travel',
  'product',
  'info',
  'recipe',
  'home',
  'beauty',
  'money',
  'care',
  'work',
  'daily',
] as const;
export type TopicCategory = (typeof TOPIC_CATEGORIES)[number];

export interface TopicProfile {
  topic: string;
  /** Topic with format words ("리뷰", "정리법") stripped: what the video is about. */
  subject: string;
  /** Shortest noun phrase that still names the subject — used for the badge. */
  core: string;
  category: TopicCategory;
  categoryLabel: string;
  /** Category-specific lever the hooks point at ("이동 동선", "소음·무게"). */
  detail: string;
  intent: 'howto' | 'review' | 'checklist' | 'compare' | 'story' | 'info';
  audience: string;
  season: 'spring' | 'summer' | 'autumn' | 'winter' | null;
  modifiers: string[];
  numbers: string[];
}

export interface Angle {
  id: AngleId;
  label: string;
  hookStyle: string;
  /** When this angle beats the others for a topic. */
  bestFor: string;
  /** Beat plan after the hook, in words a writer can act on. */
  outline: string[];
}

export interface PatternSegment {
  /** Beat name inside the channel's own vocabulary. */
  beat: string;
  purpose: string;
  /** Share of the total, in percent. Channels do not share a skeleton. */
  sharePct: number;
}

export interface ChannelPattern {
  channel: ChannelId;
  label: string;
  format: string;
  hookWindowSec: number;
  lengthNote: string;
  segments: PatternSegment[];
  hookStyles: string[];
  saveTriggers: string[];
  shareTriggers: string[];
  titleRule: string;
  captionRule: string;
  seoRule: string;
  failureModes: string[];
  /** Where the structure comes from, stated without inventing measurements. */
  source: string;
}

export interface ReferenceAnalysis {
  channel: ChannelId;
  charCount: number;
  lineCount: number;
  sentenceCount: number;
  avgSentenceChars: number;
  hookQuote: string;
  hookStyle: string;
  hookAngle: AngleId | null;
  structure: Array<{ step: number; label: string; quote: string }>;
  numberedSteps: number;
  questionCount: number;
  numberCount: number;
  saveTriggers: string[];
  shareTriggers: string[];
  ctaQuote: string | null;
  titlePatterns: string[];
  /** What to copy from this reference, and what to leave out. */
  advice: string[];
  /** 0–1: how many signals the extractor actually found. */
  confidence: number;
}

export interface ShortsPlan {
  channel: ChannelId;
  hookStyle: string;
  scenes: SceneDraft[];
  caption: string;
  hashtags: string[];
  pattern: ChannelPattern;
}

export interface LongformChapter {
  index: number;
  title: string;
  startSec: number;
  purpose: string;
  bullets: string[];
  /** Shorts scene ids this chapter expands, for the repurposing map. */
  fromShorts: number[];
}

export interface LongformPlan {
  title: string;
  coldOpen: string;
  chapters: LongformChapter[];
  estimatedMinutes: number;
  cta: string;
  thumbnailText: string;
  description: string;
}

export interface BlogSection {
  heading: string;
  points: string[];
}

export interface BlogPlan {
  platform: BlogPlatform;
  titleCandidates: string[];
  primaryKeyword: string;
  secondaryKeywords: string[];
  metaDescription: string;
  targetChars: number;
  intro: string;
  outline: BlogSection[];
  faq: Array<{ question: string; answer: string }>;
  closing: string;
  hashtags: string[];
  seoNotes: string[];
}

export interface RepurposeRow {
  shortsIndex: number;
  shortsBeat: string;
  shortsLine: string;
  longformChapter: string;
  blogHeading: string;
}

export interface AppliedPattern {
  channel: ChannelId;
  patternId: string;
  label: string;
  appliedIn: string;
}

export interface CrossChannelPlan {
  topic: string;
  language: Language;
  profile: TopicProfile;
  angle: Angle;
  variation: number;
  ctaGoal: CtaGoal;
  durationSec: number;
  shorts: ShortsPlan;
  longform: LongformPlan;
  blog: BlogPlan;
  repurpose: RepurposeRow[];
  appliedPatterns: AppliedPattern[];
  reference: ReferenceAnalysis | null;
  engine: 'pattern-engine' | 'claude';
  engineDetail: string;
  notes: string[];
  createdAt: string;
}

export interface PlanInput {
  topic: string;
  durationSec?: number;
  language?: Language;
  variation?: number;
  angle?: AngleChoice;
  ctaGoal?: CtaGoal;
  reference?: { text: string; channel: ChannelId } | null;
  blogPlatform?: BlogPlatform;
  now?: Date;
}

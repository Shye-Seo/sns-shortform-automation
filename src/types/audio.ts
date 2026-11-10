import { z } from 'zod';

/** One spoken word with the exact span it occupies in the voice track. */
export const WordTimingSchema = z
  .object({
    index: z.number().int().min(0),
    text: z.string().min(1),
    startSec: z.number().min(0),
    endSec: z.number().min(0),
    sceneId: z.string().min(1).optional(),
    emphasis: z.boolean().default(false),
  })
  .refine((w) => w.endSec > w.startSec, {
    message: 'word end must be after its start',
  });
export type WordTiming = z.infer<typeof WordTimingSchema>;

/** A caption card: one to two lines shown for one span of time. */
export const CueSchema = z
  .object({
    index: z.number().int().min(1),
    startSec: z.number().min(0),
    endSec: z.number().min(0),
    lines: z.array(z.string().min(1)).min(1).max(2),
    words: z.array(WordTimingSchema),
    sceneId: z.string().min(1).optional(),
    /** True when the cue ends on a sentence boundary. */
    sentenceEnd: z.boolean().default(false),
  })
  .refine((c) => c.endSec > c.startSec, { message: 'cue end must be after its start' });
export type Cue = z.infer<typeof CueSchema>;

export const VoiceOverSchema = z.object({
  provider: z.string().min(1),
  voiceId: z.string().optional(),
  path: z.string().min(1),
  durationSec: z.number().positive(),
  sampleRate: z.number().int().min(8000),
  channels: z.number().int().min(1).max(2),
  /** `provider` = real forced alignment, `estimated` = weighted distribution. */
  alignmentSource: z.enum(['provider', 'estimated']),
  words: z.array(WordTimingSchema).min(1),
});
export type VoiceOver = z.infer<typeof VoiceOverSchema>;

export const AudioTrackSchema = z.object({
  kind: z.enum(['voice', 'music']),
  path: z.string().min(1),
  durationSec: z.number().positive(),
  sampleRate: z.number().int().min(8000),
  channels: z.number().int().min(1).max(2),
  gainDb: z.number().min(-40).max(12).default(0),
  loop: z.boolean().default(false),
});
export type AudioTrack = z.infer<typeof AudioTrackSchema>;

export const DuckingConfigSchema = z.object({
  /** Music level while the voice is speaking. */
  duckGain: z.number().min(0).max(1).default(0.15),
  /** Music level between lines — never full scale, it is background music. */
  baseGain: z.number().min(0).max(1).default(0.55),
  /** Ramp down duration once speech starts. */
  attackMs: z.number().min(10).max(2000).default(120),
  /** Ramp up duration once speech stops. */
  releaseMs: z.number().min(10).max(3000).default(280),
  /** Gaps shorter than this never release, to avoid audible pumping. */
  minGapMs: z.number().min(0).max(2000).default(180),
  /** Upward compression of the held level is not allowed above this. */
  maxGain: z.number().min(0.01).max(1).default(0.55),
  /** Ignore voice blips shorter than this when deciding to duck. */
  minVoiceMs: z.number().min(0).max(500).default(40),
});
export type DuckingConfig = z.infer<typeof DuckingConfigSchema>;

export const ENVELOPE_DEFAULTS: DuckingConfig = DuckingConfigSchema.parse({});

export const GainKeyframeSchema = z.object({
  tSec: z.number().min(0),
  gain: z.number().min(0).max(1),
});
export type GainKeyframe = z.infer<typeof GainKeyframeSchema>;

export const DuckingEnvelopeSchema = z.object({
  keyframes: z.array(GainKeyframeSchema).min(2),
  config: DuckingConfigSchema,
  durationSec: z.number().min(0),
  /** Share of the track that sits at duck level. */
  duckedRatio: z.number().min(0).max(1),
  rawVoiceSegments: z.number().int().min(0),
  mergedVoiceSegments: z.number().int().min(0),
});
export type DuckingEnvelope = z.infer<typeof DuckingEnvelopeSchema>;

export const SubtitleStyleSchema = z.object({
  fontName: z.string().default('Pretendard'),
  fontSizePx: z.number().min(24).max(200).default(96),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#FFFFFF'),
  highlightColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#FFD400'),
  outlineColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#0A0A0A'),
  outlinePx: z.number().min(0).max(20).default(6),
  shadowPx: z.number().min(0).max(20).default(2),
  /** `pulse` = only the spoken word is accented; `sweep` = karaoke fill. */
  mode: z.enum(['pulse', 'sweep']).default('pulse'),
  align: z.enum(['bottom-center']).default('bottom-center'),
  marginXPx: z.number().min(0).default(80),
  marginVPx: z.number().min(0).default(430),
});
export type SubtitleStyle = z.infer<typeof SubtitleStyleSchema>;

export const CueConfigSchema = z.object({
  maxLines: z.number().int().min(1).max(3).default(2),
  maxCharsPerLine: z.number().int().min(8).max(60).default(18),
  maxCueSec: z.number().min(0.8).max(6).default(2.8),
  minCueSec: z.number().min(0.2).max(2).default(0.6),
  maxCps: z.number().min(4).max(40).default(22),
  breakOnSentence: z.boolean().default(true),
});
export type CueConfig = z.infer<typeof CueConfigSchema>;

export const SubtitleBundleSchema = z.object({
  cues: z.array(CueSchema).min(1),
  style: SubtitleStyleSchema,
  srt: z.string(),
  vtt: z.string(),
  ass: z.string(),
  stats: z.object({
    cueCount: z.number().int(),
    wordCount: z.number().int(),
    longestCueSec: z.number(),
    maxCps: z.number(),
  }),
});
export type SubtitleBundle = z.infer<typeof SubtitleBundleSchema>;

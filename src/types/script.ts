import { z } from 'zod';

/**
 * The four-beat skeleton every 60-second shortform script is built on.
 * The order is enforced, not suggested: a hook that arrives late is a scroll.
 */
export const BEAT_ORDER = ['hook', 'problem', 'solution', 'cta'] as const;
export const BeatSchema = z.enum(BEAT_ORDER);
export type Beat = z.infer<typeof BeatSchema>;

export const LanguageSchema = z.enum(['ko', 'en']);
export type Language = z.infer<typeof LanguageSchema>;

export const HookTypeSchema = z.enum(['question', 'numbers', 'shock', 'howto', 'contrarian']);
export type HookType = z.infer<typeof HookTypeSchema>;

export const CtaGoalSchema = z.enum(['follow', 'save', 'comment', 'link']);
export type CtaGoal = z.infer<typeof CtaGoalSchema>;

export const GenerationSourceSchema = z.enum([
  'model',
  'heuristic',
  'heuristic-fallback',
]);
export type GenerationSource = z.infer<typeof GenerationSourceSchema>;

/**
 * Hard platform ceilings. These are validation limits, not preferences:
 * a caption of 2,201 characters is rejected by the Graph API after the
 * video has already been uploaded, which is the expensive way to learn it.
 */
export const LIMITS = {
  captionMaxChars: 2200,
  hashtagMaxCount: 30,
  titleMaxChars: 100,
  descriptionMaxChars: 5000,
  shortformMaxDurationSec: 60,
  hookMaxDurationSec: 3.5,
} as const;

/**
 * One scene = one narration block that is voiced, captioned and laid out as a
 * unit. `startSec`/`durationSec` are derived by the timeline builder, never
 * authored by hand, so they can be trusted by the renderer and the publishers.
 */
export const SceneSchema = z.object({
  id: z.string().min(1),
  beat: BeatSchema,
  index: z.number().int().min(0),
  narration: z.string().min(1).max(600),
  onScreenText: z.string().min(1).max(42).optional(),
  emphasis: z.array(z.string().min(1)).max(10).default([]),
  visual: z.string().max(240).optional(),
  startSec: z.number().min(0),
  durationSec: z.number().positive(),
  estimatedSpeechSec: z.number().min(0),
  syllables: z.number().int().min(0),
});
export type Scene = z.infer<typeof SceneSchema>;

export const ScriptMetricsSchema = z.object({
  totalDurationSec: z.number().min(0),
  speechSec: z.number().min(0),
  pauseSec: z.number().min(0),
  syllables: z.number().int().min(0),
  wordsPerMinute: z.number().min(0),
  syllablesPerSecond: z.number().min(0),
  hookDurationSec: z.number().min(0),
  ctaDurationSec: z.number().min(0),
});
export type ScriptMetrics = z.infer<typeof ScriptMetricsSchema>;

export const CompressionPassSchema = z.object({
  pass: z.enum(['parenthetical', 'filler', 'contraction', 'sentence', 'clause-trim']),
  sceneId: z.string(),
  removedText: z.string(),
  savedSec: z.number().min(0),
});

export const CompressionReportSchema = z.object({
  applied: z.boolean(),
  /** Time the raw draft would have needed, in seconds. */
  requestedSec: z.number().min(0),
  capacitySec: z.number().min(0),
  savedSec: z.number().min(0),
  passes: z.array(CompressionPassSchema),
});
export type CompressionReport = z.infer<typeof CompressionReportSchema>;

export const ShortformScriptSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string().min(1),
    title: z.string().min(1).max(LIMITS.titleMaxChars),
    topic: z.string().min(1).max(300),
    language: LanguageSchema,
    targetDurationSec: z
      .number()
      .min(10)
      .max(LIMITS.shortformMaxDurationSec),
    /** Narration speed factor applied on top of the base syllables/second. */
    speed: z.number().min(0.8).max(1.3),
    hookType: HookTypeSchema,
    ctaGoal: CtaGoalSchema,
    scenes: z.array(SceneSchema).min(4).max(16),
    caption: z.string().min(1).max(LIMITS.captionMaxChars),
    hashtags: z.array(z.string().regex(/^#\S+$/u)).max(LIMITS.hashtagMaxCount),
    generationSource: GenerationSourceSchema,
    keywords: z.array(z.string()).max(20).default([]),
    metrics: ScriptMetricsSchema,
    compression: CompressionReportSchema,
    createdAt: z.string().datetime(),
  })
  .superRefine((script, ctx) => {
    const { scenes } = script;

    // 1. Exactly one hook at the head, exactly one CTA at the tail.
    if (scenes[0]?.beat !== 'hook') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scenes', 0, 'beat'],
        message: 'first scene must be the hook',
      });
    }
    if (scenes[scenes.length - 1]?.beat !== 'cta') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scenes', scenes.length - 1, 'beat'],
        message: 'last scene must be the CTA',
      });
    }
    if (scenes.filter((s) => s.beat === 'hook').length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scenes'],
        message: 'exactly one hook scene is allowed',
      });
    }
    if (scenes.filter((s) => s.beat === 'cta').length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scenes'],
        message: 'exactly one CTA scene is allowed',
      });
    }

    // 2. Beats are ordered hook -> problem -> solution* -> cta.
    const orderIndex: Record<Beat, number> = { hook: 0, problem: 1, solution: 2, cta: 3 };
    let previous = 0;
    scenes.forEach((scene, i) => {
      const current = orderIndex[scene.beat];
      if (current < previous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scenes', i, 'beat'],
          message: `beat "${scene.beat}" appears after a later beat`,
        });
      }
      previous = Math.max(previous, current);
    });

    // 3. Timeline is contiguous and sums to the reported total.
    let cursor = 0;
    scenes.forEach((scene, i) => {
      if (Math.abs(scene.startSec - cursor) > 0.05) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scenes', i, 'startSec'],
          message: `scene starts at ${scene.startSec}s but timeline cursor is ${cursor}s`,
        });
      }
      cursor += scene.durationSec;
    });
    if (Math.abs(cursor - script.metrics.totalDurationSec) > 0.05) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metrics', 'totalDurationSec'],
        message: `timeline sums to ${cursor}s, metric says ${script.metrics.totalDurationSec}s`,
      });
    }

    // 4. The platform ceiling.
    if (script.metrics.totalDurationSec > script.targetDurationSec + 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metrics', 'totalDurationSec'],
        message: `total ${script.metrics.totalDurationSec}s exceeds target ${script.targetDurationSec}s`,
      });
    }
    if (script.metrics.totalDurationSec > LIMITS.shortformMaxDurationSec + 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metrics', 'totalDurationSec'],
        message: `total ${script.metrics.totalDurationSec}s exceeds the 60s ceiling`,
      });
    }

    // 5. The 3-second hook rule.
    const hook = scenes.find((s) => s.beat === 'hook');
    if (hook && hook.durationSec > LIMITS.hookMaxDurationSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scenes', 0, 'durationSec'],
        message: `hook runs ${hook.durationSec}s, over the ${LIMITS.hookMaxDurationSec}s budget`,
      });
    }
  });

export type ShortformScript = z.infer<typeof ShortformScriptSchema>;

/** Loose input shape accepted by the engine before planning. */
export const ScriptRequestSchema = z.object({
  topic: z.string().min(2).max(300),
  rawText: z.string().max(20000).optional(),
  language: LanguageSchema.default('ko'),
  targetDurationSec: z.number().min(10).max(60).default(60),
  speed: z.number().min(0.8).max(1.3).default(1),
  hookType: HookTypeSchema.default('question'),
  ctaGoal: CtaGoalSchema.default('save'),
  tone: z.enum(['friendly', 'expert', 'witty']).default('friendly'),
  hashtags: z.array(z.string()).max(30).optional(),
});
export type ScriptRequest = z.infer<typeof ScriptRequestSchema>;

export function parseScript(input: unknown): ShortformScript {
  return ShortformScriptSchema.parse(input);
}

export function safeParseScript(input: unknown) {
  return ShortformScriptSchema.safeParse(input);
}

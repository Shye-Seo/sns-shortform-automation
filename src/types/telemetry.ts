import { z } from 'zod';

export const HookAngleSchema = z.enum(['question', 'numbers', 'contrarian', 'howto', 'proof', 'shock']);
export type HookAngle = z.infer<typeof HookAngleSchema>;

export const HookVariantSchema = z.object({
  id: z.string().min(1).max(8),
  angle: HookAngleSchema,
  text: z.string().min(1).max(120),
  templateId: z.string().min(1).max(40),
  /** Estimated spoken length; the schema-level 3.5s ceiling applies here too. */
  hookSeconds: z.number().min(0).max(3.5),
});
export type HookVariant = z.infer<typeof HookVariantSchema>;

export const ExperimentSchema = z.object({
  id: z.string().min(1).max(64),
  topic: z.string().min(1).max(200),
  variants: z.array(HookVariantSchema).min(2).max(4),
  startedAt: z.string().datetime(),
  status: z.enum(['running', 'concluded']).default('running'),
});
export type Experiment = z.infer<typeof ExperimentSchema>;

export const MetricWindowSchema = z.enum(['24h', '7d']);
export type MetricWindow = z.infer<typeof MetricWindowSchema>;

export const TelemetrySourceSchema = z.enum(['meta-webhook', 'youtube-webhook', 'manual']);
export type TelemetrySource = z.infer<typeof TelemetrySourceSchema>;

/**
 * One webhook delivery. `eventId` is the provider's own id so a redelivered
 * webhook (Meta retries for 24h) does not double-count impressions.
 */
export const MetricSampleSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    experimentId: z.string().min(1).max(64),
    variantId: z.string().min(1).max(8),
    platform: z.enum(['instagram-reels', 'youtube-shorts']).default('instagram-reels'),
    window: MetricWindowSchema,
    capturedAt: z.string().datetime(),
    impressions: z.number().int().min(0),
    views3s: z.number().int().min(0),
    watchTimeSec: z.number().min(0),
    completions: z.number().int().min(0),
    likes: z.number().int().min(0).default(0),
    comments: z.number().int().min(0).default(0),
    shares: z.number().int().min(0).default(0),
    saves: z.number().int().min(0).default(0),
    source: TelemetrySourceSchema.default('manual'),
  })
  .superRefine((sample, ctx) => {
    if (sample.views3s > sample.impressions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'views3s cannot exceed impressions',
        path: ['views3s'],
      });
    }
    if (sample.completions > sample.views3s) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completions cannot exceed 3s views',
        path: ['completions'],
      });
    }
    const maxWatch = sample.views3s * 600;
    if (sample.watchTimeSec > maxWatch) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'watchTimeSec is implausible for the 3s view count',
        path: ['watchTimeSec'],
      });
    }
  });
export type MetricSample = z.infer<typeof MetricSampleSchema>;

export interface VariantAggregate {
  experimentId: string;
  variantId: string;
  window: MetricWindow;
  impressions: number;
  views3s: number;
  watchTimeSec: number;
  completions: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  /** Number of webhook samples folded in. */
  samples: number;
}

export interface VariantMetrics {
  variantId: string;
  window: MetricWindow;
  samples: number;
  impressions: number;
  /** 3-second view rate, 0–1. */
  viewRate3s: number;
  /** Completions / 3s views within the window (24h or 7d). */
  retention: number;
  /** Mean watched seconds per 3s view. */
  avgWatchSec: number;
  commentRate: number;
  /** likes + comments + shares + saves over impressions. */
  engagementRate: number;
}

/** Metrics that are ratios of counts and therefore testable with a z-test. */
export const PROPORTION_METRICS = ['viewRate3s', 'retention', 'commentRate'] as const;
export type ProportionMetric = (typeof PROPORTION_METRICS)[number];

export interface VariantScore {
  variantId: string;
  angle?: HookAngle;
  value: number;
  successes: number;
  trials: number;
  lower: number;
  upper: number;
  lift: number;
  pValue: number;
}

export interface ExperimentEvaluation {
  experimentId: string;
  metric: ProportionMetric;
  window: MetricWindow;
  status: 'winner' | 'inconclusive' | 'insufficient-data';
  winner: string | null;
  confidence: number;
  alpha: number;
  requiredSample: number;
  variants: VariantScore[];
  notes: string[];
}

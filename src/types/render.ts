import { z } from 'zod';
import { SubtitleStyleSchema } from './audio';

export const PlatformSchema = z.enum(['instagram-reels', 'youtube-shorts']);
export type Platform = z.infer<typeof PlatformSchema>;

export const CANVAS = {
  width: 1080,
  height: 1920,
  fps: 30,
  aspectRatio: '9:16',
} as const;

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Rect = z.infer<typeof RectSchema>;

export function rectRight(r: Rect): number {
  return r.x + r.w;
}

export function rectBottom(r: Rect): number {
  return r.y + r.h;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < rectRight(b) && rectRight(a) > b.x && a.y < rectBottom(b) && rectBottom(a) > b.y
  );
}

export const VideoLayerSchema = z.object({
  kind: z.enum([
    'background',
    'scrim',
    'caption',
    'badge',
    'progress',
    'watermark',
  ]),
  zIndex: z.number().int().min(0),
  rect: RectSchema,
  description: z.string(),
});
export type VideoLayer = z.infer<typeof VideoLayerSchema>;

export const OverlayLayoutSchema = z.object({
  platform: PlatformSchema,
  contentBox: RectSchema,
  badge: RectSchema.nullable(),
  caption: RectSchema,
  progress: RectSchema,
  watermark: RectSchema.nullable(),
  layers: z.array(VideoLayerSchema),
  subtitleStyle: SubtitleStyleSchema,
});
export type OverlayLayout = z.infer<typeof OverlayLayoutSchema>;

export const CollisionReportSchema = z.object({
  ok: z.boolean(),
  violations: z.array(
    z.object({
      layer: z.string(),
      zone: z.string(),
      overlapPx: z.number(),
      hint: z.string(),
    }),
  ),
});
export type CollisionReport = z.infer<typeof CollisionReportSchema>;

export const RenderStatusSchema = z.enum(['planned', 'rendered', 'failed']);
export type RenderStatus = z.infer<typeof RenderStatusSchema>;

export const RenderProbeSchema = z.object({
  container: z.string(),
  durationSec: z.number(),
  sizeBytes: z.number(),
  bitRate: z.number(),
  video: z.object({
    codec: z.string(),
    profile: z.string().optional(),
    width: z.number(),
    height: z.number(),
    fps: z.number(),
    pixFmt: z.string(),
    bitRate: z.number(),
  }),
  audio: z
    .object({
      codec: z.string(),
      sampleRate: z.number(),
      channels: z.number(),
      bitRate: z.number(),
    })
    .nullable(),
});
export type RenderProbe = z.infer<typeof RenderProbeSchema>;

export const RenderJobSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  platform: PlatformSchema,
  status: RenderStatusSchema,
  canvas: z.object({
    width: z.number().int(),
    height: z.number().int(),
    fps: z.number().int(),
  }),
  inputs: z.object({
    voicePath: z.string().min(1),
    musicPath: z.string().nullable(),
    backgroundPath: z.string().nullable(),
    subtitlePath: z.string().min(1),
  }),
  output: z.object({
    path: z.string().min(1),
    durationSec: z.number().positive(),
    expectedBytes: z.number().min(0),
  }),
  layout: OverlayLayoutSchema,
  encoding: z.object({
    container: z.literal('mp4'),
    videoCodec: z.literal('h264'),
    profile: z.literal('high'),
    level: z.string(),
    pixFmt: z.literal('yuv420p'),
    audioCodec: z.literal('aac'),
    audioBitrateKbps: z.number().int(),
    sampleRate: z.number().int(),
    faststart: z.boolean(),
  }),
  ffmpeg: z.object({
    bin: z.string(),
    args: z.array(z.string()),
  }),
  probe: RenderProbeSchema.nullable().default(null),
  warnings: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
});
export type RenderJob = z.infer<typeof RenderJobSchema>;

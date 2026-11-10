import { z } from 'zod';
import { PlatformSchema } from './render';

export const ApprovalSchema = z.object({
  approved: z.boolean(),
  approvedAt: z.string().datetime(),
  approvedBy: z.string().min(1),
  /** sha256 over script narration + caption + subtitle cues — the review fingerprint. */
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  notes: z.string().max(1000).optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const PublishPayloadSchema = z.object({
  projectId: z.string().min(1),
  platform: PlatformSchema,
  videoPath: z.string().min(1),
  caption: z.string().min(1).max(2200),
  hashtags: z.array(z.string().regex(/^#\S+$/u)).max(30),
  title: z.string().min(1).max(100).optional(),
  scheduleAt: z.string().datetime().optional(),
  visibility: z.enum(['public', 'unlisted', 'private']).default('public'),
  madeForKids: z.boolean().default(false),
  approval: ApprovalSchema,
});
export type PublishPayload = z.infer<typeof PublishPayloadSchema>;

export const PublishStatusSchema = z.enum([
  'skipped',
  'dry-run',
  'container-created',
  'uploaded',
  'published',
  'failed',
  'awaiting-review',
]);
export type PublishStatus = z.infer<typeof PublishStatusSchema>;

export const PublishResultSchema = z.object({
  platform: PlatformSchema,
  status: PublishStatusSchema,
  remoteId: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  attempts: z.number().int().min(0).default(0),
  messages: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
});
export type PublishResult = z.infer<typeof PublishResultSchema>;

export const PLATFORM_RULES = {
  'instagram-reels': {
    captionMaxChars: 2200,
    hashtagMaxCount: 30,
    maxDurationSec: 90,
    minDurationSec: 3,
    maxBytes: 100 * 1024 * 1024,
    requiredWidth: 1080,
    requiredHeight: 1920,
    publishPerDay: 25,
  },
  'youtube-shorts': {
    captionMaxChars: 5000,
    hashtagMaxCount: 30,
    maxDurationSec: 60,
    minDurationSec: 1,
    maxBytes: 128 * 1024 * 1024, // API resumable upload limit is far higher; this is our own guard
    requiredWidth: 1080,
    requiredHeight: 1920,
    publishPerDay: 6,
  },
} as const;

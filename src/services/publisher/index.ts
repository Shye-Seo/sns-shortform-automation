export * from './http';
export * from './preflightValidator';
export * from './instagramPublisher';
export * from './youtubePublisher';

import { ShortformError } from '../../lib/errors';
import { PublishPayloadSchema, type PublishPayload, type PublishResult } from '../../types/publish';
import type { PreflightReport } from './preflightValidator';
import type { InstagramPublisher } from './instagramPublisher';
import type { YoutubePublisher } from './youtubePublisher';

export interface PublishDependencies {
  instagram?: InstagramPublisher;
  youtube?: YoutubePublisher;
  preflight?: PreflightReport;
  /** Public URL for the rendered file — required by the Instagram API. */
  videoUrl?: string;
  /** Local file for the YouTube upload. */
  videoPath?: string;
  dryRun?: boolean;
  onProgress?: (sent: number, total: number) => void;
}

export interface PublishOutcome {
  result: PublishResult;
  platform: PublishPayload['platform'];
}

/**
 * Single entry point used by the CLI. It refuses to run without a passing
 * preflight and a valid approval, then dispatches to the platform publisher.
 */
export async function publishPayload(
  payloadInput: unknown,
  dependencies: PublishDependencies,
): Promise<PublishOutcome> {
  const payload = PublishPayloadSchema.parse(payloadInput);
  const dryRun = dependencies.dryRun ?? true;

  if (!dependencies.preflight) {
    throw new ShortformError('preflight report is required before publishing', {
      code: 'VALIDATION',
    });
  }
  if (!dependencies.preflight.ok && !dryRun) {
    throw new ShortformError('preflight failed; refusing to publish', {
      code: 'VALIDATION',
      details: { errors: dependencies.preflight.errors },
    });
  }

  if (payload.platform === 'instagram-reels') {
    if (!dependencies.instagram) {
      throw new ShortformError('Instagram is not configured (IG_USER_ID / IG_ACCESS_TOKEN)', {
        code: 'CONFIG',
      });
    }
    if (!dryRun && !dependencies.videoUrl) {
      throw new ShortformError('Instagram publishing needs a public --video-url', {
        code: 'VALIDATION',
      });
    }
    const result = await dependencies.instagram.publishReel(
      {
        videoUrl: dependencies.videoUrl ?? 'https://example.invalid/pending-upload.mp4',
        caption: payload.caption,
        shareToFeed: true,
        scheduleAt: payload.scheduleAt,
      },
      { dryRun },
    );
    return { result, platform: payload.platform };
  }

  if (!dependencies.youtube) {
    throw new ShortformError('YouTube is not configured (YOUTUBE_REFRESH_TOKEN 등)', {
      code: 'CONFIG',
    });
  }
  const result = await dependencies.youtube.publishShort(
    {
      title: payload.title ?? payload.caption.slice(0, 80),
      description: payload.caption,
      tags: payload.hashtags,
      visibility: payload.visibility,
      scheduleAt: payload.scheduleAt,
      madeForKids: payload.madeForKids,
      videoPath: dependencies.videoPath,
    },
    { dryRun, onProgress: dependencies.onProgress },
  );
  return { result, platform: payload.platform };
}

import { describe, expect, it } from 'vitest';
import { validateMedia, assertPublishable } from '../src/services/publisher/preflightValidator';
import type { RenderProbe } from '../src/types/render';

function probe(overrides: Partial<RenderProbe> = {}): RenderProbe {
  const base: RenderProbe = {
    container: 'mp4',
    durationSec: 42,
    sizeBytes: 40 * 1024 * 1024,
    bitRate: 9_200_000,
    video: {
      codec: 'h264',
      profile: 'High',
      width: 1080,
      height: 1920,
      fps: 30,
      pixFmt: 'yuv420p',
      bitRate: 8_800_000,
    },
    audio: { codec: 'aac', sampleRate: 48_000, channels: 2, bitRate: 192_000 },
  };
  return { ...base, ...overrides, video: { ...base.video, ...overrides.video } };
}

describe('preflight validator', () => {
  it('passes a fully compliant reels render', () => {
    const report = validateMedia(probe(), { platform: 'instagram-reels' });
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.summary).toContain('업로드 가능');
  });

  it('fails a horizontal video', () => {
    const report = validateMedia(probe({ video: { ...probe().video, width: 1920, height: 1080 } }), {
      platform: 'instagram-reels',
    });
    expect(report.ok).toBe(false);
    const ids = report.checks.filter((check) => check.status === 'fail').map((check) => check.id);
    expect(ids).toContain('resolution');
    expect(ids).toContain('aspect');
  });

  it('fails a clip longer than 60 seconds', () => {
    const report = validateMedia(probe({ durationSec: 61.5 }), { platform: 'instagram-reels' });
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toContain('영상 길이');
  });

  it('fails a file over the size cap', () => {
    const report = validateMedia(probe({ sizeBytes: 120 * 1024 * 1024 }), {
      platform: 'instagram-reels',
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'file-size')?.status).toBe('fail');
  });

  it('fails a non-4:2:0 pixel format', () => {
    const report = validateMedia(probe({ video: { ...probe().video, pixFmt: 'yuv444p10le' } }), {
      platform: 'youtube-shorts',
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'pix-fmt')?.status).toBe('fail');
  });

  it('fails a missing audio track', () => {
    const report = validateMedia(probe({ audio: null }), { platform: 'instagram-reels' });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'audio-track')?.status).toBe('fail');
  });

  it('fails an unsupported video codec', () => {
    const report = validateMedia(probe({ video: { ...probe().video, codec: 'hevc' } }), {
      platform: 'instagram-reels',
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'video-codec')?.status).toBe('fail');
  });

  it('warns but passes a Main profile', () => {
    const report = validateMedia(probe({ video: { ...probe().video, profile: 'Main' } }), {
      platform: 'instagram-reels',
    });
    expect(report.ok).toBe(true);
    expect(report.warnings.join(' ')).toContain('H.264 프로파일');
  });

  it('warns on an off-spec frame rate instead of failing', () => {
    const report = validateMedia(probe({ video: { ...probe().video, fps: 24 } }), {
      platform: 'instagram-reels',
    });
    expect(report.ok).toBe(true);
    expect(report.warnings.join(' ')).toContain('프레임레이트');
  });

  it('throws a typed error when asked to assert a failing report', () => {
    const report = validateMedia(probe({ durationSec: 90 }), { platform: 'youtube-shorts' });
    expect(() => assertPublishable(report)).toThrow(/preflight failed/);
  });

  it('accepts a custom duration ceiling', () => {
    const report = validateMedia(probe({ durationSec: 30 }), {
      platform: 'instagram-reels',
      maxDurationSec: 20,
    });
    expect(report.ok).toBe(false);
  });
});

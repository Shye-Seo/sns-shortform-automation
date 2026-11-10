import { ShortformError } from '../../lib/errors';
import { round } from '../../lib/ids';
import { PLATFORM_RULES } from '../../types/publish';
import type { Platform } from '../../types/render';
import type { RenderProbe } from '../../types/render';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  actual: string;
  expected: string;
  hint?: string;
}

export interface PreflightReport {
  ok: boolean;
  platform: Platform;
  checks: PreflightCheck[];
  errors: string[];
  warnings: string[];
  summary: string;
}

export interface PreflightOptions {
  platform: Platform;
  /** Overrides for tests and for tighter brand rules. */
  maxDurationSec?: number;
  maxBytes?: number;
  minBitrateKbps?: number;
  maxBitrateKbps?: number;
}

const DEFAULT_LIMITS = {
  width: 1080,
  height: 1920,
  fps: 30,
  maxDurationSec: 60,
  maxBytes: 100 * 1024 * 1024,
  minBitrateKbps: 4_000,
  maxBitrateKbps: 12_000,
} as const;

function check(
  id: string,
  label: string,
  status: CheckStatus,
  actual: string,
  expected: string,
  hint?: string,
): PreflightCheck {
  return hint ? { id, label, status, actual, expected, hint } : { id, label, status, actual, expected };
}

/**
 * Pre-upload validation. Every item here is a documented rejection reason:
 * wrong pixel format, an odd resolution, a missing audio track, a file over
 * the size cap. Catching them locally costs a second; catching them after a
 * 100MB upload costs the upload and a rate-limit slot.
 */
export function validateMedia(probe: RenderProbe, options: PreflightOptions): PreflightReport {
  const platform = options.platform;
  const rules = PLATFORM_RULES[platform];
  const maxDurationSec = options.maxDurationSec ?? Math.min(DEFAULT_LIMITS.maxDurationSec, rules.maxDurationSec);
  const maxBytes = options.maxBytes ?? Math.min(DEFAULT_LIMITS.maxBytes, rules.maxBytes);
  const minBitrateKbps = options.minBitrateKbps ?? DEFAULT_LIMITS.minBitrateKbps;
  const maxBitrateKbps = options.maxBitrateKbps ?? DEFAULT_LIMITS.maxBitrateKbps;
  const checks: PreflightCheck[] = [];

  const isMp4 = probe.container === 'mp4';
  checks.push(
    check(
      'container',
      '컨테이너',
      isMp4 ? 'pass' : 'fail',
      probe.container,
      'mp4',
      isMp4 ? undefined : '업로드 전 -movflags +faststart 로 mp4 리먹스하세요',
    ),
  );

  const resolutionOk = probe.video.width === DEFAULT_LIMITS.width && probe.video.height === DEFAULT_LIMITS.height;
  const aspect = probe.video.height > 0 ? probe.video.width / probe.video.height : 0;
  checks.push(
    check(
      'resolution',
      '해상도 (9:16)',
      resolutionOk ? 'pass' : 'fail',
      `${probe.video.width}x${probe.video.height}`,
      `${DEFAULT_LIMITS.width}x${DEFAULT_LIMITS.height}`,
      resolutionOk ? undefined : 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
    ),
  );
  checks.push(
    check(
      'aspect',
      '종횡비',
      Math.abs(aspect - 9 / 16) <= 0.005 ? 'pass' : 'fail',
      round(aspect, 4).toString(),
      round(9 / 16, 4).toString(),
    ),
  );

  const fpsOk = Math.abs(probe.video.fps - DEFAULT_LIMITS.fps) <= 0.5;
  checks.push(
    check(
      'fps',
      '프레임레이트',
      fpsOk ? 'pass' : probe.video.fps >= 24 && probe.video.fps <= 60 ? 'warn' : 'fail',
      `${probe.video.fps.toFixed(2)}fps`,
      `${DEFAULT_LIMITS.fps}fps`,
      fpsOk ? undefined : '가변 프레임레이트는 업로드 후 싱크가 밀릴 수 있습니다',
    ),
  );

  const codecOk = probe.video.codec === 'h264';
  checks.push(
    check('video-codec', '비디오 코덱', codecOk ? 'pass' : 'fail', probe.video.codec, 'h264', codecOk ? undefined : '-c:v libx264'),
  );

  const profile = (probe.video.profile ?? '').toLowerCase();
  const profileOk = profile.includes('high');
  checks.push(
    check(
      'video-profile',
      'H.264 프로파일',
      profileOk ? 'pass' : 'warn',
      probe.video.profile ?? 'unknown',
      'High',
      profileOk ? undefined : '릴스/쇼츠는 High 프로파일을 권장합니다',
    ),
  );

  checks.push(
    check(
      'pix-fmt',
      '픽셀 포맷',
      probe.video.pixFmt === 'yuv420p' ? 'pass' : 'fail',
      probe.video.pixFmt,
      'yuv420p',
      probe.video.pixFmt === 'yuv420p' ? undefined : '-pix_fmt yuv420p (4:4:4는 아이폰에서 재생이 깨집니다)',
    ),
  );

  const durationSec = probe.durationSec;
  const durationOk = durationSec <= maxDurationSec + 0.05 && durationSec >= rules.minDurationSec - 0.05;
  checks.push(
    check(
      'duration',
      '영상 길이',
      durationOk ? 'pass' : 'fail',
      `${round(durationSec, 2)}s`,
      `${rules.minDurationSec}–${maxDurationSec}s`,
      durationOk ? undefined : '플랫폼 상한을 넘으면 업로드가 거부되거나 잘립니다',
    ),
  );

  const sizeMb = probe.sizeBytes / 1024 / 1024;
  const sizeOk = probe.sizeBytes <= maxBytes;
  checks.push(
    check(
      'file-size',
      '파일 용량',
      sizeOk ? 'pass' : 'fail',
      `${sizeMb.toFixed(1)}MB`,
      `< ${(maxBytes / 1024 / 1024).toFixed(0)}MB`,
      sizeOk ? undefined : '-crf 값을 올리거나 비트레이트를 낮추세요',
    ),
  );

  const bitrateKbps = probe.video.bitRate > 0 ? probe.video.bitRate / 1000 : probe.bitRate / 1000;
  const bitrateStatus: CheckStatus =
    bitrateKbps >= minBitrateKbps && bitrateKbps <= maxBitrateKbps
      ? 'pass'
      : bitrateKbps > 0 && bitrateKbps < maxBitrateKbps * 1.5
        ? 'warn'
        : 'fail';
  checks.push(
    check(
      'bitrate',
      '비트레이트',
      bitrateStatus,
      `${Math.round(bitrateKbps)}kbps`,
      `${minBitrateKbps}–${maxBitrateKbps}kbps`,
      bitrateStatus === 'pass' ? undefined : '너무 낮으면 계단 현상, 너무 높으면 재인코딩됩니다',
    ),
  );

  if (!probe.audio) {
    checks.push(check('audio-track', '오디오 트랙', 'fail', 'none', 'aac 48kHz 2ch', '무음 영상은 릴스에서 저품질로 분류됩니다'));
  } else {
    checks.push(
      check(
        'audio-codec',
        '오디오 코덱',
        probe.audio.codec === 'aac' ? 'pass' : 'warn',
        probe.audio.codec,
        'aac',
        probe.audio.codec === 'aac' ? undefined : '-c:a aac -b:a 192k',
      ),
    );
    checks.push(
      check(
        'audio-rate',
        '샘플레이트',
        probe.audio.sampleRate >= 44_100 ? 'pass' : 'warn',
        `${probe.audio.sampleRate}Hz`,
        '48000Hz',
      ),
    );
    checks.push(
      check(
        'audio-channels',
        '채널',
        probe.audio.channels <= 2 ? 'pass' : 'warn',
        `${probe.audio.channels}ch`,
        '1–2ch',
      ),
    );
  }

  const errors = checks.filter((item) => item.status === 'fail').map((item) => `${item.label}: ${item.actual} (기대 ${item.expected})`);
  const warnings = checks.filter((item) => item.status === 'warn').map((item) => `${item.label}: ${item.actual} (권장 ${item.expected})`);
  const ok = errors.length === 0;

  return {
    ok,
    platform,
    checks,
    errors,
    warnings,
    summary: ok
      ? `업로드 가능: ${checks.filter((c) => c.status === 'pass').length}/${checks.length} 항목 통과${warnings.length ? `, 경고 ${warnings.length}` : ''}`
      : `업로드 불가: ${errors.length}개 항목 실패`,
  };
}

export function assertPublishable(report: PreflightReport): void {
  if (report.ok) return;
  throw new ShortformError(`preflight failed for ${report.platform}`, {
    code: 'VALIDATION',
    details: { errors: report.errors, warnings: report.warnings },
  });
}

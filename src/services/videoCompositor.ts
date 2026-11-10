import { writeFile, mkdir } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { ShortformError } from '../lib/errors';
import { round } from '../lib/ids';
import { commandExists, probeMedia, runCommand } from '../lib/media';
import { measureTextPx } from '../lib/text';
import { assColor, buildMixFilter, computeDuckingEnvelope } from './audioEngine';
import { formatAssTime } from '../lib/timecode';
import {
  CANVAS,
  type CollisionReport,
  type OverlayLayout,
  type Platform,
  type Rect,
  type RenderJob,
  type RenderProbe,
  type VideoLayer,
} from '../types/render';
import { PLATFORM_RULES } from '../types/publish';
import { SubtitleStyleSchema, type SubtitleStyle } from '../types/audio';

/**
 * Reserved UI rectangles per platform, in canvas pixels.
 *
 * These are the reason a render that "looks fine in Premiere" still gets its
 * last caption hidden behind Instagram's caption sheet. The values follow the
 * 2025 Reels / Shorts layouts at 1080x1920 and are intentionally conservative.
 */
export const PLATFORM_UI_ZONES: Record<Platform, Array<{ name: string; rect: Rect }>> = {
  'instagram-reels': [
    { name: 'top-bar', rect: { x: 0, y: 0, w: 1080, h: 150 } },
    { name: 'caption-sheet', rect: { x: 0, y: 1500, w: 1080, h: 420 } },
    { name: 'action-rail', rect: { x: 880, y: 980, w: 200, h: 580 } },
  ],
  'youtube-shorts': [
    { name: 'top-bar', rect: { x: 0, y: 0, w: 1080, h: 180 } },
    { name: 'caption-sheet', rect: { x: 0, y: 1580, w: 1080, h: 340 } },
    { name: 'action-rail', rect: { x: 900, y: 1080, w: 180, h: 540 } },
  ],
};

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

/** The largest rectangle that is not covered by platform UI. */
export function computeContentBox(platform: Platform): Rect {
  const zones = PLATFORM_UI_ZONES[platform];
  const top = Math.max(...zones.filter((z) => z.rect.y === 0).map((z) => z.rect.h), 0);
  const bottomZone = zones.find((z) => z.name === 'caption-sheet');
  const bottom = bottomZone ? bottomZone.rect.y : CANVAS.height;
  const rail = zones.find((z) => z.name === 'action-rail');
  const right = rail ? rail.rect.x : CANVAS.width;

  const margin = 60;
  return {
    x: margin,
    y: top + 36,
    w: Math.max(320, right - margin * 2),
    h: Math.max(320, bottom - top - 36 - 60),
  };
}

export interface LayoutOptions {
  style?: Partial<SubtitleStyle>;
  badgeText?: string;
  /** Two-line caption block height used to reserve space. */
  captionLines?: number;
}

/**
 * Place every overlay inside the content box, in painting order. Captions sit
 * above the action rail so a like/share button never covers a word.
 */
export function planOverlayLayout(platform: Platform, options: LayoutOptions = {}): OverlayLayout {
  const style = SubtitleStyleSchema.parse({ ...options.style });
  const contentBox = computeContentBox(platform);
  const lineHeight = Math.round(style.fontSizePx * 1.24);
  const lines = Math.min(2, Math.max(1, options.captionLines ?? 2));
  const captionHeight = lineHeight * lines;

  const progressHeight = 10;
  const gap = 26;
  const captionBottom = contentBox.y + contentBox.h;
  const captionTop = captionBottom - captionHeight;
  const caption: Rect = {
    x: contentBox.x,
    y: captionTop,
    w: contentBox.w,
    h: captionHeight,
  };
  const progress: Rect = {
    x: contentBox.x,
    y: captionBottom - progressHeight,
    w: contentBox.w,
    h: progressHeight,
  };
  // Captions must clear the progress bar.
  caption.h = Math.max(lineHeight, progress.y - gap - caption.y);

  const badgeText = options.badgeText ?? '';
  const badgeWidth = Math.min(
    contentBox.w,
    Math.round(measureTextPx(badgeText, 38) + 68),
  );
  const badge: Rect | null = badgeText
    ? { x: contentBox.x, y: contentBox.y - 26, w: Math.max(140, badgeWidth), h: 58 }
    : null;

  const watermark: Rect = {
    x: contentBox.x + contentBox.w - 84,
    y: contentBox.y - 26,
    w: 84,
    h: 84,
  };

  const layers: VideoLayer[] = [
    { kind: 'background', zIndex: 0, rect: { x: 0, y: 0, w: CANVAS.width, h: CANVAS.height }, description: '9:16 배경 (B롤 또는 단색)' },
    { kind: 'scrim', zIndex: 1, rect: { x: 0, y: Math.round(captionTop - 120), w: CANVAS.width, h: CANVAS.height - Math.round(captionTop - 120) }, description: '자막 가독성용 하단 스크림' },
    { kind: 'progress', zIndex: 2, rect: progress, description: '시청 지속율 유도 프로그레스 바' },
    { kind: 'caption', zIndex: 3, rect: caption, description: '단어별 키네틱 타이포그래피' },
  ];
  if (badge) layers.push({ kind: 'badge', zIndex: 4, rect: badge, description: '상단 카테고리 뱃지' });
  layers.push({ kind: 'watermark', zIndex: 5, rect: watermark, description: '워터마크' });

  return {
    platform,
    contentBox,
    badge,
    caption,
    progress,
    watermark,
    layers,
    subtitleStyle: style,
  };
}

/** Verify every layer clears the platform's UI. */
export function checkLayoutCollisions(layout: OverlayLayout, platform: Platform): CollisionReport {
  const zones = PLATFORM_UI_ZONES[platform];
  const violations: CollisionReport['violations'] = [];

  const checks: Array<{ layer: string; rect: Rect | null }> = [
    { layer: 'badge', rect: layout.badge },
    { layer: 'caption', rect: layout.caption },
    { layer: 'progress', rect: layout.progress },
    { layer: 'watermark', rect: layout.watermark },
  ];

  for (const check of checks) {
    if (!check.rect) continue;
    for (const zone of zones) {
      const area = overlapArea(check.rect, zone.rect);
      if (area > 0) {
        violations.push({
          layer: check.layer,
          zone: zone.name,
          overlapPx: Math.round(area),
          hint: `${check.layer} must stay outside ${zone.name} (${zone.rect.x},${zone.rect.y},${zone.rect.w}x${zone.rect.h})`,
        });
      }
    }
    const insideContent =
      check.rect.x >= layout.contentBox.x - 1 &&
      check.rect.y >= layout.contentBox.y - 30 &&
      check.rect.x + check.rect.w <= layout.contentBox.x + layout.contentBox.w + 1;
    if (!insideContent) {
      violations.push({
        layer: check.layer,
        zone: 'content-box',
        overlapPx: 0,
        hint: `${check.layer} is outside the usable text area`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

export interface OverlayAssOptions {
  badgeText?: string;
  watermarkText?: string;
  style: SubtitleStyle;
  layout: OverlayLayout;
}

/**
 * Badge and watermark live in their own ASS file so the caption file stays
 * pure subtitles (exportable to Reels' native caption tooling).
 */
export function buildOverlayAss(options: OverlayAssOptions & { durationSec: number }): string {
  const { layout, style, badgeText, watermarkText } = options;
  const badge = layout.badge;
  const watermark = layout.watermark;
  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Badge,${style.fontName},34,${assColor('#0A0A0A')},${assColor('#0A0A0A')},${assColor('#FFD400')},${assColor('#FFD400')},-1,0,0,0,100,100,0,0,3,2,0,7,24,24,0,1`,
    `Style: Mark,${style.fontName},30,${assColor('#FFFFFF')},${assColor('#FFFFFF')},${assColor('#000000')},${assColor('#000000')},0,0,0,0,100,100,0,0,1,2,0,5,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const end = formatAssTime(options.durationSec);
  if (badge && badgeText) {
    lines.push(
      `Dialogue: 1,0:00:00.00,${end},Badge,,0,0,0,,{\\an7\\pos(${badge.x},${badge.y})}${badgeText.replace(/[{}]/g, '')}`,
    );
  }
  if (watermark && watermarkText) {
    lines.push(
      `Dialogue: 1,0:00:00.00,${end},Mark,,0,0,0,,{\\an7\\pos(${watermark.x},${watermark.y})\\alpha&H40&}${watermarkText.replace(/[{}]/g, '')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ffmpeg composition
 * ──────────────────────────────────────────────────────────────────────────── */

export interface FilterGraphInput {
  durationSec: number;
  layout: OverlayLayout;
  subtitlePath: string;
  overlayPath?: string;
  hasBackgroundVideo: boolean;
  /** Input index of the background clip (0 = voice, then optional music). */
  backgroundInputIndex?: number;
  fps?: number;
}

/**
 * Video filter graph. Layer order is scrim -> progress -> captions -> badge,
 * i.e. exactly the z-index order in the layout, so a caption is never hidden
 * behind the scrim.
 */
export function buildVideoFilterGraph(input: FilterGraphInput): string {
  const fps = input.fps ?? CANVAS.fps;
  const duration = round(input.durationSec, 3);
  const { layout } = input;
  const parts: string[] = [];

  if (input.hasBackgroundVideo) {
    parts.push(
      `[${input.backgroundInputIndex ?? 2}:v]scale=${CANVAS.width}:${CANVAS.height}:force_original_aspect_ratio=increase,` +
        `crop=${CANVAS.width}:${CANVAS.height},setsar=1,fps=${fps},setsar=1[bg]`,
    );
  } else {
    parts.push(`color=c=0x111114:s=${CANVAS.width}x${CANVAS.height}:r=${fps}:d=${duration}[bg]`);
  }

  // Three stepped bands approximate a gradient without a full geq pass.
  const scrimTop = layout.caption.y - 140;
  const band = Math.round((CANVAS.height - scrimTop) / 3);
  parts.push(
    `[bg]drawbox=x=0:y=${scrimTop}:w=${CANVAS.width}:h=${band}:color=black@0.12:t=fill,` +
      `drawbox=x=0:y=${scrimTop + band}:w=${CANVAS.width}:h=${band}:color=black@0.2:t=fill,` +
      `drawbox=x=0:y=${scrimTop + band * 2}:w=${CANVAS.width}:h=${CANVAS.height - scrimTop - band * 2}:color=black@0.3:t=fill[scrimmed]`,
  );

  const progress = layout.progress;
  parts.push(
    `[scrimmed]drawbox=x=${progress.x}:y=${progress.y}:w='min(${progress.w}\\,max(0\\,(t/${duration})*${progress.w}))':` +
      `h=${progress.h}:color=0xFFD400@0.95:t=fill[prog]`,
  );

  const subFile = escapeFilterPath(input.subtitlePath);
  parts.push(`[prog]ass=filename=${subFile}[captioned]`);

  if (input.overlayPath) {
    parts.push(`[captioned]ass=filename=${escapeFilterPath(input.overlayPath)}[vout]`);
  } else {
    parts.push(`[captioned]null[vout]`);
  }

  return parts.join(';');
}

function escapeFilterPath(path: string): string {
  // ffmpeg filter option values are quoted; backslash colons and quotes so a
  // Windows drive letter or a quote in the filename cannot break the graph.
  const normalized = resolve(path).replace(/\\/g, '/');
  return `'${normalized.replace(/'/g, "\\'")}'`;
}

export interface EncodeOptions {
  durationSec: number;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  crf?: number;
}

export function buildEncodeArgs(options: EncodeOptions): string[] {
  const duration = round(options.durationSec, 3);
  const audioKbps = options.audioBitrateKbps ?? 192;
  const maxrate = Math.min(12_000, options.videoBitrateKbps ?? 9_000);
  return [
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', String(options.crf ?? 18),
    '-profile:v', 'high',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-r', String(CANVAS.fps),
    '-g', String(CANVAS.fps * 2),
    '-keyint_min', String(CANVAS.fps),
    '-sc_threshold', '0',
    '-maxrate', `${maxrate}k`,
    '-bufsize', `${maxrate * 2}k`,
    '-c:a', 'aac',
    '-b:a', `${audioKbps}k`,
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    '-t', String(duration),
  ];
}

export function estimateOutputBytes(durationSec: number, videoBitrateKbps = 9000, audioBitrateKbps = 192): number {
  return Math.round(((videoBitrateKbps + audioBitrateKbps) * 1000 * durationSec) / 8);
}

export interface RenderJobInput {
  scriptId: string;
  platform: Platform;
  voicePath: string;
  musicPath?: string;
  backgroundPath?: string;
  subtitlePath: string;
  overlayPath?: string;
  outputPath: string;
  durationSec: number;
  layout?: OverlayLayout;
  style?: Partial<SubtitleStyle>;
  badgeText?: string;
  ffmpegBin?: string;
  /** Voice segments used to compute the ducking envelope. */
  voiceSegments?: Array<{ startSec: number; endSec: number }>;
  musicGainDb?: number;
}

export function buildRenderJob(input: RenderJobInput): RenderJob {
  const layout =
    input.layout ?? planOverlayLayout(input.platform, { style: input.style, badgeText: input.badgeText });
  const durationSec = round(input.durationSec, 3);
  const outputPath = input.outputPath;

  const videoParts = [buildVideoFilterGraph({
    durationSec,
    layout,
    subtitlePath: resolve(input.subtitlePath),
    overlayPath: input.overlayPath ? resolve(input.overlayPath) : undefined,
    hasBackgroundVideo: Boolean(input.backgroundPath),
    backgroundInputIndex: input.musicPath ? 2 : 1,
  })];

  const inputs: string[] = ['-i', input.voicePath];
  if (input.musicPath) inputs.push('-i', input.musicPath);
  if (input.backgroundPath) inputs.push('-i', input.backgroundPath);

  // Music is input 1 only when it exists, so labels are resolved positionally.
  const voiceLabel = '0:a';
  const musicLabel = input.musicPath ? '1:a' : null;
  const mixFilter = buildMixFilterForJob({
    durationSec,
    voiceLabel,
    musicLabel,
    segments: input.voiceSegments ?? [],
    musicGainDb: input.musicGainDb,
  });

  const args = [
    '-y',
    '-hide_banner',
    ...inputs,
    '-filter_complex',
    `${videoParts.join(';')};${mixFilter}`,
    ...buildEncodeArgs({ durationSec }),
    outputPath,
  ];

  const warnings: string[] = [];
  if (input.durationSec > PLATFORM_RULES[input.platform].maxDurationSec) {
    warnings.push(
      `duration ${durationSec}s exceeds the ${input.platform} ceiling of ${PLATFORM_RULES[input.platform].maxDurationSec}s`,
    );
  }

  return {
    id: `job_${input.scriptId}`,
    projectId: input.scriptId,
    platform: input.platform,
    status: 'planned',
    canvas: { width: CANVAS.width, height: CANVAS.height, fps: CANVAS.fps },
    inputs: {
      voicePath: input.voicePath,
      musicPath: input.musicPath ?? null,
      backgroundPath: input.backgroundPath ?? null,
      subtitlePath: input.subtitlePath,
    },
    output: {
      path: outputPath,
      durationSec,
      expectedBytes: estimateOutputBytes(durationSec),
    },
    layout,
    encoding: {
      container: 'mp4',
      videoCodec: 'h264',
      profile: 'high',
      level: '4.1',
      pixFmt: 'yuv420p',
      audioCodec: 'aac',
      audioBitrateKbps: 192,
      sampleRate: 48_000,
      faststart: true,
    },
    ffmpeg: { bin: input.ffmpegBin ?? process.env.FFMPEG_PATH ?? 'ffmpeg', args },
    probe: null,
    warnings,
    createdAt: new Date().toISOString(),
  };
}

function buildMixFilterForJob(input: {
  durationSec: number;
  voiceLabel: string;
  musicLabel: string | null;
  segments: Array<{ startSec: number; endSec: number }>;
  musicGainDb?: number;
}): string {
  if (!input.musicLabel) {
    return buildMixFilter({
      durationSec: input.durationSec,
      voiceInputLabel: input.voiceLabel,
      musicInputLabel: null,
      envelope: computeDuckingEnvelope({
        segments: input.segments,
        durationSec: input.durationSec,
      }),
    });
  }
  const envelope = computeDuckingEnvelope({
    segments: input.segments,
    durationSec: input.durationSec,
  });
  return buildMixFilter({
    durationSec: input.durationSec,
    voiceInputLabel: input.voiceLabel,
    musicInputLabel: input.musicLabel,
    envelope,
    musicGainDb: input.musicGainDb,
  });
}

export interface RenderExecutionOptions {
  execute?: boolean;
  ffmpegBin?: string;
  timeoutMs?: number;
  probe?: typeof probeMedia;
}

export async function renderJob(job: RenderJob, options: RenderExecutionOptions = {}): Promise<RenderJob> {
  if (!options.execute) return { ...job, status: 'planned' };

  const bin = options.ffmpegBin ?? job.ffmpeg.bin;
  const available = await commandExists(bin);
  if (!available) {
    throw new ShortformError(`${bin} is not installed or not on PATH`, {
      code: 'MEDIA',
      details: { hint: 'install ffmpeg or run with --plan to emit the command only' },
    });
  }

  const result = await runCommand(bin, job.ffmpeg.args, { timeoutMs: options.timeoutMs ?? 15 * 60_000 });
  if (result.code !== 0) {
    return {
      ...job,
      status: 'failed',
      warnings: [...job.warnings, result.stderr.slice(-1200)],
    };
  }

  const probe = await (options.probe ?? probeMedia)(job.output.path);
  return { ...job, status: 'rendered', probe };
}

/** Write a runnable shell script so a human can re-render by hand. */
export async function writeRenderScript(job: RenderJob, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${basename(job.output.path, '.mp4')}.sh`);
  const quoted = [job.ffmpeg.bin, ...job.ffmpeg.args]
    .map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`))
    .join(' ');
  await writeFile(path, `#!/usr/bin/env bash\nset -euo pipefail\n${quoted}\n`, { mode: 0o755 });
  return path;
}

export function describeProbe(probe: RenderProbe): string {
  const audio = probe.audio
    ? `${probe.audio.codec} ${probe.audio.sampleRate}Hz ${probe.audio.channels}ch`
    : 'no audio';
  return `${probe.video.width}x${probe.video.height} ${probe.video.fps.toFixed(2)}fps ${probe.video.codec}/${probe.video.pixFmt} · ${probe.durationSec.toFixed(2)}s · ${(probe.sizeBytes / 1024 / 1024).toFixed(1)}MB · ${audio}`;
}

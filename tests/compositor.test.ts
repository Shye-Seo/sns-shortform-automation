import { describe, expect, it } from 'vitest';
import {
  buildEncodeArgs,
  buildRenderJob,
  buildVideoFilterGraph,
  checkLayoutCollisions,
  computeContentBox,
  estimateOutputBytes,
  planOverlayLayout,
  rectsOverlap,
  renderJob,
  buildOverlayAss,
  PLATFORM_UI_ZONES,
} from '../src/services/videoCompositor';
import { CANVAS, type Platform, type RenderProbe } from '../src/types/render';
import { SubtitleStyleSchema } from '../src/types/audio';

const PLATFORMS: Platform[] = ['instagram-reels', 'youtube-shorts'];

describe('platform safe areas', () => {
  it.each(PLATFORMS)('keeps every overlay out of the UI for %s', (platform) => {
    const layout = planOverlayLayout(platform, { badgeText: '주방수납' });
    const report = checkLayoutCollisions(layout, platform);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it.each(PLATFORMS)('places captions above the progress bar for %s', (platform) => {
    const layout = planOverlayLayout(platform);
    expect(layout.caption.y + layout.caption.h).toBeLessThanOrEqual(layout.progress.y);
  });

  it.each(PLATFORMS)('fits overlays inside the content box for %s', (platform) => {
    const layout = planOverlayLayout(platform, { badgeText: '주방수납' });
    const box = layout.contentBox;
    for (const rect of [layout.caption, layout.progress, layout.badge, layout.watermark]) {
      if (!rect) continue;
      expect(rect.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(rect.x + rect.w).toBeLessThanOrEqual(box.x + box.w + 1);
    }
  });

  it('reserves the right action rail instead of centring captions on the canvas', () => {
    const reels = computeContentBox('instagram-reels');
    const shorts = computeContentBox('youtube-shorts');
    expect(reels.x + reels.w).toBeLessThanOrEqual(880);
    expect(shorts.x + shorts.w).toBeLessThanOrEqual(900);
    expect(reels.y).toBeGreaterThan(110);
  });

  it('detects a caption pushed into the caption sheet', () => {
    const layout = planOverlayLayout('instagram-reels');
    const broken = {
      ...layout,
      caption: { x: 60, y: 1600, w: 800, h: 200 },
    };
    const report = checkLayoutCollisions(broken as typeof layout, 'instagram-reels');
    expect(report.ok).toBe(false);
    expect(report.violations.some((violation) => violation.zone === 'caption-sheet')).toBe(true);
  });

  it('detects a watermark under the action rail', () => {
    const layout = planOverlayLayout('instagram-reels');
    const broken = {
      ...layout,
      watermark: { x: 900, y: 1100, w: 84, h: 84 },
    };
    const report = checkLayoutCollisions(broken as typeof layout, 'instagram-reels');
    expect(report.violations.some((violation) => violation.zone === 'action-rail')).toBe(true);
  });

  it('exposes the reserved zones for both platforms', () => {
    expect(PLATFORM_UI_ZONES['instagram-reels'].map((zone) => zone.name)).toContain('action-rail');
    expect(PLATFORM_UI_ZONES['youtube-shorts'].map((zone) => zone.name)).toContain('caption-sheet');
  });

  it('has a rectangle intersection predicate', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 5, h: 5 })).toBe(true);
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBe(false);
  });

  it('honours a larger caption font when reserving space', () => {
    const small = planOverlayLayout('instagram-reels', { style: { fontSizePx: 64 } });
    const large = planOverlayLayout('instagram-reels', { style: { fontSizePx: 120 } });
    expect(large.caption.h).toBeGreaterThan(small.caption.h);
  });
});

describe('filter graph', () => {
  const layout = planOverlayLayout('instagram-reels', { badgeText: '주방수납' });

  it('starts from a colour canvas when there is no B-roll', () => {
    const graph = buildVideoFilterGraph({
      durationSec: 38,
      layout,
      subtitlePath: '/tmp/captions.ass',
      overlayPath: '/tmp/overlay.ass',
      hasBackgroundVideo: false,
    });
    expect(graph).toContain(`color=c=0x111114:s=${CANVAS.width}x${CANVAS.height}`);
    expect(graph).toContain("ass=filename='/tmp/captions.ass'");
    expect(graph.endsWith('[vout]')).toBe(true);
  });

  it('scales and crops a B-roll clip to 9:16', () => {
    const graph = buildVideoFilterGraph({
      durationSec: 30,
      layout,
      subtitlePath: '/tmp/captions.ass',
      hasBackgroundVideo: true,
      backgroundInputIndex: 1,
    });
    expect(graph).toContain('[1:v]scale=1080:1920:force_original_aspect_ratio=increase');
    expect(graph).toContain('crop=1080:1920');
  });

  it('draws a stepped scrim but leaves the progress bar to ASS', () => {
    const graph = buildVideoFilterGraph({
      durationSec: 40,
      layout,
      subtitlePath: '/tmp/captions.ass',
      hasBackgroundVideo: false,
    });
    expect((graph.match(/drawbox=x=0:y=\d+/g) ?? []).length).toBe(10);
    // drawbox evaluates its geometry once, so a time-based bar must not live here.
    expect(graph).not.toContain("w='min(");
  });

  it('has balanced labels so ffmpeg can parse it', () => {
    const graph = buildVideoFilterGraph({
      durationSec: 12,
      layout,
      subtitlePath: '/tmp/captions.ass',
      overlayPath: '/tmp/overlay.ass',
      hasBackgroundVideo: true,
    });
    const opens = graph.match(/\[/g) ?? [];
    const closes = graph.match(/\]/g) ?? [];
    expect(opens.length).toBe(closes.length);
  });
});

describe('overlay ASS', () => {
  const layout = planOverlayLayout('instagram-reels', { badgeText: '주방수납' });

  it('animates the progress bar with the subtitle clock', () => {
    const ass = buildOverlayAss({ durationSec: 33.12, style: SubtitleStyleSchema.parse({}), layout, badgeText: '주방수납' });
    expect(ass).toContain('\\fscx1\\t(0,33120,\\fscx100)');
    expect(ass).toContain(`\\pos(${layout.progress.x},${layout.progress.y})`);
    // A track and a fill event, both carrying a drawing block.
    expect((ass.match(/\\p1/g) ?? []).length).toBe(2); // track + fill
    expect((ass.match(/\\p0/g) ?? []).length).toBe(2);
  });

  it('draws the badge inside its reserved rectangle', () => {
    const ass = buildOverlayAss({ durationSec: 10, style: SubtitleStyleSchema.parse({}), layout, badgeText: '주방수납' });
    const badgeY = layout.badge?.y as number;
    expect(ass).toContain(`\\pos(${layout.badge?.x},${badgeY})`);
    expect(ass).toContain('주방수납');
  });

  it('passes a font directory to libass when one is configured', () => {
    const graph = buildVideoFilterGraph({
      durationSec: 10,
      layout,
      subtitlePath: '/tmp/captions.ass',
      overlayPath: '/tmp/overlay.ass',
      fontsDir: '/tmp/fonts',
      hasBackgroundVideo: false,
    });
    expect(graph).toContain(":fontsdir='/tmp/fonts'");
  });
});

describe('encode settings', () => {
  it('requests H.264 High, yuv420p, faststart and AAC', () => {
    const args = buildEncodeArgs({ durationSec: 38.43 }).join(' ');
    expect(args).toContain('-c:v libx264');
    expect(args).toContain('-profile:v high');
    expect(args).toContain('-pix_fmt yuv420p');
    expect(args).toContain('-c:a aac');
    expect(args).toContain('-movflags +faststart');
    expect(args).toContain('-t 38.43');
    expect(args).toContain('-maxrate 9000k');
  });

  it('estimates an output size under the 100MB cap for a 60s video', () => {
    const bytes = estimateOutputBytes(60);
    expect(bytes).toBeLessThan(100 * 1024 * 1024);
  });
});

describe('render job', () => {
  const job = buildRenderJob({
    scriptId: 'sf_test',
    platform: 'instagram-reels',
    voicePath: '/tmp/voice.wav',
    subtitlePath: '/tmp/captions.ass',
    overlayPath: '/tmp/overlay.ass',
    outputPath: '/tmp/render.mp4',
    durationSec: 38.43,
    badgeText: '주방수납',
    voiceSegments: [{ startSec: 0, endSec: 1 }, { startSec: 2, endSec: 3 }],
  });

  it('is a plan until executed', () => {
    expect(job.status).toBe('planned');
    expect(job.canvas).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(job.inputs.voicePath).toBe('/tmp/voice.wav');
  });

  it('mixes voice without music by default', () => {
    const filterIndex = job.ffmpeg.args.indexOf('-filter_complex');
    const filter = job.ffmpeg.args[filterIndex + 1] as string;
    expect(filter).toContain('[0:a]apad');
    expect(filter).not.toContain('amix=inputs=2');
  });

  it('duck music when a bed is provided', () => {
    const withMusic = buildRenderJob({
      scriptId: 'sf_music',
      platform: 'youtube-shorts',
      voicePath: '/tmp/voice.wav',
      musicPath: '/tmp/music.mp3',
      subtitlePath: '/tmp/captions.ass',
      outputPath: '/tmp/render.mp4',
      durationSec: 20,
      voiceSegments: [{ startSec: 1, endSec: 3 }],
    });
    const filterIndex = withMusic.ffmpeg.args.indexOf('-filter_complex');
    const filter = withMusic.ffmpeg.args[filterIndex + 1] as string;
    expect(filter).toContain('[1:a]atrim=0:20');
    expect(filter).toContain("volume=eval=frame:volume='if(");
    expect(filter).toContain('amix=inputs=2');
    // The background video would be input 2 when music is input 1.
    expect(withMusic.inputs.musicPath).toBe('/tmp/music.mp3');
  });

  it('warns when the clip is longer than the platform allows', () => {
    const tooLong = buildRenderJob({
      scriptId: 'sf_long',
      platform: 'youtube-shorts',
      voicePath: '/tmp/voice.wav',
      subtitlePath: '/tmp/captions.ass',
      outputPath: '/tmp/render.mp4',
      durationSec: 75,
    });
    expect(tooLong.warnings[0]).toContain('exceeds');
  });

  it('does not encode unless asked', async () => {
    const planned = await renderJob(job, { execute: false });
    expect(planned.status).toBe('planned');
    expect(planned.probe).toBeNull();
  });

  it('refuses to execute when ffmpeg is missing', async () => {
    const fakeProbe = async (): Promise<RenderProbe> => {
      throw new Error('should not be called');
    };
    await expect(
      renderJob(
        { ...job, ffmpeg: { bin: 'definitely-not-ffmpeg', args: ['-version'] } },
        { execute: true, probe: fakeProbe },
      ),
    ).rejects.toThrow(/not installed or not on PATH/);
  });

  it('keeps the subtitle style in sync between layout and ASS', () => {
    const style = SubtitleStyleSchema.parse({ fontSizePx: 72, highlightColor: '#00FF88' });
    const layout = planOverlayLayout('instagram-reels', { style });
    expect(layout.subtitleStyle.fontSizePx).toBe(72);
    expect(layout.subtitleStyle.highlightColor).toBe('#00FF88');
  });
});

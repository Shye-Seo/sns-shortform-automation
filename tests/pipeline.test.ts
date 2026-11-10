import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEpisode } from '../src/pipeline';
import { LocalTtsProvider, type TtsProvider, type TtsResult } from '../src/services/tts';
import { buildCues } from '../src/services/audioEngine';
import { RenderJobSchema } from '../src/types/render';
import { createApproval, assertApproval, subjectFromScript } from '../src/services/approval';
import { encodeWavPcm16 } from '../src/lib/wav';
import { readWavInfo } from '../src/lib/media';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shortform-e2e-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('episode pipeline', () => {
  it('produces every artifact a renderer and a reviewer needs', async () => {
    const episode = await buildEpisode(
      {
        topic: '부산 신혼집 3평 주방 수납 정리법',
        rawText:
          '작은 주방은 수납장을 늘리는 게 답이 아닙니다. 먼저 일주일 동안 쓰지 않은 물건을 바구니에 담아보세요. 매일 쓰는 도구만 첫 줄에 두면 됩니다.',
        targetDurationSec: 30,
      },
      { outDir: dir, platform: 'instagram-reels' },
    );

    const project = episode.artifacts.projectDir;
    for (const file of [
      'script.json',
      'storyboard.md',
      'review.md',
      'project.json',
      'voice.wav',
      'captions.srt',
      'captions.vtt',
      'captions.ass',
      'overlay.ass',
      'ducking.csv',
      'render-plan.json',
      'render.sh',
    ]) {
      expect(existsSync(join(project, file)), file).toBe(true);
    }

    const wav = readWavInfo(await readFile(join(project, 'voice.wav')));
    expect(wav.sampleRate).toBe(48_000);
    expect(wav.durationSec).toBeGreaterThan(10);

    const srt = await readFile(join(project, 'captions.srt'), 'utf8');
    expect(srt).toMatch(/^1\n\d{2}:\d{2}:\d{2},\d{3} --> /);

    const plan = RenderJobSchema.parse(JSON.parse(await readFile(join(project, 'render-plan.json'), 'utf8')));
    expect(plan.status).toBe('planned');
    expect(plan.output.durationSec).toBeGreaterThan(0);
    expect(plan.ffmpeg.args.join(' ')).toContain('libx264');
    expect(plan.ffmpeg.args.join(' ')).toContain('/captions.ass');

    expect(episode.collisions.ok).toBe(true);
    expect(episode.subtitles?.cues.length).toBeGreaterThan(5);
    expect(episode.voiceTrack?.words.length).toBeGreaterThan(20);
  });

  it('keeps the voice exactly inside the script timeline when the provider is on time', async () => {
    const episode = await buildEpisode(
      { topic: '주방 수납 정리법', targetDurationSec: 30 },
      { outDir: dir },
    );
    expect(episode.voiceTrack?.warnings).toEqual([]);
    const lastWord = episode.voiceTrack?.words[episode.voiceTrack.words.length - 1];
    expect(lastWord?.endSec).toBeLessThanOrEqual(episode.voiceTrack?.durationSec as number);
  });

  it('shifts later scenes when the voice overruns its slot', async () => {
    class SlowTts implements TtsProvider {
      readonly name = 'slow-local';
      private readonly inner = new LocalTtsProvider();
      async synthesize(request: Parameters<TtsProvider['synthesize']>[0]): Promise<TtsResult> {
        const result = await this.inner.synthesize({
          ...request,
          targetDurationSec: request.targetDurationSec * 1.6,
        });
        return { ...result, durationSec: result.durationSec * 1.6 };
      }
    }

    const episode = await buildEpisode(
      { topic: '주방 수납 정리법', targetDurationSec: 40 },
      { outDir: dir, tts: new SlowTts() },
    );
    expect(episode.voiceTrack?.warnings.length).toBeGreaterThan(0);
    expect(episode.voiceTrack?.warnings[0]).toContain('over its slot');
    const starts = episode.voiceTrack?.scenes.map((scene) => scene.startSec) ?? [];
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]).toBeGreaterThan(starts[i - 1] as number);
    }
  });

  it('writes captions that fit the platform text box', async () => {
    const episode = await buildEpisode(
      { topic: '부산 신혼집 3평 주방 수납 정리법', targetDurationSec: 30 },
      { outDir: dir, platform: 'youtube-shorts' },
    );
    const box = episode.layout.caption;
    for (const cue of episode.subtitles?.cues ?? []) {
      expect(cue.lines.length).toBeLessThanOrEqual(2);
      expect(cue.words.length).toBeGreaterThan(0);
    }
    expect(box.w).toBeGreaterThan(600);
  });

  it('creates an approval that matches the written subtitles', async () => {
    const episode = await buildEpisode(
      { topic: '주방 수납 정리법', targetDurationSec: 30 },
      { outDir: dir },
    );
    const project = episode.artifacts.projectDir;
    const srt = await readFile(join(project, 'captions.srt'), 'utf8');
    const subject = subjectFromScript(episode.script, srt);
    const approval = createApproval(subject, { approvedBy: '서승혜' });

    expect(() => assertApproval(approval, subject)).not.toThrow();
    expect(() => assertApproval(approval, subjectFromScript(episode.script, `${srt}수정`))).toThrow(
      /content changed/,
    );
  });

  it('can draft without a voice track', async () => {
    const episode = await buildEpisode(
      { topic: '주방 수납 정리법', targetDurationSec: 30 },
      { outDir: dir, voice: false },
    );
    expect(episode.voiceTrack).toBeNull();
    expect(episode.subtitles).toBeNull();
    expect(existsSync(join(episode.artifacts.projectDir, 'script.json'))).toBe(true);
    expect(existsSync(join(episode.artifacts.projectDir, 'voice.wav'))).toBe(false);
  });

  it('never lets an episode exceed the platform ceiling', async () => {
    const episode = await buildEpisode(
      { topic: '주방 수납 정리법과 살림 도구 선택 기준에 대한 긴 설명', targetDurationSec: 60 },
      { outDir: dir },
    );
    expect(episode.script.metrics.totalDurationSec).toBeLessThanOrEqual(60);
    expect(episode.voiceTrack?.durationSec).toBeLessThanOrEqual(61);
  });
});

describe('subtitle cue integrity', () => {
  it('keeps cue times ordered and non-overlapping', async () => {
    const episode = await buildEpisode(
      { topic: '주방 수납 정리법', targetDurationSec: 40 },
      { outDir: dir },
    );
    const cues = episode.subtitles?.cues ?? [];
    for (let i = 1; i < cues.length; i += 1) {
      const previous = cues[i - 1]!;
      const current = cues[i]!;
      expect(current.startSec).toBeGreaterThanOrEqual(previous.startSec);
      expect(current.index).toBe(i + 1);
    }
  });

  it('caps reading speed for dense text', () => {
    const cues = buildCues(
      Array.from({ length: 12 }, (_, index) => ({
        index,
        text: '아주빠른말',
        startSec: index * 0.2,
        endSec: (index + 1) * 0.2,
        emphasis: false,
      })),
      { config: { maxCps: 10 }, maxWidthPx: 760 },
    );
    expect(cues.length).toBeGreaterThan(3);
    for (const cue of cues) {
      const duration = cue.endSec - cue.startSec;
      expect(cue.lines.join(' ').length / duration).toBeLessThan(40);
    }
  });
});

describe('wav utilities', () => {
  it('round-trips a header', () => {
    const samples = new Float32Array(4800).fill(0.1);
    const buffer = encodeWavPcm16(samples, 48_000, 1);
    const info = readWavInfo(buffer);
    expect(info.sampleRate).toBe(48_000);
    expect(info.channels).toBe(1);
    expect(info.durationSec).toBeCloseTo(0.1, 3);
  });
});

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ShortformError } from './lib/errors';
import { slugify } from './lib/ids';
import { silentLogger, type Logger } from './lib/logger';
import { topicHeadKeyword } from './lib/text';
import { probeMedia } from './lib/media';
import {
  AudioEngine,
  buildCues,
  buildSubtitleBundle,
  computeDuckingEnvelope,
  envelopeToCsv,
  writeSubtitleFiles,
  type VoiceTrack,
} from './services/audioEngine';
import { ScriptEngine, type ScriptModel } from './services/scriptEngine';
import {
  buildOverlayAss,
  buildRenderJob,
  checkLayoutCollisions,
  planOverlayLayout,
  renderJob,
  writeRenderScript,
} from './services/videoCompositor';
import { createTtsProvider, type TtsProvider } from './services/tts';
import { computeContentHash, subjectFromScript } from './services/approval';
import { validateMedia, type PreflightReport } from './services/publisher/preflightValidator';
import {
  RenderJobSchema,
  type CollisionReport,
  type OverlayLayout,
  type Platform,
  type RenderJob,
} from './types/render';
import { ShortformScriptSchema, type ShortformScript } from './types/script';
import type { SubtitleBundle, SubtitleStyle } from './types/audio';
import type { Approval } from './types/publish';

export interface BuildEpisodeOptions {
  outDir?: string;
  platform?: Platform;
  style?: Partial<SubtitleStyle>;
  badgeText?: string;
  musicPath?: string;
  backgroundPath?: string;
  fontsDir?: string;
  ttsName?: string;
  tts?: TtsProvider;
  model?: ScriptModel;
  logger?: Logger;
  now?: () => Date;
  /** Set false for a script-only draft (`craft --no-voice`). */
  voice?: boolean;
}

export interface EpisodeArtifacts {
  projectDir: string;
  scriptPath: string;
  storyboardPath: string;
  reviewPath: string;
  manifestPath: string;
  voicePath: string | null;
  subtitlePaths: { srt: string; vtt: string; ass: string } | null;
  overlayPath: string | null;
  duckingPath: string | null;
  renderPlanPath: string | null;
  renderScriptPath: string | null;
}

export interface Episode {
  script: ShortformScript;
  voiceTrack: VoiceTrack | null;
  subtitles: SubtitleBundle | null;
  layout: OverlayLayout;
  collisions: CollisionReport;
  render: RenderJob | null;
  artifacts: EpisodeArtifacts;
  warnings: string[];
}

function storyboardMarkdown(script: ShortformScript, warnings: string[]): string {
  const rows = script.scenes
    .map(
      (scene) =>
        `| ${scene.index + 1} | ${scene.beat} | ${scene.startSec.toFixed(1)}s | ${scene.durationSec.toFixed(1)}s | ${scene.narration} | ${scene.onScreenText ?? ''} | ${scene.visual ?? ''} |`,
    )
    .join('\n');

  const compression = script.compression.applied
    ? script.compression.passes
        .map((pass) => `- [${pass.pass}] ${pass.sceneId}: ${pass.removedText} (−${pass.savedSec}s)`)
        .join('\n')
    : '- 압축 없음 (예산 내)';

  return `# ${script.title}

- 주제: ${script.topic}
- 생성 방식: ${script.generationSource}
- 길이: ${script.metrics.totalDurationSec}s / 목표 ${script.targetDurationSec}s (발화 ${script.metrics.speechSec}s, 무음 ${script.metrics.pauseSec}s)
- 발화 속도: ${script.metrics.syllablesPerSecond} 음절/초 · ${script.metrics.wordsPerMinute} WPM
- 훅 길이: ${script.metrics.hookDurationSec}s (상한 3.5s)
- 해시태그: ${script.hashtags.join(' ')}

## 스토리보드

| # | 비트 | 시작 | 길이 | 내레이션 | 화면 텍스트 | 비주얼 |
|---|------|------|------|----------|-------------|--------|
${rows}

## 타임버짓 압축

- 원안 ${script.compression.requestedSec}s → ${script.metrics.speechSec}s (예산 ${script.compression.capacitySec}s, ${script.compression.savedSec}s 절감)
${compression}

## 캡션

\`\`\`
${script.caption}
\`\`\`

${warnings.length ? `## 경고\n\n${warnings.map((warning) => `- ${warning}`).join('\n')}\n` : ''}`;
}

function reviewMarkdown(script: ShortformScript, subtitles: SubtitleBundle | null): string {
  const cues = subtitles?.cues ?? [];
  const lines = cues
    .map((cue) => `| ${cue.index} | ${cue.startSec.toFixed(2)}–${cue.endSec.toFixed(2)}s | ${cue.lines.join(' / ')} |`)
    .join('\n');
  return `# 검수 시트 — ${script.title}

게시 전 사람이 확인하는 문서입니다. 수정 후에는 반드시 \`review --approve\`를 다시 실행해야 합니다.

## 1. 대본

${script.scenes.map((scene) => `${scene.index + 1}. **${scene.beat}** — ${scene.narration}`).join('\n')}

## 2. 캡션 / 해시태그

${script.caption}

## 3. 자막 큐 (${cues.length}개)

| # | 구간 | 자막 |
|---|------|------|
${lines || '| – | – | (자막 없음) |'}

## 4. 확인 항목

- [ ] 훅이 3초 안에 끝나는가
- [ ] 자막이 플랫폼 UI(우측 액션 레일, 하단 캡션 시트)에 가리지 않는가
- [ ] 발화와 자막이 어긋나지 않는가
- [ ] CTA가 저장/팔로우/댓글 중 하나로 명확한가
`;
}

export async function buildEpisode(
  request: InputRequest,
  options: BuildEpisodeOptions = {},
): Promise<Episode> {
  const logger = options.logger ?? silentLogger;
  const platform = options.platform ?? 'instagram-reels';
  const outDir = options.outDir ?? '.work';
  const withVoice = options.voice ?? true;

  const engine = new ScriptEngine({ model: options.model, logger, now: options.now });
  const { script, warnings: scriptWarnings } = await engine.craft(request);

  const projectDir = join(outDir, `${slugify(script.title)}-${script.id.slice(-4)}`);
  await mkdir(projectDir, { recursive: true });

  const scriptPath = join(projectDir, 'script.json');
  const storyboardPath = join(projectDir, 'storyboard.md');
  const reviewPath = join(projectDir, 'review.md');
  const manifestPath = join(projectDir, 'project.json');
  await writeFile(scriptPath, JSON.stringify(script, null, 2), 'utf8');
  await writeFile(storyboardPath, storyboardMarkdown(script, scriptWarnings), 'utf8');

  const badgeText =
    options.badgeText ?? topicHeadKeyword(script.topic, script.language) ?? script.keywords[0] ?? '';
  const layout = planOverlayLayout(platform, {
    style: options.style,
    badgeText,
    captionLines: 2,
  });
  const collisions = checkLayoutCollisions(layout, platform);
  const warnings = [...scriptWarnings];
  collisions.violations.forEach((violation) =>
    warnings.push(`layout: ${violation.layer} overlaps ${violation.zone} (${violation.hint})`),
  );

  const artifacts: EpisodeArtifacts = {
    projectDir,
    scriptPath,
    storyboardPath,
    reviewPath,
    manifestPath,
    voicePath: null,
    subtitlePaths: null,
    overlayPath: null,
    duckingPath: null,
    renderPlanPath: null,
    renderScriptPath: null,
  };

  let voiceTrack: VoiceTrack | null = null;
  let subtitles: SubtitleBundle | null = null;
  let render: RenderJob | null = null;

  if (withVoice) {
    const tts = options.tts ?? createTtsProvider(options.ttsName ?? process.env.TTS_PROVIDER ?? 'local');
    const audioEngine = new AudioEngine({ logger });
    voiceTrack = await audioEngine.buildVoiceTrack(script, { outputDir: projectDir, tts });
    warnings.push(...voiceTrack.warnings);

    const captionBox = layout.caption;
    subtitles = buildSubtitleBundle(
      buildCues(voiceTrack.words, {
        style: options.style,
        maxWidthPx: captionBox.w,
      }),
      options.style,
      {
        centerX: captionBox.x + captionBox.w / 2,
        baselineY: captionBox.y + captionBox.h - 8,
        maxWidthPx: captionBox.w,
      },
    );
    const subtitlePaths = await writeSubtitleFiles(projectDir, subtitles);
    artifacts.subtitlePaths = subtitlePaths;

    const overlayPath = join(projectDir, 'overlay.ass');
    await writeFile(
      overlayPath,
      buildOverlayAss({
        durationSec: voiceTrack.durationSec,
        style: subtitles.style,
        layout,
        badgeText,
        watermarkText: '@shye__s',
      }),
      'utf8',
    );
    artifacts.overlayPath = overlayPath;

    const segments = voiceTrack.words.map((word) => ({ startSec: word.startSec, endSec: word.endSec }));
    const envelope = computeDuckingEnvelope({ segments, durationSec: voiceTrack.durationSec });
    const duckingPath = join(projectDir, 'ducking.csv');
    await writeFile(duckingPath, envelopeToCsv(envelope), 'utf8');
    artifacts.duckingPath = duckingPath;

    render = buildRenderJob({
      scriptId: script.id,
      platform,
      voicePath: voiceTrack.path,
      musicPath: options.musicPath,
      backgroundPath: options.backgroundPath,
      subtitlePath: subtitlePaths.ass,
      overlayPath,
      outputPath: join(projectDir, 'render.mp4'),
      durationSec: voiceTrack.durationSec,
      layout,
      style: options.style,
      voiceSegments: segments,
      fontsDir: options.fontsDir ?? process.env.SHORTFORM_FONTS_DIR,
    });
    artifacts.renderPlanPath = join(projectDir, 'render-plan.json');
    await writeFile(artifacts.renderPlanPath, JSON.stringify(render, null, 2), 'utf8');
    artifacts.renderScriptPath = await writeRenderScript(render, projectDir);

    await writeFile(reviewPath, reviewMarkdown(script, subtitles), 'utf8');

    const manifest = {
      schemaVersion: '1.0',
      scriptId: script.id,
      title: script.title,
      platform,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      durationSec: voiceTrack.durationSec,
      contentHash: computeContentHash(subjectFromScript(script, subtitles.srt)),
      files: {
        script: 'script.json',
        storyboard: 'storyboard.md',
        review: 'review.md',
        voice: 'voice.wav',
        captions: { srt: 'captions.srt', vtt: 'captions.vtt', ass: 'captions.ass' },
        overlay: 'overlay.ass',
        ducking: 'ducking.csv',
        renderPlan: 'render-plan.json',
        render: 'render.mp4',
      },
      voice: {
        provider: voiceTrack.provider,
        alignmentSource: voiceTrack.alignmentSource,
        words: voiceTrack.words.length,
        scenes: voiceTrack.scenes.length,
      },
      render: {
        platform,
        layout,
        collisions,
        ffmpegBin: render.ffmpeg.bin,
        expectedBytes: render.output.expectedBytes,
      },
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  } else {
    await writeFile(reviewPath, reviewMarkdown(script, null), 'utf8');
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: '1.0',
          scriptId: script.id,
          title: script.title,
          platform,
          createdAt: (options.now?.() ?? new Date()).toISOString(),
          durationSec: script.metrics.totalDurationSec,
          contentHash: computeContentHash(subjectFromScript(script, '')),
          files: { script: 'script.json', storyboard: 'storyboard.md', review: 'review.md' },
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  logger.info(`episode ready: ${projectDir}`);

  return { script, voiceTrack, subtitles, layout, collisions, render, artifacts, warnings };
}

type InputRequest = Parameters<ScriptEngine['craft']>[0];

export interface LoadedProject {
  dir: string;
  script: ShortformScript;
  manifest: {
    schemaVersion: string;
    scriptId: string;
    title: string;
    platform: Platform;
    createdAt: string;
    durationSec: number;
    contentHash: string;
    files: Record<string, unknown>;
  };
  approval: Approval | null;
  subtitlesSrt: string | null;
}

export async function loadProject(dir: string): Promise<LoadedProject> {
  const readJson = async <T>(path: string): Promise<T> =>
    JSON.parse(await readFile(path, 'utf8')) as T;

  const manifest = await readJson<LoadedProject['manifest']>(join(dir, 'project.json')).catch(() => {
    throw new ShortformError(`no project.json in ${dir}`, {
      code: 'VALIDATION',
      details: { hint: 'shortform craft 로 프로젝트를 먼저 생성하세요' },
    });
  });

  const rawScript = await readJson<unknown>(join(dir, 'script.json'));
  const script = ShortformScriptSchema.parse(rawScript);
  const approval = await readJson<Approval>(join(dir, 'approval.json')).catch(() => null);
  const subtitlesSrt = await readFile(join(dir, 'captions.srt'), 'utf8').catch(() => null);

  return { dir, script, manifest, approval, subtitlesSrt };
}

export interface RenderProjectResult {
  job: RenderJob;
  report: PreflightReport | null;
}

export async function renderProject(
  dir: string,
  options: { execute?: boolean; probe?: typeof probeMedia } = {},
): Promise<RenderProjectResult> {
  const loaded = await loadProject(dir);
  const raw = JSON.parse(await readFile(join(dir, 'render-plan.json'), 'utf8')) as unknown;
  const job = RenderJobSchema.parse(raw);
  const executed = await renderJob(job, { execute: options.execute, probe: options.probe });
  await writeFile(join(dir, 'render-plan.json'), JSON.stringify(executed, null, 2), 'utf8');

  let report: PreflightReport | null = null;
  if (executed.status === 'rendered' && executed.probe) {
    report = validateMedia(executed.probe, { platform: loaded.manifest.platform });
    await writeFile(join(dir, 'preflight.json'), JSON.stringify(report, null, 2), 'utf8');
  }
  return { job: executed, report };
}

export function summarizeEpisode(episode: Episode): string {
  const m = episode.script.metrics;
  return [
    `${episode.script.title}`,
    `${m.totalDurationSec}s (발화 ${m.speechSec}s / 무음 ${m.pauseSec}s) · ${m.syllablesPerSecond}음절/초`,
    `장면 ${episode.script.scenes.length}개 · 압축 ${episode.script.compression.applied ? `${episode.script.compression.savedSec}s` : '없음'}`,
    episode.voiceTrack
      ? `보이스 ${episode.voiceTrack.provider} (${episode.voiceTrack.alignmentSource}) · 단어 ${episode.voiceTrack.words.length}개`
      : '보이스 미생성',
    episode.subtitles
      ? `자막 ${episode.subtitles.stats.cueCount}큐 · 최대 ${episode.subtitles.stats.maxCps}자/초`
      : '자막 미생성',
    `레이아웃 충돌 ${episode.collisions.ok ? '없음' : `${episode.collisions.violations.length}건`}`,
    `결과물 ${episode.artifacts.projectDir}`,
  ].join('\n');
}

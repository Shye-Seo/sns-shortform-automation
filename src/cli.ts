#!/usr/bin/env node
import { Command } from 'commander';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ShortformError } from './lib/errors';
import { createLogger, type LogLevel } from './lib/logger';
import { commandExists, probeMedia } from './lib/media';
import { buildEpisode, loadProject, renderProject } from './pipeline';
import { createScriptEngine, createOpenAiScriptModel } from './services/scriptEngine';
import { createTtsProvider } from './services/tts';
import { createApproval, computeContentHash, subjectFromScript } from './services/approval';
import {
  assertPublishable,
  validateMedia,
  type PreflightReport,
} from './services/publisher/preflightValidator';
import {
  InstagramPublisher,
  YoutubePublisher,
  publishPayload,
} from './services/publisher';
import { describeProbe } from './services/videoCompositor';
import type { Platform } from './types/render';
import type { PublishPayload } from './types/publish';

const program = new Command();

program
  .name('shortform')
  .description('60초 릴스·쇼츠 원소스 멀티유즈 엔진 (Human-in-the-Loop)')
  .version('1.0.0')
  .option('-v, --verbose', '디버그 로그 출력')
  .hook('preAction', (thisCommand) => {
    const verbose = thisCommand.opts().verbose as boolean | undefined;
    process.env.SHORTFORM_LOG_LEVEL = verbose ? 'debug' : process.env.SHORTFORM_LOG_LEVEL ?? 'info';
  });

function logger(scope: string) {
  const level = (process.env.SHORTFORM_LOG_LEVEL ?? 'info') as LogLevel;
  return createLogger(level, `shortform:${scope}`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(error: unknown): never {
  const err = error instanceof ShortformError ? error : new ShortformError(String(error), { code: 'EXTERNAL' });
  process.stderr.write(`\n✖ ${err.message}\n`);
  if (Object.keys(err.details).length > 0) {
    process.stderr.write(`  ${JSON.stringify(err.details, null, 2)}\n`);
  }
  if (err instanceof Error && err.stack && process.env.SHORTFORM_LOG_LEVEL === 'debug') {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
}

/* ── craft ─────────────────────────────────────────────────────────────── */

program
  .command('craft')
  .description('주제/원문 → 60초 대본 + 보이스 + 자막 + 렌더 플랜 생성')
  .option('--topic <text>', '영상 주제')
  .option('--raw <file>', '참고 원문 파일 (txt/md)')
  .option('--out <dir>', '결과물 루트', '.work')
  .option('--lang <lang>', 'ko | en', 'ko')
  .option('--duration <sec>', '목표 길이(초, 최대 60)', '60')
  .option('--hook <type>', 'question | numbers | shock | howto | contrarian', 'question')
  .option('--cta <goal>', 'follow | save | comment | link', 'save')
  .option('--speed <factor>', '발화 속도 배율', '1')
  .option('--platform <platform>', 'instagram-reels | youtube-shorts', 'instagram-reels')
  .option('--tts <provider>', 'local | elevenlabs | openai', process.env.TTS_PROVIDER ?? 'local')
  .option('--music <file>', '배경음악 파일')
  .option('--background <file>', '배경 영상/이미지')
  .option('--badge <text>', '상단 카테고리 뱃지 문구')
  .option('--fonts <dir>', '자막 폰트 디렉토리 (한글 폰트는 필수)', process.env.SHORTFORM_FONTS_DIR)
  .option('--model', 'OpenAI로 대본 초안 생성 (OPENAI_API_KEY 필요)')
  .option('--no-voice', '보이스/자막/렌더 플랜 없이 대본만')
  .option('--json', 'JSON으로 출력')
  .action(async (options) => {
    try {
      if (!options.topic) {
        throw new ShortformError('--topic 또는 --raw 중 하나는 필요합니다', { code: 'VALIDATION' });
      }
      const rawText = options.raw ? await readFile(options.raw, 'utf8') : undefined;
      const request = {
        topic: options.topic,
        rawText,
        language: options.lang,
        targetDurationSec: Number(options.duration),
        speed: Number(options.speed),
        hookType: options.hook,
        ctaGoal: options.cta,
      };

      const tts = options.voice ? createTtsProvider(options.tts) : undefined;
      const log = logger('craft');
      const episode = await buildEpisode(request, {
        outDir: options.out,
        platform: options.platform as Platform,
        tts,
        ttsName: options.tts,
        model: options.model
          ? createOpenAiScriptModel()
          : undefined,
        musicPath: options.music ? resolve(options.music) : undefined,
        backgroundPath: options.background ? resolve(options.background) : undefined,
        badgeText: options.badge,
        fontsDir: options.fonts,
        logger: log,
      });

      if (options.json) {
        printJson({
          projectDir: episode.artifacts.projectDir,
          script: episode.script,
          layout: episode.layout,
          collisions: episode.collisions,
          subtitles: episode.subtitles?.stats ?? null,
          voice: episode.voiceTrack
            ? {
                provider: episode.voiceTrack.provider,
                durationSec: episode.voiceTrack.durationSec,
                words: episode.voiceTrack.words.length,
                alignmentSource: episode.voiceTrack.alignmentSource,
              }
            : null,
          render: episode.render
            ? { output: episode.render.output, warnings: episode.render.warnings }
            : null,
          warnings: episode.warnings,
        });
        return;
      }

      const s = episode.script;
      process.stdout.write(
        [
          '',
          `🎬 ${s.title}`,
          `   ${s.metrics.totalDurationSec}s / 목표 ${s.targetDurationSec}s · 장면 ${s.scenes.length}개 · ${s.generationSource}`,
          `   발화 ${s.metrics.speechSec}s · ${s.metrics.syllablesPerSecond}음절/초 · 훅 ${s.metrics.hookDurationSec}s`,
          '',
          ...s.scenes.map(
            (scene) =>
              `   ${String(scene.index + 1).padStart(2)}. [${scene.beat.padEnd(8)}] ${scene.startSec
                .toFixed(1)
                .padStart(5)}s  ${scene.narration}`,
          ),
          '',
          `   자막 ${episode.subtitles?.stats.cueCount ?? 0}큐 · 최대 ${episode.subtitles?.stats.maxCps ?? 0}자/초`,
          `   보이스 ${episode.voiceTrack?.provider ?? '-'} (${episode.voiceTrack?.alignmentSource ?? '-'})`,
          `   레이아웃 충돌 ${episode.collisions.ok ? '없음' : `${episode.collisions.violations.length}건`}`,
          `   결과물: ${episode.artifacts.projectDir}`,
          '',
          '   다음 단계:',
          `     npm run cli -- review --project ${episode.artifacts.projectDir}`,
          `     npm run cli -- render --project ${episode.artifacts.projectDir} --execute`,
          episode.warnings.length
            ? `\n   ⚠ ${episode.warnings.join('\n   ⚠ ')}`
            : '',
          '',
        ].join('\n'),
      );
    } catch (error) {
      fail(error);
    }
  });

/* ── render ────────────────────────────────────────────────────────────── */

program
  .command('render')
  .description('렌더 플랜 실행 (기본은 계획만, --execute 로 실제 인코딩)')
  .option('--project <dir>', '프로젝트 디렉토리')
  .option('--execute', 'ffmpeg 로 실제 인코딩')
  .option('--json', 'JSON으로 출력')
  .action(async (options) => {
    try {
      if (!options.project) {
        throw new ShortformError('--project 가 필요합니다', { code: 'VALIDATION' });
      }
      const { job, report } = await renderProject(options.project, { execute: Boolean(options.execute) });

      if (options.json) {
        printJson({ status: job.status, output: job.output, probe: job.probe, preflight: report, warnings: job.warnings });
        if (report && !report.ok) process.exit(1);
        return;
      }

      if (job.status === 'planned') {
        process.stdout.write(
          [
            '',
            '📋 렌더 플랜 (아직 인코딩하지 않았습니다)',
            `   출력: ${job.output.path}  (${(job.output.expectedBytes / 1024 / 1024).toFixed(1)}MB 예상, ${job.output.durationSec}s)`,
            `   코덱: ${job.encoding.videoCodec}/${job.encoding.profile}/${job.encoding.pixFmt} @ ${job.canvas.width}x${job.canvas.height} ${job.canvas.fps}fps`,
            '',
            '   실행하려면:',
            `     npm run cli -- render --project ${options.project} --execute`,
            '',
            `   ffmpeg ${job.ffmpeg.args.join(' ')}`,
            '',
          ].join('\n'),
        );
        return;
      }

      if (job.status === 'failed') {
        process.stderr.write(`\n✖ 렌더 실패\n${job.warnings.slice(-3).join('\n')}\n`);
        process.exit(1);
      }

      process.stdout.write(
        [
          '',
          '✅ 렌더 완료',
          `   ${job.output.path}`,
          job.probe ? `   ${describeProbe(job.probe)}` : '',
          report ? `   ${report.summary}` : '',
          report && report.warnings.length ? `   ⚠ ${report.warnings.join('\n   ⚠ ')}` : '',
          '',
        ].join('\n'),
      );
      if (report && !report.ok) {
        process.stderr.write(`\n✖ 프리플라이트 실패\n${report.errors.join('\n')}\n`);
        process.exit(1);
      }
    } catch (error) {
      fail(error);
    }
  });

/* ── validate ──────────────────────────────────────────────────────────── */

program
  .command('validate')
  .description('렌더 결과물이 릴스/쇼츠 규격에 맞는지 검사')
  .option('--file <path>', '검사할 mp4')
  .option('--platform <platform>', 'instagram-reels | youtube-shorts', 'instagram-reels')
  .option('--json', 'JSON으로 출력')
  .action(async (options) => {
    try {
      if (!options.file) throw new ShortformError('--file 이 필요합니다', { code: 'VALIDATION' });
      const probe = await probeMedia(options.file);
      const report = validateMedia(probe, { platform: options.platform as Platform });

      if (options.json) {
        printJson(report);
      } else {
        process.stdout.write(`\n${describeProbe(probe)}\n\n`);
        for (const item of report.checks) {
          const mark = item.status === 'pass' ? '✓' : item.status === 'warn' ? '!' : '✖';
          process.stdout.write(
            `  ${mark} ${item.label.padEnd(16)} ${item.actual.padEnd(18)} (기대 ${item.expected})\n`,
          );
        }
        process.stdout.write(`\n  ${report.summary}\n\n`);
      }
      if (!report.ok) process.exit(1);
    } catch (error) {
      fail(error);
    }
  });

/* ── review ────────────────────────────────────────────────────────────── */

program
  .command('review')
  .description('검수 시트 출력 및 승인 기록 (Human-in-the-Loop)')
  .requiredOption('--project <dir>', '프로젝트 디렉토리')
  .option('--approve', '현재 내용을 승인으로 기록')
  .option('--by <name>', '승인자', '서승혜')
  .option('--notes <text>', '메모')
  .option('--json', 'JSON으로 출력')
  .action(async (options) => {
    try {
      const loaded = await loadProject(options.project);
      const srt = loaded.subtitlesSrt ?? '';
      const subject = subjectFromScript(loaded.script, srt);
      const hash = computeContentHash(subject);

      if (options.approve) {
        const approval = createApproval(subject, { approvedBy: options.by, notes: options.notes });
        await writeFile(join(options.project, 'approval.json'), JSON.stringify(approval, null, 2), 'utf8');
        if (options.json) {
          printJson(approval);
          return;
        }
        process.stdout.write(`\n✅ 승인 기록됨 · ${approval.approvedBy} · ${hash.slice(0, 12)}…\n\n`);
        return;
      }

      const reviewMarkdown = await readFile(join(options.project, 'review.md'), 'utf8').catch(() => '');
      if (options.json) {
        printJson({
          scriptId: loaded.script.id,
          contentHash: hash,
          approval: loaded.approval,
          captions: loaded.subtitlesSrt,
        });
        return;
      }
      process.stdout.write(`\n${reviewMarkdown}\n`);
      process.stdout.write(
        `\n승인 지문: ${hash.slice(0, 16)}…\n승인하려면: npm run cli -- review --project ${options.project} --approve\n\n`,
      );
    } catch (error) {
      fail(error);
    }
  });

/* ── publish ───────────────────────────────────────────────────────────── */

program
  .command('publish')
  .description('승인된 프로젝트를 릴스/쇼츠로 게시 (기본은 드라이런)')
  .requiredOption('--project <dir>', '프로젝트 디렉토리')
  .option('--platform <platform>', 'instagram-reels | youtube-shorts')
  .option('--video-url <url>', 'Instagram용 공개 HTTPS 영상 URL')
  .option('--live', '실제 게시 (승인 + 프리플라이트 필요)')
  .option('--json', 'JSON으로 출력')
  .action(async (options) => {
    try {
      const loaded = await loadProject(options.project);
      const platform = (options.platform ?? loaded.manifest.platform) as Platform;
      const srt = loaded.subtitlesSrt ?? '';
      const subject = subjectFromScript(loaded.script, srt);

      // Approval gate — published content must match what a human reviewed.
      const { assertApproval } = await import('./services/approval');
      assertApproval(loaded.approval, subject);

      const videoPath = join(options.project, 'render.mp4');
      const exists = await stat(videoPath).then(() => true).catch(() => false);
      let report: PreflightReport | null = null;
      const savedReport = await readFile(join(options.project, 'preflight.json'), 'utf8')
        .then((text) => JSON.parse(text) as PreflightReport)
        .catch(() => null);
      if (savedReport) {
        report = savedReport;
      } else if (exists) {
        report = validateMedia(await probeMedia(videoPath), { platform });
      }

      const payload: PublishPayload = {
        projectId: loaded.script.id,
        platform,
        videoPath,
        caption: loaded.script.caption,
        hashtags: loaded.script.hashtags,
        title: loaded.script.title,
        visibility: 'public',
        madeForKids: false,
        approval: loaded.approval ?? (() => {
          throw new ShortformError('approval missing', { code: 'APPROVAL' });
        })(),
      };

      if (!report) {
        throw new ShortformError('렌더 결과물이 없어 프리플라이트를 수행할 수 없습니다', {
          code: 'VALIDATION',
          details: { hint: `npm run cli -- render --project ${options.project} --execute` },
        });
      }
      if (options.live) assertPublishable(report);

      const instagram =
        platform === 'instagram-reels'
          ? new InstagramPublisher({
              igUserId: process.env.IG_USER_ID ?? '',
              accessToken: process.env.IG_ACCESS_TOKEN ?? '',
            })
          : undefined;
      const youtube =
        platform === 'youtube-shorts'
          ? new YoutubePublisher({
              refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
              clientId: process.env.YOUTUBE_CLIENT_ID,
              clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
              accessToken: process.env.YOUTUBE_ACCESS_TOKEN,
            })
          : undefined;

      const { result } = await publishPayload(payload, {
        instagram,
        youtube,
        preflight: report,
        videoUrl: options.videoUrl,
        videoPath: exists ? videoPath : undefined,
        dryRun: !options.live,
      });

      if (options.json) {
        printJson(result);
        return;
      }
      process.stdout.write(
        [
          '',
          result.status === 'dry-run' ? '🧪 드라이런 (실제 게시 안 함)' : '🚀 게시 결과',
          `   플랫폼: ${result.platform}`,
          `   상태: ${result.status}`,
          result.url ? `   URL: ${result.url}` : '',
          ...result.messages.map((message) => `   · ${message}`),
          ...result.warnings.map((warning) => `   ⚠ ${warning}`),
          options.live ? '' : '   실제 게시하려면 --live (승인 후)',
          '',
        ].join('\n'),
      );
    } catch (error) {
      fail(error);
    }
  });

/* ── doctor ────────────────────────────────────────────────────────────── */

program
  .command('doctor')
  .description('실행 환경과 자격증명 점검')
  .option('--json', 'JSON으로 출력')
  .action(async () => {
    const ffmpeg = await commandExists(process.env.FFMPEG_PATH ?? 'ffmpeg');
    const ffprobe = await commandExists(process.env.FFPROBE_PATH ?? 'ffprobe');
    const envKeys = [
      'OPENAI_API_KEY',
      'ELEVENLABS_API_KEY',
      'IG_USER_ID',
      'IG_ACCESS_TOKEN',
      'YOUTUBE_REFRESH_TOKEN',
    ];
    const env = Object.fromEntries(envKeys.map((key) => [key, Boolean(process.env[key])]));
    const report = {
      node: process.version,
      ffmpeg,
      ffprobe,
      ttsProvider: process.env.TTS_PROVIDER ?? 'local',
      env,
      ready: {
        degradeOnly: !ffmpeg,
        voice: process.env.TTS_PROVIDER === 'elevenlabs' ? Boolean(process.env.ELEVENLABS_API_KEY) : true,
      },
    };
    if (process.argv.includes('--json')) {
      printJson(report);
      return;
    }
    process.stdout.write(
      [
        '',
        `node      ${report.node}`,
        `ffmpeg    ${ffmpeg ? '✓' : '✖ (인코딩 불가, 렌더 플랜까지만 가능)'}`,
        `ffprobe   ${ffprobe ? '✓' : '✖ (미디어 검증 불가)'}`,
        `TTS       ${report.ttsProvider}`,
        '',
        ...Object.entries(env).map(([key, present]) => `  ${present ? '✓' : '·'} ${key}`),
        '',
      ].join('\n'),
    );
  });

/* ── script (debug) ────────────────────────────────────────────────────── */

program
  .command('plan')
  .description('대본만 빠르게 생성 (네트워크/ffmpeg 불필요)')
  .requiredOption('--topic <text>', '주제')
  .option('--duration <sec>', '목표 길이', '60')
  .option('--lang <lang>', 'ko | en', 'ko')
  .option('--json', 'JSON으로 출력')
  .action(async (options) => {
    try {
      const engine = createScriptEngine();
      const { script, warnings } = await engine.craft({
        topic: options.topic,
        targetDurationSec: Number(options.duration),
        language: options.lang,
      });
      if (options.json) {
        printJson({ script, warnings });
        return;
      }
      process.stdout.write(`\n${script.title} (${script.metrics.totalDurationSec}s)\n\n`);
      for (const scene of script.scenes) {
        process.stdout.write(`${scene.startSec.toFixed(1).padStart(5)}s [${scene.beat}] ${scene.narration}\n`);
      }
      process.stdout.write(`\n${script.caption}\n\n`);
    } catch (error) {
      fail(error);
    }
  });

program.parseAsync(process.argv).catch((error) => fail(error));

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
import { JobQueue } from './lib/queue/jobQueue';
import { FileQueueStore } from './lib/queue/fileStore';
import { WorkerPool } from './lib/queue/workerPool';
import { createProjectRenderHandler, createSimulatedRenderHandler } from './lib/queue/renderJob';
import { generateHookVariants } from './lib/telemetry/hooks';
import { TelemetryIngestor } from './lib/telemetry/metrics';
import { evaluateExperiment } from './lib/telemetry/significance';
import { planPublishSlots, gapStatistics } from './lib/rateLimit/jitter';
import { TenantRegistry } from './lib/rateLimit/tenantRegistry';
import type { HookAngle } from './types/telemetry';
import { StudioConsole } from './services/studio/console';
import { createDemoStudio } from './services/studio/demo';
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

/* ── queue ─────────────────────────────────────────────────────────────── */

const queueCommand = program
  .command('queue')
  .description('분산 비동기 렌더 큐 (파일 상태 기반, 워커 풀 실행)');

queueCommand
  .command('run')
  .description('작업을 큐에 넣고 워커 풀로 처리 (기본은 렌더 시뮬레이션)')
  .option('--jobs <n>', '데모 작업 수', '6')
  .option('--concurrency <n>', '동시 워커 수', '3')
  .option('--chunks <n>', '청크 수', '4')
  .option('--duration <sec>', '영상 길이(초)', '45')
  .option('--tenant <id>', '테넌트 ID', 'studio-demo')
  .option('--fail-every <n>', 'N번째 작업을 첫 시도에서 실패시켜 재시도 시연', '0')
  .option('--state <file>', '큐 상태 파일', '.work/queue/state.json')
  .option('--project <dir>', '실제 프로젝트를 큐에 넣고 렌더')
  .option('--execute', 'ffmpeg로 실제 인코딩 (--project 와 함께)')
  .option('--json', 'JSON으로 출력')
  .action(async (options) => {
    try {
      const queue = new JobQueue({
        store: new FileQueueStore(String(options.state)),
        retry: { baseDelayMs: 300, maxDelayMs: 2_000, jitterRatio: 0.5, maxAttempts: 3 },
      });
      const chunks = Number(options.chunks);
      const durationSec = Number(options.duration);
      const jobCount = options.project ? 1 : Math.max(1, Number(options.jobs));
      for (let index = 0; index < jobCount; index += 1) {
        const projectId = options.project
          ? resolve(String(options.project))
          : `demo-episode-${String(index + 1).padStart(2, '0')}`;
        await queue.enqueue({
          tenantId: String(options.tenant),
          name: `render ${projectId}`,
          priority: index === 0 ? 9 : 5,
          payload: {
            projectId,
            platform: index % 4 === 0 ? 'youtube-shorts' : 'instagram-reels',
            durationSec,
            chunkCount: chunks,
          },
          dedupeKey: options.project ? `render:${projectId}` : undefined,
        });
      }

      const failEvery = Math.max(0, Number(options.failEvery));
      const computed = options.project
        ? createProjectRenderHandler({
            render: async (projectDir, config) => {
              const { job } = await renderProject(projectDir, { execute: config.execute });
              return { status: job.status, output: job.output, warnings: job.warnings };
            },
          })
        : createSimulatedRenderHandler({
            chunkMs: 8,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            failOn: (job) => {
              if (failEvery === 0) return null;
              const index = Number(job.name.match(/(\d+)$/)?.[1] ?? 0);
              return index > 0 && index % failEvery === 0 ? 'simulated encoder failure' : null;
            },
          });
      const pool = new WorkerPool({
        queue,
        size: Math.max(1, Number(options.concurrency)),
        handler: computed,
      });
      const summary = await pool.drain({ waitForDelayed: true, maxDrainMs: 600_000 });
      const stats = await queue.stats();
      const dlq = await queue.list('dlq');

      if (options.json) {
        printJson({ summary, stats, dlq: dlq.map((job) => ({ id: job.id, name: job.name, error: job.lastError })) });
        return;
      }
      process.stdout.write(
        [
          '',
          `⚙ 큐 처리 시도 ${summary.processed}건 (성공 ${summary.succeeded} / 실패 ${summary.failed}) · ${summary.durationMs}ms`,
          `   최대 동시 워커 ${summary.maxConcurrency} · 평균 처리 ${stats.meanLatencyMs}ms · p95 ${stats.p95LatencyMs}ms`,
          `   waiting ${stats.counts.waiting} · delayed ${stats.counts.delayed} · dlq ${stats.counts.dlq}`,
          '',
          '   워커별 부하:',
          ...pool.loads.map(
            (load) =>
              `     ${load.workerId.padEnd(10)} ${String(Math.round(load.utilization * 100)).padStart(3)}%  완료 ${load.jobsProcessed} · 실패 ${load.jobsFailed}`,
          ),
          dlq.length ? `\n   DLQ: ${dlq.map((job) => job.id).join(', ')}` : '',
          '',
        ].join('\n'),
      );
    } catch (error) {
      fail(error);
    }
  });

queueCommand
  .command('status')
  .description('저장된 큐 상태와 통계를 출력')
  .option('--state <file>', '큐 상태 파일', '.work/queue/state.json')
  .option('--json', 'JSON으로 출력')
  .action(async (options) => {
    try {
      const queue = new JobQueue({ store: new FileQueueStore(String(options.state)) });
      const stats = await queue.stats();
      const jobs = await queue.list();
      if (options.json) {
        printJson({ stats, jobs });
        return;
      }
      process.stdout.write(
        [
          '',
          `QUEUE ${String(options.state)}`,
          `  total ${stats.total} · 성공률 ${(stats.successRate * 100).toFixed(1)}% · 평균 ${stats.meanLatencyMs}ms · p95 ${stats.p95LatencyMs}ms · 재시도 ${stats.retries}`,
          `  waiting ${stats.counts.waiting} · delayed ${stats.counts.delayed} · active ${stats.counts.active} · completed ${stats.counts.completed} · failed ${stats.counts.failed} · dlq ${stats.counts.dlq}`,
          '',
          ...jobs
            .slice(0, 25)
            .map(
              (job) =>
                `  ${job.id.padEnd(10)} ${job.state.padEnd(9)} ${String(job.progress).padStart(5)}%  p${job.priority}  ${job.tenantId.padEnd(14)} ${job.name}`,
            ),
          '',
        ].join('\n'),
      );
    } catch (error) {
      fail(error);
    }
  });

queueCommand
  .command('dlq')
  .description('Dead Letter Queue 목록')
  .option('--state <file>', '큐 상태 파일', '.work/queue/state.json')
  .option('--json', 'JSON으로 출력')
  .action(async (options) => {
    try {
      const queue = new JobQueue({ store: new FileQueueStore(String(options.state)) });
      const jobs = await queue.list('dlq');
      if (options.json) {
        printJson(jobs);
        return;
      }
      if (jobs.length === 0) {
        process.stdout.write('\nDLQ 비어 있음\n\n');
        return;
      }
      process.stdout.write(
        [
          '',
          `DLQ ${jobs.length}건`,
          ...jobs.map(
            (job) => `  ${job.id}  ${job.tenantId}  attempts ${job.attempts}  ${job.lastError ?? ''}`,
          ),
          '',
          '  재처리: npm run cli -- queue replay <jobId>',
          '',
        ].join('\n'),
      );
    } catch (error) {
      fail(error);
    }
  });

queueCommand
  .command('replay <jobId>')
  .description('DLQ/failed 작업을 대기열로 되돌림')
  .option('--state <file>', '큐 상태 파일', '.work/queue/state.json')
  .option('--json', 'JSON으로 출력')
  .action(async (jobId, options) => {
    try {
      const queue = new JobQueue({ store: new FileQueueStore(String(options.state)) });
      const job = await queue.replay(jobId);
      if (options.json) {
        printJson(job);
        return;
      }
      process.stdout.write(`\n↻ ${job.id} 재투입 대기 (attempts 0)\n\n`);
    } catch (error) {
      fail(error);
    }
  });

/* ── hooks / telemetry ─────────────────────────────────────────────────── */

program
  .command('hooks')
  .description('훅 A/B/C 변형 생성과 실험 결과 판정')
  .option('--topic <text>', '영상 주제')
  .option('--count <n>', '변형 수 (2~4)', '3')
  .option('--weights <pairs>', '각도 가중치 (예: question=0.4,contrarian=0.3)')
  .option('--report <file>', '웹훅 샘플 JSON으로 실험 판정')
  .option('--experiment <id>', '실험 ID', 'exp-1')
  .option('--metric <metric>', 'viewRate3s | retention | commentRate', 'retention')
  .option('--window <window>', '24h | 7d', '24h')
  .option('--min-sample <n>', '변형당 최소 표본', '200')
  .option('--json', 'JSON으로 출력')
  .action(async (options) => {
    try {
      if (options.report) {
        const raw = await readFile(String(options.report), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        const samples = Array.isArray(parsed)
          ? parsed
          : (parsed as { samples?: unknown[] }).samples ?? [parsed];
        const ingestor = new TelemetryIngestor();
        const result = ingestor.ingestMany(samples);
        const aggregates = ingestor.aggregate(String(options.experiment), options.window as '24h' | '7d');
        const evaluation = evaluateExperiment(String(options.experiment), aggregates, {
          metric: options.metric,
          window: options.window,
          minSample: Number(options.minSample),
        });
        if (options.json) {
          printJson({ ingest: result, evaluation });
          return;
        }
        process.stdout.write(
          [
            '',
            `AB REPORT ${evaluation.experimentId} · ${evaluation.metric}/${evaluation.window}`,
            `  판정: ${evaluation.status}${evaluation.winner ? ` · 승자 ${evaluation.winner}` : ''} · 신뢰도 ${(evaluation.confidence * 100).toFixed(1)}%`,
            ...evaluation.variants.map(
              (variant) =>
                `  ${variant.variantId}  ${(variant.value * 100).toFixed(1).padStart(5)}%  n=${String(variant.trials).padStart(6)}  lift ${(variant.lift * 100).toFixed(1).padStart(6)}%  p ${variant.pValue.toFixed(3)}`,
            ),
            `  변형당 필요 표본: ${evaluation.requiredSample}`,
            evaluation.notes.length ? `  ⚠ ${evaluation.notes.join(' / ')}` : '',
            '',
          ].join('\n'),
        );
        return;
      }

      if (!options.topic) {
        throw new ShortformError('--topic 또는 --report 가 필요합니다', { code: 'VALIDATION' });
      }
      const weights = options.weights
        ? Object.fromEntries(
            String(options.weights)
              .split(',')
              .map((pair) => pair.split('='))
              .filter(([angle, weight]) => angle && weight)
              .map(([angle, weight]) => [angle.trim(), Number(weight)]),
          )
        : undefined;
      const variants = generateHookVariants(String(options.topic), {
        count: Number(options.count),
        weights: weights as Partial<Record<HookAngle, number>> | undefined,
      });
      if (options.json) {
        printJson(variants);
        return;
      }
      process.stdout.write(
        [
          '',
          `HOOKS · ${options.topic}`,
          ...variants.map(
            (variant) =>
              `  ${variant.id} [${variant.angle.padEnd(10)}] ${variant.hookSeconds.toFixed(2)}s  ${variant.text}`,
          ),
          '',
        ].join('\n'),
      );
    } catch (error) {
      fail(error);
    }
  });

/* ── slots ─────────────────────────────────────────────────────────────── */

program
  .command('slots')
  .description('플랫폼 섀도우밴 방지를 위한 지터 분산 발행 슬롯 계산')
  .requiredOption('--count <n>', '발행 횟수')
  .option('--start <HH:MM>', '창 시작 (오늘 기준)', '09:00')
  .option('--end <HH:MM>', '창 종료 (오늘 기준)', '23:00')
  .option('--min-gap <min>', '최소 간격(분)', '60')
  .option('--json', 'JSON으로 출력')
  .action((options) => {
    try {
      const base = new Date();
      const [startHour, startMinute] = String(options.start).split(':').map(Number);
      const [endHour, endMinute] = String(options.end).split(':').map(Number);
      const start = new Date(base);
      start.setHours(startHour, startMinute, 0, 0);
      const end = new Date(base);
      end.setHours(endHour, endMinute, 0, 0);
      const slots = planPublishSlots({
        count: Number(options.count),
        windowStartMs: start.getTime(),
        windowEndMs: end.getTime(),
        minGapMs: Number(options.minGap) * 60_000,
      });
      const stats = gapStatistics(slots);
      if (options.json) {
        printJson({ slots, stats });
        return;
      }
      process.stdout.write(
        [
          '',
          `발행 슬롯 ${slots.length}건 · ${options.start}~${options.end} · 최소 ${options.minGap}분`,
          ...slots.map(
            (slot) =>
              `  ${String(slot.index + 1).padStart(2)}. ${new Date(slot.atMs).toTimeString().slice(0, 8)}  (+${Math.round(slot.gapVsPrevMs / 60_000)}분)`,
          ),
          `  간격 평균 ${Math.round(stats.meanGapMs / 60_000)}분 · 표준편차 ${Math.round(stats.stdevGapMs / 60_000)}분 · 규칙성 ${stats.spreadRatio}`,
          '',
        ].join('\n'),
      );
    } catch (error) {
      fail(error);
    }
  });

/* ── studio ────────────────────────────────────────────────────────────── */

program
  .command('studio')
  .description('B2B 스튜디오 모니터링 콘솔 (큐 · 워커 · 쿼터 · OAuth · 훅 A/B)')
  .option('--state <file>', '큐 상태 파일 (없으면 내장 데모 상태)')
  .option('--html <file>', 'HTML 대시보드 저장 경로')
  .option('--json', 'JSON 스냅샷으로 출력')
  .action(async (options) => {
    try {
      let console: StudioConsole;
      if (options.state) {
        const queue = new JobQueue({ store: new FileQueueStore(String(options.state)) });
        console = new StudioConsole({
          queue,
          tenants: (() => {
            const registry = new TenantRegistry();
            registry.register({ id: 'studio-demo', name: 'Studio Demo', plan: 'starter' });
            return registry;
          })(),
        });
      } else {
        console = (await createDemoStudio()).console;
      }
      const snapshot = await console.snapshot();
      if (options.html) {
        await writeFile(String(options.html), console.renderHtml(snapshot), 'utf8');
      }
      if (options.json) {
        printJson(snapshot);
        return;
      }
      process.stdout.write(console.renderText(snapshot));
      if (options.html) process.stdout.write(`\nHTML dashboard: ${options.html}\n`);
      process.stdout.write('\n');
    } catch (error) {
      fail(error);
    }
  });

program.parseAsync(process.argv).catch((error) => fail(error));

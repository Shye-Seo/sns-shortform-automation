import { spawn } from 'node:child_process';
import { ShortformError } from './errors';
import type { RenderProbe } from '../types/render';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  /** Bytes of stderr to keep for diagnostics. */
  captureBytes?: number;
}

/**
 * Spawn without a shell so user text (topics, captions) can never be
 * interpreted as shell syntax. ffmpeg filter graphs contain quotes and
 * semicolons; passing them as argv keeps them literal.
 */
export function runCommand(bin: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const captureLimit = options.captureBytes ?? 64 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new ShortformError(`${bin} timed out after ${timeoutMs}ms`, {
          code: 'MEDIA',
          details: { bin, args: args.slice(0, 8) },
        }),
      );
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < captureLimit) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < captureLimit) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new ShortformError(`could not start ${bin}: ${error.message}`, {
          code: 'MEDIA',
          cause: error,
          details: { bin },
        }),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function commandExists(bin: string, versionFlag = '-version'): Promise<boolean> {
  try {
    const result = await runCommand(bin, [versionFlag], { timeoutMs: 8000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
}

interface FfprobeJson {
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

export function formatFromContainer(formatName: string): string {
  if (formatName.includes('mp4') || formatName.includes('mov')) return 'mp4';
  if (formatName.includes('matroska')) return 'mkv';
  if (formatName.includes('webm')) return 'webm';
  if (formatName.includes('wav')) return 'wav';
  if (formatName.includes('mp3')) return 'mp3';
  return formatName.split(',')[0] ?? formatName;
}

/**
 * Parse a rational frame rate ("30000/1001") the way ffprobe reports it.
 * Returns 0 for a malformed value instead of NaN so comparisons stay sane.
 */
export function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/');
  const n = Number(numerator);
  const d = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return Number(value) || 0;
  return n / d;
}

/** Pure parser so probe behaviour can be tested without ffprobe installed. */
export function parseFfprobeJson(raw: string): RenderProbe {
  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(raw) as FfprobeJson;
  } catch (error) {
    throw new ShortformError('ffprobe returned non-JSON output', {
      code: 'MEDIA',
      cause: error,
    });
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) {
    throw new ShortformError('media has no video stream', { code: 'MEDIA' });
  }

  return {
    container: formatFromContainer(parsed.format?.format_name ?? ''),
    durationSec: Number(parsed.format?.duration ?? 0),
    sizeBytes: Number(parsed.format?.size ?? 0),
    bitRate: Number(parsed.format?.bit_rate ?? 0),
    video: {
      codec: video.codec_name ?? 'unknown',
      profile: video.profile,
      width: Number(video.width ?? 0),
      height: Number(video.height ?? 0),
      fps: parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate),
      pixFmt: video.pix_fmt ?? 'unknown',
      bitRate: Number(video.bit_rate ?? parsed.format?.bit_rate ?? 0),
    },
    audio: audio
      ? {
          codec: audio.codec_name ?? 'unknown',
          sampleRate: Number(audio.sample_rate ?? 0),
          channels: Number(audio.channels ?? 0),
          bitRate: Number(audio.bit_rate ?? 0),
        }
      : null,
  };
}

export async function probeMedia(
  path: string,
  bin = process.env.FFPROBE_PATH ?? 'ffprobe',
): Promise<RenderProbe> {
  const result = await runCommand(
    bin,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0) {
    throw new ShortformError(`ffprobe failed on ${path}`, {
      code: 'MEDIA',
      details: { stderr: result.stderr.slice(-800) },
    });
  }
  return parseFfprobeJson(result.stdout);
}

/** Parse a WAV header without ffprobe — used for locally synthesised voice. */
export function readWavInfo(buffer: Buffer): {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationSec: number;
} {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new ShortformError('not a RIFF/WAV buffer', { code: 'MEDIA' });
  }
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataBytes = buffer.readUInt32LE(40);
  const bytesPerFrame = (bitsPerSample / 8) * channels;
  const durationSec = bytesPerFrame > 0 ? dataBytes / bytesPerFrame / sampleRate : 0;
  return { sampleRate, channels, bitsPerSample, durationSec };
}

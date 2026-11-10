import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ShortformError } from '../lib/errors';
import { alignCharactersToWords, estimateWordTimings } from '../lib/align';
import { synthesizeVoiceWav } from '../lib/wav';
import type { Language } from '../types/script';
import type { WordTiming } from '../types/audio';

export interface TtsRequest {
  text: string;
  language: Language;
  sceneId: string;
  /** Where the provider must write the audio file. */
  outputPath: string;
  /**
   * The slot the voice has to fit into. Providers use it as a length hint;
   * the engine still measures the result and re-times if the provider overruns.
   */
  targetDurationSec: number;
  speed?: number;
  voiceId?: string;
}

export interface TtsResult {
  audioPath: string;
  /** 0 means "unknown, probe the file" (binary TTS APIs do not report length). */
  durationSec: number;
  sampleRate: number;
  channels: number;
  format: 'wav' | 'mp3';
  words: WordTiming[] | null;
  alignmentSource: 'provider' | 'estimated';
  provider: string;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(request: TtsRequest): Promise<TtsResult>;
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

/**
 * Offline provider. Emits a synthetic voice at exactly the target duration so
 * the rest of the pipeline can be tested end to end without network access.
 */
export class LocalTtsProvider implements TtsProvider {
  readonly name = 'local-synthetic';
  private readonly sampleRate: number;

  constructor(options: { sampleRate?: number } = {}) {
    this.sampleRate = options.sampleRate ?? 48_000;
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const durationSec = Math.max(0.4, request.targetDurationSec);
    const { buffer, words } = synthesizeVoiceWav(request.text, durationSec, {
      sampleRate: this.sampleRate,
      language: request.language,
    });
    await ensureDir(request.outputPath);
    await writeFile(request.outputPath, buffer);
    return {
      audioPath: request.outputPath,
      durationSec,
      sampleRate: this.sampleRate,
      channels: 1,
      format: 'wav',
      words: words.map((word) => ({ ...word, sceneId: request.sceneId })),
      alignmentSource: 'estimated',
      provider: this.name,
    };
  }
}

export interface ElevenLabsOptions {
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * ElevenLabs returns character-level alignment together with the audio, which
 * is what makes true word-level captions possible without a separate forced
 * aligner.
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = 'elevenlabs';
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ElevenLabsOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ELEVENLABS_API_KEY;
    const voiceId = options.voiceId ?? process.env.ELEVENLABS_VOICE_ID;
    if (!apiKey) {
      throw new ShortformError('ELEVENLABS_API_KEY is not set', {
        code: 'CONFIG',
        details: { env: 'ELEVENLABS_API_KEY' },
      });
    }
    if (!voiceId) {
      throw new ShortformError('ELEVENLABS_VOICE_ID is not set', {
        code: 'CONFIG',
        details: { env: 'ELEVENLABS_VOICE_ID' },
      });
    }
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.modelId = options.modelId ?? process.env.ELEVENLABS_MODEL_ID ?? 'eleven_multilingual_v2';
    this.baseUrl = options.baseUrl ?? 'https://api.elevenlabs.io';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(request.voiceId ?? this.voiceId)}/with-timestamps`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'xi-api-key': this.apiKey,
          },
          body: JSON.stringify({
            text: request.text,
            model_id: this.modelId,
            voice_settings: {
              stability: 0.42,
              similarity_boost: 0.8,
              style: 0.3,
              use_speaker_boost: true,
            },
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ShortformError(`ElevenLabs request failed (${response.status})`, {
          code: 'EXTERNAL',
          retryable: response.status === 429 || response.status >= 500,
          details: { status: response.status, detail: detail.slice(0, 400) },
        });
      }

      const payload = (await response.json()) as {
        audio_base64?: string;
        alignment?: {
          characters?: string[];
          character_start_times_seconds?: number[];
          character_end_times_seconds?: number[];
        };
      };

      if (!payload.audio_base64 || !payload.alignment?.characters) {
        throw new ShortformError('ElevenLabs response is missing audio or alignment', {
          code: 'EXTERNAL',
        });
      }

      const buffer = Buffer.from(payload.audio_base64, 'base64');
      await ensureDir(request.outputPath);
      await writeFile(request.outputPath, buffer);

      const words = alignCharactersToWords(request.text, {
        characters: payload.alignment.characters,
        startTimes: payload.alignment.character_start_times_seconds ?? [],
        endTimes: payload.alignment.character_end_times_seconds ?? [],
      }).map((word) => ({ ...word, sceneId: request.sceneId }));

      const lastEnd = words[words.length - 1]?.endSec ?? 0;

      return {
        audioPath: request.outputPath,
        durationSec: lastEnd + 0.08,
        sampleRate: 44_100,
        channels: 1,
        format: 'mp3',
        words,
        alignmentSource: 'provider',
        provider: this.name,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface OpenAiTtsOptions {
  apiKey?: string;
  model?: string;
  voice?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * OpenAI TTS returns audio only. Word timings here are estimated from the
 * known length and flagged as such, so nobody mistakes them for forced
 * alignment in the render report.
 */
export class OpenAiTtsProvider implements TtsProvider {
  readonly name = 'openai-tts';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAiTtsOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new ShortformError('OPENAI_API_KEY is not set', {
        code: 'CONFIG',
        details: { env: 'OPENAI_API_KEY' },
      });
    }
    this.apiKey = apiKey;
    this.model = options.model ?? process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts';
    this.voice = options.voice ?? process.env.OPENAI_TTS_VOICE ?? 'nova';
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          voice: this.voice,
          input: request.text,
          response_format: 'mp3',
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ShortformError(`OpenAI TTS failed (${response.status})`, {
          code: 'EXTERNAL',
          retryable: response.status === 429 || response.status >= 500,
          details: { status: response.status, detail: detail.slice(0, 400) },
        });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await ensureDir(request.outputPath);
      await writeFile(request.outputPath, buffer);

      return {
        audioPath: request.outputPath,
        durationSec: 0,
        sampleRate: 24_000,
        channels: 1,
        format: 'mp3',
        words: null,
        alignmentSource: 'estimated',
        provider: this.name,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Fallback alignment for providers that only return audio. */
export function estimateAlignmentFor(
  text: string,
  durationSec: number,
  language: Language,
  sceneId: string,
): WordTiming[] {
  return estimateWordTimings(text, durationSec, { language }).map((word) => ({
    ...word,
    sceneId,
  }));
}

export type TtsProviderName = 'local' | 'elevenlabs' | 'openai';

export function createTtsProvider(
  name: TtsProviderName | string,
  options: { fetchImpl?: typeof fetch } = {},
): TtsProvider {
  switch (name) {
    case 'local':
      return new LocalTtsProvider();
    case 'elevenlabs':
      return new ElevenLabsTtsProvider({ fetchImpl: options.fetchImpl });
    case 'openai':
      return new OpenAiTtsProvider({ fetchImpl: options.fetchImpl });
    default:
      throw new ShortformError(`unknown TTS provider "${name}"`, {
        code: 'CONFIG',
        details: { supported: ['local', 'elevenlabs', 'openai'] },
      });
  }
}

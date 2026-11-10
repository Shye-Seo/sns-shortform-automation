import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ShortformError } from '../lib/errors';
import { clamp, round } from '../lib/ids';
import { silentLogger, type Logger } from '../lib/logger';
import { runCommand, probeMedia, readWavInfo } from '../lib/media';
import { encodeWavPcm16, mixAtOffsets } from '../lib/wav';
import { mergeVoiceSegments } from '../lib/align';
import { formatAssTime, formatSrtTime, formatVttTime, toCentiseconds } from '../lib/timecode';
import { normalizeWhitespace, wrapText } from '../lib/text';
import {
  CueConfigSchema,
  DuckingConfigSchema,
  SubtitleStyleSchema,
  type Cue,
  type CueConfig,
  type DuckingConfig,
  type DuckingEnvelope,
  type GainKeyframe,
  type SubtitleBundle,
  type SubtitleStyle,
  type VoiceOver,
  type WordTiming,
} from '../types/audio';
import type { ShortformScript } from '../types/script';
import type { TtsProvider, TtsResult } from './tts';
import { estimateAlignmentFor } from './tts';

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Audio ducking
 * ──────────────────────────────────────────────────────────────────────────── */

export interface DuckingInput {
  segments: Array<{ startSec: number; endSec: number }>;
  durationSec: number;
  config?: Partial<DuckingConfig>;
}

/**
 * Build the music gain envelope.
 *
 * While the voice speaks the bed drops to `duckGain` (15%); between lines it
 * returns to `baseGain` (55%). The attack/release ramps are linear so the
 * result is a piecewise-linear function that can be sampled exactly in tests
 * and rendered exactly by ffmpeg's `volume=eval=frame`.
 *
 * Two rules make it sound professional rather than mechanical:
 *  - a gap shorter than `minGapMs` never releases (no pumping between words);
 *  - voice blips shorter than `minVoiceMs` never trigger a duck (no chatter).
 */
export function computeDuckingEnvelope(input: DuckingInput): DuckingEnvelope {
  const config = DuckingConfigSchema.parse({ ...input.config });
  const { duckGain, baseGain, attackMs, releaseMs, minGapMs, maxGain } = config;
  const duck = clamp(Math.min(duckGain, maxGain), 0, 1);
  const base = clamp(Math.min(baseGain, maxGain), 0, 1);
  const attackSec = attackMs / 1000;
  const releaseSec = releaseMs / 1000;
  const durationSec = Math.max(0, input.durationSec);

  const merged = mergeVoiceSegments(input.segments, {
    minGapSec: minGapMs / 1000,
    minSegmentSec: config.minVoiceMs / 1000,
  });

  const keyframes: GainKeyframe[] = [{ tSec: 0, gain: base }];
  let state: 'base' | 'duck' = 'base';
  let duckedSec = 0;

  const push = (tSec: number, gain: number): void => {
    const t = round(clamp(tSec, 0, durationSec), 3);
    const last = keyframes[keyframes.length - 1] as GainKeyframe;
    if (t < last.tSec) return;
    if (Math.abs(t - last.tSec) < 1e-6) {
      last.gain = round(clamp(gain, 0, 1), 4);
      return;
    }
    keyframes.push({ tSec: t, gain: round(clamp(gain, 0, 1), 4) });
  };

  merged.forEach((segment, index) => {
    const start = round(clamp(segment.startSec, 0, durationSec), 3);
    const end = round(clamp(segment.endSec, 0, durationSec), 3);
    if (end - start <= 0) return;

    if (state === 'base') {
      push(start, base);
      const reach = Math.min(start + attackSec, end);
      push(reach, duck);
      state = 'duck';
    } else {
      // Already ducked: extend without an audible re-attack.
      push(start, duck);
    }

    const next = merged[index + 1];
    const gapToNext = next ? Math.max(0, next.startSec - end) : Number.POSITIVE_INFINITY;
    const needsFullRelease = gapToNext >= minGapMs / 1000 + releaseSec;

    push(end, duck);
    if (needsFullRelease) {
      const releaseEnd = Math.min(durationSec, end + releaseSec);
      push(releaseEnd, base);
      state = 'base';
    } else if (next) {
      // Hold the duck through the short gap; the next attack is skipped.
      state = 'duck';
    } else {
      const releaseEnd = Math.min(durationSec, end + releaseSec);
      push(releaseEnd, base);
      state = 'base';
    }

    duckedSec += Math.max(0, end - start);
  });

  if (keyframes.length === 1) {
    push(durationSec, base);
  }

  return {
    keyframes,
    config,
    durationSec: round(durationSec, 3),
    duckedRatio: round(durationSec > 0 ? clamp(duckedSec / durationSec, 0, 1) : 0, 4),
    rawVoiceSegments: input.segments.length,
    mergedVoiceSegments: merged.length,
  };
}

/** Sample the piecewise-linear envelope at an arbitrary time. */
export function sampleEnvelope(envelope: DuckingEnvelope, tSec: number): number {
  const frames = envelope.keyframes;
  if (frames.length === 0) return 0;
  const first = frames[0] as GainKeyframe;
  const last = frames[frames.length - 1] as GainKeyframe;
  if (tSec <= first.tSec) return first.gain;
  if (tSec >= last.tSec) return last.gain;

  let low = 0;
  let high = frames.length - 1;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if ((frames[mid] as GainKeyframe).tSec <= tSec) low = mid;
    else high = mid;
  }
  const a = frames[low] as GainKeyframe;
  const b = frames[high] as GainKeyframe;
  const span = b.tSec - a.tSec;
  if (span <= 0) return b.gain;
  const ratio = (tSec - a.tSec) / span;
  return a.gain + (b.gain - a.gain) * ratio;
}

/**
 * ffmpeg volume expression. Values must be wrapped in single quotes inside the
 * filtergraph so ffmpeg does not read the commas in `if(...)` as filter
 * separators.
 */
export function buildVolumeExpression(envelope: DuckingEnvelope): string {
  const frames = envelope.keyframes;
  if (frames.length === 0) return '1';
  const g = (value: number): string => Number(value.toFixed(4)).toString();
  let expression = g((frames[frames.length - 1] as GainKeyframe).gain);

  for (let i = frames.length - 2; i >= 0; i -= 1) {
    const a = frames[i] as GainKeyframe;
    const b = frames[i + 1] as GainKeyframe;
    const span = b.tSec - a.tSec;
    const interp =
      span <= 0
        ? g(b.gain)
        : `${g(a.gain)}+${g(b.gain - a.gain)}*(t-${Number(a.tSec.toFixed(3))})/${Number(span.toFixed(3))}`;
    expression = `if(lt(t,${Number(b.tSec.toFixed(3))}),${interp},${expression})`;
  }
  return expression;
}

export interface MixFilterInput {
  durationSec: number;
  voiceInputLabel: string;
  musicInputLabel: string | null;
  envelope: DuckingEnvelope;
  musicGainDb?: number;
  outputLabel?: string;
  loudnessTargetLufs?: number;
  sampleRate?: number;
}

/**
 * Ducking + mix + loudness normalisation in one filter chain.
 * -level: -14 LUFS integrated is what Instagram and YouTube normalise toward,
 * so matching it here avoids a volume jump after upload.
 */
export function buildMixFilter(input: MixFilterInput): string {
  const out = input.outputLabel ?? 'aout';
  const loudness = input.loudnessTargetLufs ?? -14;
  const voice = `[${input.voiceInputLabel}]apad=whole_dur=${round(input.durationSec, 3)}[vpad]`;
  const chain: string[] = [voice];

  if (input.musicInputLabel) {
    const expression = buildVolumeExpression(input.envelope);
    chain.push(
      `[${input.musicInputLabel}]atrim=0:${round(input.durationSec, 3)},asetpts=N/SR/TB,` +
        `volume=${round(input.musicGainDb ?? 0, 2)}dB,` +
        `volume=eval=frame:volume='${expression}'[mduck]`,
    );
    chain.push(
      `[vpad][mduck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]`,
    );
  } else {
    chain.push(`[vpad]anull[mixed]`);
  }

  chain.push(
    `[mixed]loudnorm=I=${loudness}:TP=-1.5:LRA=11,aresample=${input.sampleRate ?? 48_000}[${out}]`,
  );
  return chain.join(';');
}

/** CSV export so the envelope can be eyeballed in a spreadsheet or a DAW. */
export function envelopeToCsv(envelope: DuckingEnvelope): string {
  const rows = ['time_sec,gain'];
  for (const frame of envelope.keyframes) {
    rows.push(`${frame.tSec.toFixed(3)},${frame.gain.toFixed(4)}`);
  }
  return rows.join('\n');
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Subtitle cues
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CueBuildOptions {
  config?: Partial<CueConfig>;
  style?: Partial<SubtitleStyle>;
  /** Text box width available for caption lines, in pixels. */
  maxWidthPx?: number;
}

function cueText(words: WordTiming[]): string {
  return words.map((word) => word.text).join(' ');
}

/**
 * Group words into caption cards.
 *
 * A new card starts when any of these is exceeded: duration, characters per
 * second (reading speed), line capacity, or a scene/sentence boundary. CPS is
 * the limit that actually matters on a phone — 22 chars/sec is the point where
 * Korean captions stop being readable while the voice keeps moving.
 */
export function buildCues(words: WordTiming[], options: CueBuildOptions = {}): Cue[] {
  const config = CueConfigSchema.parse({ ...options.config });
  const style = SubtitleStyleSchema.parse({ ...options.style });
  const maxWidthPx = options.maxWidthPx ?? 860;
  const sorted = [...words].sort((a, b) => a.startSec - b.startSec);
  if (sorted.length === 0) return [];

  const fitsBox = (group: WordTiming[]): boolean =>
    wrapText(cueText(group), {
      maxWidthPx,
      fontSizePx: style.fontSizePx,
      maxLines: config.maxLines,
    }).length <= config.maxLines;

  // Pass 1 — time, reading speed, scene and sentence boundaries.
  const charBudget = config.maxCharsPerLine * config.maxLines;
  const groups: WordTiming[][] = [];
  let current: WordTiming[] = [];

  for (const word of sorted) {
    if (current.length === 0) {
      current = [word];
      continue;
    }
    const first = current[0] as WordTiming;
    const previous = current[current.length - 1] as WordTiming;
    const candidate = [...current, word];
    const duration = word.endSec - first.startSec;
    const text = cueText(candidate);
    const cps = duration > 0 ? text.length / duration : Number.POSITIVE_INFINITY;
    const sceneChanged = Boolean(first.sceneId && word.sceneId && first.sceneId !== word.sceneId);
    const sentenceBreak = config.breakOnSentence && /[.!?…]$/u.test(previous.text);

    if (
      duration > config.maxCueSec ||
      cps > config.maxCps ||
      text.length > charBudget ||
      sceneChanged ||
      sentenceBreak
    ) {
      groups.push(current);
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) groups.push(current);

  // Pass 2 — a group that needs more than maxLines is split in half, not
  // truncated at the last word, so a card never ends on "됩니다" alone.
  const fitted: WordTiming[][] = [];
  const pushSplit = (group: WordTiming[], depth: number): void => {
    if (group.length <= 1 || fitsBox(group) || depth >= 4) {
      fitted.push(group);
      return;
    }
    const mid = Math.ceil(group.length / 2);
    pushSplit(group.slice(0, mid), depth + 1);
    pushSplit(group.slice(mid), depth + 1);
  };
  groups.forEach((group) => pushSplit(group, 0));

  // Pass 3 — fold a one-word orphan back into its neighbour when the combined
  // card still respects the duration and line limits.
  const balanced: WordTiming[][] = [];
  for (const group of fitted) {
    const previous = balanced[balanced.length - 1];
    if (previous && group.length === 1 && previous.length > 1) {
      const combined = [...previous, ...group];
      const duration = (combined[combined.length - 1] as WordTiming).endSec - (combined[0] as WordTiming).startSec;
      if (duration <= config.maxCueSec + 0.3 && fitsBox(combined)) {
        balanced[balanced.length - 1] = combined;
        continue;
      }
    }
    balanced.push(group);
  }

  return balanced.map((group, index) => {
    const text = cueText(group);
    let lines = wrapText(text, {
      maxWidthPx,
      fontSizePx: style.fontSizePx,
      maxLines: config.maxLines,
    });
    if (lines.length > config.maxLines) {
      lines = lines.slice(0, config.maxLines);
      const last = lines[lines.length - 1] as string;
      lines[lines.length - 1] = `${last}…`;
    }
    const startSec = (group[0] as WordTiming).startSec;
    const naturalEnd = (group[group.length - 1] as WordTiming).endSec;
    const nextStart = balanced[index + 1]?.[0]?.startSec ?? naturalEnd + config.minCueSec;
    const endSec = Math.max(
      naturalEnd,
      Math.min(startSec + config.minCueSec, nextStart - 0.02),
    );
    const lastWord = group[group.length - 1] as WordTiming;

    return {
      index: index + 1,
      startSec: round(startSec, 3),
      endSec: round(endSec, 3),
      lines,
      words: group,
      sceneId: group[0]?.sceneId,
      sentenceEnd: /[.!?…]$/u.test(lastWord?.text ?? ''),
    } satisfies Cue;
  });
}

export interface WrappedCue {
  lines: string[];
  /** For each word, the index of the line it appears on. */
  wordLine: number[];
}

/**
 * Wrap a cue and keep the word -> line mapping, which the ASS pulse renderer
 * needs to colour exactly one word without moving the line.
 */
export function wrapCueWords(words: WordTiming[], maxWidthPx: number, fontSizePx: number, maxLines: number): WrappedCue {
  const tokens = words.map((word) => word.text);
  const text = normalizeWhitespace(tokens.join(' '));
  const lines = wrapText(text, { maxWidthPx, fontSizePx, maxLines });

  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  for (const line of lines) {
    const found = text.indexOf(line, cursor);
    if (found < 0) {
      ranges.push([cursor, cursor + line.length]);
    } else {
      ranges.push([found, found + line.length]);
      cursor = found + line.length;
    }
  }

  const wordLine: number[] = [];
  let offset = 0;
  for (const token of tokens) {
    const lineIndex = ranges.findIndex(([from, to]) => offset >= from && offset < to);
    wordLine.push(lineIndex >= 0 ? lineIndex : Math.max(0, lines.length - 1));
    offset += token.length + 1;
  }
  return { lines, wordLine };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Subtitle serialisation
 * ──────────────────────────────────────────────────────────────────────────── */

export function buildSrt(cues: Cue[]): string {
  return `${cues
    .map(
      (cue) =>
        `${cue.index}\n${formatSrtTime(cue.startSec)} --> ${formatSrtTime(cue.endSec)}\n${cue.lines.join('\n')}`,
    )
    .join('\n\n')}\n`;
}

/** WebVTT with inline word timestamps (valid and player-recognised). */
export function buildVtt(cues: Cue[]): string {
  const blocks = cues.map((cue) => {
    const body = cue.lines.join('\n');
    return `${cue.index}\n${formatVttTime(cue.startSec)} --> ${formatVttTime(cue.endSec)}\n${body}`;
  });
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

/** Inline ASS colour without alpha: \c&HBBGGRR& */
export function assRgb(hex: string): string {
  const clean = hex.replace('#', '').toUpperCase();
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${b}${g}${r}&`;
}

export function assColor(hex: string, alpha = 0): string {
  const clean = hex.replace('#', '').toUpperCase();
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  const a = alpha.toString(16).padStart(2, '0').toUpperCase();
  return `&H${a}${b}${g}${r}`;
}

export interface AssPlacement {
  centerX: number;
  baselineY: number;
  maxWidthPx: number;
}

function escapeAss(text: string): string {
  return text.replace(/[{}]/g, (char) => (char === '{' ? '(' : ')')).replace(/\r?\n/g, ' ');
}

export function buildAss(
  cues: Cue[],
  style: Partial<SubtitleStyle> = {},
  placement: AssPlacement = { centerX: 540, baselineY: 1320, maxWidthPx: 860 },
  canvas = { width: 1080, height: 1920 },
): string {
  const resolved = SubtitleStyleSchema.parse({ ...style });
  const primary = assColor(resolved.primaryColor);
  const highlight = assColor(resolved.highlightColor);
  const outline = assColor(resolved.outlineColor);
  const back = assColor('#000000', 0x64);

  // In sweep mode the karaoke fill turns words into the primary colour, so the
  // style colours are swapped relative to pulse mode.
  const stylePrimary = resolved.mode === 'sweep' ? highlight : primary;
  const styleSecondary = resolved.mode === 'sweep' ? primary : highlight;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${resolved.fontName},${resolved.fontSizePx},${stylePrimary},${styleSecondary},${outline},${back},-1,0,0,0,100,100,1,0,1,${resolved.outlinePx},${resolved.shadowPx},2,${resolved.marginXPx},${resolved.marginXPx},${resolved.marginVPx},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  const pos = `\\an2\\pos(${Math.round(placement.centerX)},${Math.round(placement.baselineY)})`;

  for (const cue of cues) {
    const wrapped = wrapCueWords(
      cue.words,
      placement.maxWidthPx,
      resolved.fontSizePx,
      cue.lines.length > 1 ? 2 : 1,
    );
    const lines = wrapped.lines.length > 0 ? wrapped.lines : cue.lines;

    if (resolved.mode === 'sweep') {
      const karaoke = cue.words
        .map((word) => `{\\kf${toCentiseconds(word.endSec - word.startSec)}}${escapeAss(word.text)} `)
        .join('')
        .trim();
      events.push(
        `Dialogue: 0,${formatAssTime(cue.startSec)},${formatAssTime(cue.endSec)},Caption,,0,0,0,,{${pos}}${karaoke}`,
      );
      continue;
    }

    // Pulse: one event per word, the whole cue redrawn with only the active
    // word accented. Identical geometry, so nothing jumps between events.
    cue.words.forEach((word, wordIndex) => {
      const nextStart = cue.words[wordIndex + 1]?.startSec ?? cue.endSec;
      const start = word.startSec;
      if (nextStart - start <= 0.001) return;

      const lineTexts = lines.map((line, lineIndex) => {
        const wordsOnLine: Array<{ text: string; active: boolean }> = [];
        cue.words.forEach((candidate, index) => {
          if ((wrapped.wordLine[index] ?? 0) !== lineIndex) return;
          wordsOnLine.push({ text: escapeAss(candidate.text), active: index === wordIndex });
        });
        return wordsOnLine
          .map((entry) =>
            entry.active ? `{\\c${highlight}\\fscx104\\fscy104}${entry.text}{\\c${primary}\\fscx100\\fscy100}` : entry.text,
          )
          .join(' ');
      });

      const body = lineTexts.join('\\N');
      events.push(
        `Dialogue: 0,${formatAssTime(start)},${formatAssTime(nextStart)},Caption,,0,0,0,,{${pos}}${body}`,
      );
    });
  }

  return [...header, ...events].join('\n') + '\n';
}

export function buildSubtitleBundle(
  cues: Cue[],
  style: Partial<SubtitleStyle> = {},
  placement?: AssPlacement,
): SubtitleBundle {
  const resolvedStyle = SubtitleStyleSchema.parse({ ...style });
  const durations = cues.map((cue) => cue.endSec - cue.startSec);
  const cpsValues = cues.map((cue) => {
    const duration = Math.max(0.001, cue.endSec - cue.startSec);
    return cue.lines.join(' ').length / duration;
  });

  return {
    cues,
    style: resolvedStyle,
    srt: buildSrt(cues),
    vtt: buildVtt(cues),
    ass: buildAss(cues, resolvedStyle, placement),
    stats: {
      cueCount: cues.length,
      wordCount: cues.reduce((sum, cue) => sum + cue.words.length, 0),
      longestCueSec: round(durations.length > 0 ? Math.max(...durations) : 0, 2),
      maxCps: round(cpsValues.length > 0 ? Math.max(...cpsValues) : 0, 1),
    },
  };
}

export async function writeSubtitleFiles(directory: string, bundle: SubtitleBundle, baseName = 'captions'): Promise<{ srt: string; vtt: string; ass: string }> {
  await mkdir(directory, { recursive: true });
  const srt = join(directory, `${baseName}.srt`);
  const vtt = join(directory, `${baseName}.vtt`);
  const ass = join(directory, `${baseName}.ass`);
  await Promise.all([
    writeFile(srt, bundle.srt, 'utf8'),
    writeFile(vtt, bundle.vtt, 'utf8'),
    writeFile(ass, bundle.ass, 'utf8'),
  ]);
  return { srt, vtt, ass };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Voice track assembly
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SceneVoice {
  sceneId: string;
  path: string;
  /** Start on the final timeline. */
  startSec: number;
  durationSec: number;
  words: WordTiming[];
}

export interface VoiceTrack {
  path: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  alignmentSource: 'provider' | 'estimated';
  provider: string;
  words: WordTiming[];
  scenes: SceneVoice[];
  warnings: string[];
  audio: VoiceOver;
}

export interface BuildVoiceOptions {
  outputDir: string;
  tts: TtsProvider;
  logger?: Logger;
  sampleRate?: number;
  /** Injected for tests / offline runs. */
  probe?: typeof probeMedia;
  convertToWav?: (source: string, target: string) => Promise<void>;
}

async function convertWithFfmpeg(source: string, target: string): Promise<void> {
  const bin = process.env.FFMPEG_PATH ?? 'ffmpeg';
  const result = await runCommand(
    bin,
    ['-y', '-v', 'error', '-i', source, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', target],
    { timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    throw new ShortformError('ffmpeg could not normalise the TTS audio to WAV', {
      code: 'MEDIA',
      details: { stderr: result.stderr.slice(-600) },
    });
  }
}

/**
 * Synthesise every scene, measure it, and lay it on the timeline.
 *
 * Scenes are synthesised separately on purpose: fixing one line means
 * re-rendering one short clip instead of the whole voice track. Overflowing
 * scenes push the rest of the timeline instead of being cut off mid-word.
 */
export class AudioEngine {
  private readonly logger: Logger;
  private readonly sampleRate: number;

  constructor(options: { logger?: Logger; sampleRate?: number } = {}) {
    this.logger = options.logger ?? silentLogger;
    this.sampleRate = options.sampleRate ?? 48_000;
  }

  async buildVoiceTrack(script: ShortformScript, options: BuildVoiceOptions): Promise<VoiceTrack> {
    const { outputDir, tts } = options;
    const probe = options.probe ?? probeMedia;
    const convert = options.convertToWav ?? convertWithFfmpeg;
    const voiceDir = join(outputDir, 'voice');
    await mkdir(voiceDir, { recursive: true });

    const warnings: string[] = [];
    const scenes: SceneVoice[] = [];
    const parts: Array<{ samples: Float32Array; offsetSec: number }> = [];
    let shift = 0;
    let alignmentSource: 'provider' | 'estimated' = 'provider';
    let maxEnd = 0;

    for (const scene of script.scenes) {
      const extension = tts.name.startsWith('local') ? 'wav' : 'mp3';
      const rawPath = join(voiceDir, `${scene.id}.${extension}`);
      const wavPath = join(voiceDir, `${scene.id}.wav`);

      const result: TtsResult = await tts.synthesize({
        text: scene.narration,
        language: script.language,
        sceneId: scene.id,
        outputPath: rawPath,
        targetDurationSec: Math.max(0.8, scene.estimatedSpeechSec),
        speed: script.speed,
      });

      let durationSec = result.durationSec;
      if (durationSec <= 0) {
        const probed = await probe(rawPath);
        durationSec = probed.durationSec;
      }

      let audioPath = result.audioPath;
      if (result.format !== 'wav') {
        await convert(result.audioPath, wavPath);
        audioPath = wavPath;
      }

      if (result.alignmentSource === 'estimated') alignmentSource = 'estimated';

      const startSec = round(scene.startSec + shift, 3);
      const slotEnd = round(scene.startSec + scene.durationSec, 3);
      const endSec = round(startSec + durationSec, 3);
      if (endSec > slotEnd + 0.02) {
        const overrun = round(endSec - slotEnd, 3);
        shift += overrun;
        warnings.push(
          `scene ${scene.id} ran ${overrun}s over its slot; later scenes were shifted`,
        );
      }

      const words = (result.words ?? estimateAlignmentFor(scene.narration, durationSec, script.language, scene.id)).map(
        (word, index) => ({
          ...word,
          index,
          startSec: round(startSec + word.startSec, 3),
          endSec: round(startSec + word.endSec, 3),
          sceneId: scene.id,
        }),
      );

      const buffer = await readFileOrThrow(audioPath);
      const info = readWavInfo(buffer);
      const samples = decodeWavMono(buffer, info.channels);
      parts.push({ samples, offsetSec: startSec });
      maxEnd = Math.max(maxEnd, endSec);
      scenes.push({ sceneId: scene.id, path: audioPath, startSec, durationSec: round(durationSec, 3), words });
    }

    const durationSec = round(Math.max(script.metrics.totalDurationSec, maxEnd + 0.2), 3);
    const mixed = mixAtOffsets(parts, durationSec, this.sampleRate);
    const voicePath = join(outputDir, 'voice.wav');
    await writeFile(voicePath, encodeWavPcm16(mixed, this.sampleRate, 1));

    const words = scenes.flatMap((scene) => scene.words);
    const audio: VoiceOver = {
      provider: tts.name,
      path: voicePath,
      durationSec,
      sampleRate: this.sampleRate,
      channels: 1,
      alignmentSource,
      words,
    };

    this.logger.info(`voice track: ${durationSec}s, ${words.length} words, ${scenes.length} scenes`);

    return {
      path: voicePath,
      durationSec,
      sampleRate: this.sampleRate,
      channels: 1,
      alignmentSource,
      provider: tts.name,
      words,
      scenes,
      warnings,
      audio,
    };
  }

  buildSubtitles(
    voiceTrack: VoiceTrack,
    options: CueBuildOptions & { placement?: AssPlacement } = {},
  ): SubtitleBundle {
    const cues = buildCues(voiceTrack.words, options);
    return buildSubtitleBundle(cues, options.style, options.placement);
  }
}

async function readFileOrThrow(path: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path);
}

/** Read 16-bit PCM WAV data as mono floats (channels are averaged). */
export function decodeWavMono(buffer: Buffer, channels: number): Float32Array {
  const dataStart = 44;
  const frames = Math.floor((buffer.length - dataStart) / (2 * Math.max(1, channels)));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = dataStart + (i * channels + channel) * 2;
      sum += buffer.readInt16LE(offset) / 32768;
    }
    out[i] = sum / Math.max(1, channels);
  }
  return out;
}

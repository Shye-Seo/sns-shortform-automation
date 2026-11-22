/**
 * 내장 BGM 루프 3종.
 *
 * 왜 오디오 파일 대신 생성음인가: 저장소에 음원을 넣으면 라이선스를 함께
 * 배포해야 하고, 사용자가 올린 오디오는 길이가 제각각이라 영상 길이에 맞춰
 * 자르는 일이 생긴다. 여기서는 BPM·음계·패턴만 정하고 Web Audio가 그 자리에서
 * 연주하므로, 영상 길이에 정확히 맞고 저작권 문제도 없다. 사용자가 파일을
 * 올리면 그 파일을 루프로 재생한다.
 */

export type BgmId = 'none' | 'upbeat' | 'calm' | 'lofi' | 'file';

export interface BgmLoopInfo {
  id: Exclude<BgmId, 'none' | 'file'>;
  label: string;
  bpm: number;
  description: string;
}

export const BGM_LOOPS: readonly BgmLoopInfo[] = [
  { id: 'upbeat', label: '경쾌', bpm: 120, description: '8분음표 아르페지오 · 리뷰·정보형에' },
  { id: 'calm', label: '잔잔', bpm: 76, description: '4비트 코드 패드 · 브이로그·일상에' },
  { id: 'lofi', label: '로파이', bpm: 84, description: '낮은 아르페지오 · 루틴·공부 기록에' },
];

export interface NoteEvent {
  timeSec: number;
  durationSec: number;
  /** Hz. */
  freq: number;
  gain: number;
  waveform: 'sine' | 'triangle' | 'square' | 'sawtooth';
}

export function midiToFreq(midi: number): number {
  return Math.round(440 * Math.pow(2, (midi - 69) / 12) * 100) / 100;
}

const BEAT_SEC = (bpm: number): number => 60 / bpm;

/** 짧게 끊는 아르페지오. */
function arpeggioNotes(
  bpm: number,
  bars: number,
  notes: number[],
  beatDivision: number,
  waveform: NoteEvent['waveform'],
  gain: number,
  gate = 0.7,
): NoteEvent[] {
  const beat = BEAT_SEC(bpm);
  const step = beat / beatDivision;
  const events: NoteEvent[] = [];
  const stepsPerBar = 4 * beatDivision;
  for (let bar = 0; bar < bars; bar += 1) {
    for (let stepIndex = 0; stepIndex < stepsPerBar; stepIndex += 1) {
      const midi = notes[(bar * stepsPerBar + stepIndex) % notes.length]!;
      events.push({
        timeSec: round((bar * 4 + stepIndex / beatDivision) * beat),
        durationSec: round(step * gate),
        freq: midiToFreq(midi),
        gain,
        waveform,
      });
    }
  }
  return events;
}

/** 길게 까는 코드 패드. */
function padNotes(
  bpm: number,
  bars: number,
  chords: number[][],
  waveform: NoteEvent['waveform'],
  gain: number,
): NoteEvent[] {
  const beat = BEAT_SEC(bpm);
  const events: NoteEvent[] = [];
  for (let bar = 0; bar < bars; bar += 1) {
    const chord = chords[bar % chords.length]!;
    for (const midi of chord) {
      events.push({
        timeSec: round(bar * 4 * beat),
        durationSec: round(4 * beat * 0.96),
        freq: midiToFreq(midi),
        gain,
        waveform,
      });
    }
  }
  return events;
}

/**
 * 영상 길이에 맞춘 음표 목록. 마지막 음이 영상 끝을 넘지 않도록 자른다.
 * 순수 함수라 렌더 전에 "몇 초에 몇 개의 음이 울리는지"를 테스트로 고정할 수 있다.
 */
export function notesForLoop(id: BgmId, durationSec: number): NoteEvent[] {
  const total = Math.max(0, durationSec);
  if (total <= 0 || id === 'none' || id === 'file') return [];

  const events: NoteEvent[] = [];
  if (id === 'upbeat') {
    const bpm = 120;
    const barSec = 4 * BEAT_SEC(bpm);
    const bars = Math.ceil(total / barSec);
    events.push(
      ...arpeggioNotes(bpm, bars, [72, 76, 79, 84, 79, 76, 74, 76], 2, 'triangle', 0.14, 0.55),
      ...padNotes(bpm, bars, [[48], [45], [41], [43]], 'sine', 0.12),
    );
  } else if (id === 'calm') {
    const bpm = 76;
    const barSec = 4 * BEAT_SEC(bpm);
    const bars = Math.ceil(total / barSec);
    events.push(
      ...padNotes(bpm, bars, [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65]], 'sine', 0.085),
      ...padNotes(bpm, bars, [[84], [79], [81], [83]], 'sine', 0.05),
    );
  } else if (id === 'lofi') {
    const bpm = 84;
    const barSec = 4 * BEAT_SEC(bpm);
    const bars = Math.ceil(total / barSec);
    events.push(
      ...arpeggioNotes(bpm, bars, [60, 64, 67, 70, 67, 64], 2, 'sine', 0.11, 0.85),
      ...padNotes(bpm, bars, [[36, 43], [41, 48], [38, 45], [36, 43]], 'triangle', 0.07),
    );
  }

  return events
    .filter((event) => event.timeSec < total)
    .map((event) => ({
      ...event,
      durationSec: round(Math.min(event.durationSec, total - event.timeSec)),
    }))
    .filter((event) => event.durationSec > 0.02)
    .sort((a, b) => a.timeSec - b.timeSec || a.freq - b.freq);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function bgmLabel(id: BgmId): string {
  if (id === 'none') return '없음';
  if (id === 'file') return '내 오디오';
  return BGM_LOOPS.find((loop) => loop.id === id)?.label ?? '없음';
}

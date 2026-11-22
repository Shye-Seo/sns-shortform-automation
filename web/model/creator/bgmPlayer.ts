import { notesForLoop, type BgmId } from './bgm';

/**
 * BGM 재생기 — Web Audio로 내장 루프를 연주하거나 올린 파일을 루프로 재생한다.
 *
 * 화면 미리보기와 영상 렌더가 같은 세션을 쓴다. 세션은 MediaStreamDestination을
 * 함께 만들어 두므로, 렌더할 때 이 스트림의 오디오 트랙을 캔버스 스트림에
 * 붙이기만 하면 녹화된 영상에 음악이 들어간다.
 */

export interface BgmSession {
  stream: MediaStream;
  stop: () => void;
  context: AudioContext;
}

interface AudioContextCtor {
  new (options?: AudioContextOptions): AudioContext;
}

function audioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

export function canUseAudio(): boolean {
  return audioContextCtor() !== null;
}

export interface BgmOptions {
  id: BgmId;
  durationSec: number;
  volume?: number;
  file?: File | null;
  /** 화면에서도 들리게 할지. 렌더 중에는 꺼도 된다. */
  monitor?: boolean;
}

/** 음표를 미리 예약한다. 예약만 하므로 재생 중 메인 스레드를 붙잡지 않는다. */
export async function startBgm(options: BgmOptions): Promise<BgmSession | null> {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  if (options.id === 'none') return null;
  if (options.id === 'file' && !options.file) return null;

  const context = new Ctor();
  await context.resume();

  const master = context.createGain();
  master.gain.value = Math.max(0, Math.min(1, options.volume ?? 0.55));
  const destination = context.createMediaStreamDestination();
  master.connect(destination);
  if (options.monitor !== false) master.connect(context.destination);

  const sources: AudioScheduledSourceNode[] = [];
  const startAt = context.currentTime + 0.08;

  if (options.id === 'file' && options.file) {
    const buffer = await context.decodeAudioData(await options.file.arrayBuffer());
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = context.createGain();
    gain.gain.value = 0.9;
    source.connect(gain).connect(master);
    source.start(startAt);
    source.stop(startAt + Math.max(0.2, options.durationSec));
    sources.push(source);
  } else {
    const notes = notesForLoop(options.id, options.durationSec);
    for (const note of notes) {
      const oscillator = context.createOscillator();
      oscillator.type = note.waveform;
      oscillator.frequency.value = note.freq;
      const gain = context.createGain();
      const attack = 0.012;
      const release = Math.min(0.18, note.durationSec * 0.6);
      const t0 = startAt + note.timeSec;
      const t1 = t0 + Math.max(0.03, note.durationSec);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(note.gain, t0 + attack);
      gain.gain.setValueAtTime(note.gain, Math.max(t0 + attack, t1 - release));
      gain.gain.linearRampToValueAtTime(0.0001, t1);
      oscillator.connect(gain).connect(master);
      oscillator.start(t0);
      oscillator.stop(t1 + 0.02);
      sources.push(oscillator);
    }
  }

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // 이미 끝난 소스는 무시한다.
      }
    }
    void context.close();
  };

  return { stream: destination.stream, stop, context };
}

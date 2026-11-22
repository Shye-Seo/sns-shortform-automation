import { pickRecorderMime, type RecorderContainer } from './media';

/**
 * 브라우저 100%로 숏폼 영상을 만든다.
 *
 * ffmpeg가 아니라 Canvas + MediaRecorder를 쓴다. 정적 사이트에는 서버도 ffmpeg도
 * 없고, 업로드한 사진을 서버로 보내지 않는다는 점이 이 스튜디오의 전제이기 때문이다.
 * 녹화는 실시간이다 — 12초짜리 영상은 12초 동안 캔버스를 그리며 담는다. 대신
 * 진행률을 실제 프레임에서 계산해 보여 주므로 "멈춘 것 같은" 구간이 없다.
 */

export interface RenderFrameInfo {
  sec: number;
  ratio: number;
}

export interface RenderOptions {
  canvas: HTMLCanvasElement;
  totalSec: number;
  fps: number;
  /** t초의 프레임을 캔버스에 그린다. */
  drawFrameAt: (sec: number) => RenderFrameInfo | void;
  /** BGM 스트림(있으면 오디오 트랙을 붙인다). */
  audioStream?: MediaStream | null;
  onProgress?: (ratio: number, sec: number) => void;
  videoBitsPerSecond?: number;
}

export interface RenderResult {
  blob: Blob;
  mimeType: string;
  container: RecorderContainer;
  label: string;
  durationSec: number;
  frames: number;
}

function rafQueue(): (callback: () => void) => void {
  if (typeof requestAnimationFrame === 'function') {
    return (callback) => {
      requestAnimationFrame(() => callback());
    };
  }
  return (callback) => {
    setTimeout(callback, 16);
  };
}

export async function renderVideo(options: RenderOptions): Promise<RenderResult> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('이 브라우저는 영상 녹화(MediaRecorder)를 지원하지 않습니다. Chrome·Edge·Safari 최신 버전을 써 주세요.');
  }
  if (typeof options.canvas.captureStream !== 'function') {
    throw new Error('이 브라우저는 캔버스 녹화를 지원하지 않습니다. 다른 브라우저에서 다시 시도해 주세요.');
  }

  const picked = pickRecorderMime((mimeType) => MediaRecorder.isTypeSupported(mimeType));
  const fps = Math.max(12, Math.min(60, Math.round(options.fps)));
  const totalSec = Math.max(0.5, options.totalSec);

  const stream = options.canvas.captureStream(fps);
  if (options.audioStream) {
    for (const track of options.audioStream.getAudioTracks()) stream.addTrack(track);
  }

  const recorderOptions: MediaRecorderOptions = { videoBitsPerSecond: options.videoBitsPerSecond ?? 4_000_000 };
  if (picked.mimeType !== '') recorderOptions.mimeType = picked.mimeType;

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, recorderOptions);
  } catch {
    recorder = new MediaRecorder(stream);
  }

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  // 첫 프레임을 먼저 그려야 캔버스가 비어 있는 상태로 녹화가 시작되지 않는다.
  options.drawFrameAt(0);
  recorder.start(400);
  const startedAt = performance.now();
  const next = rafQueue();
  let frames = 0;

  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const elapsed = (performance.now() - startedAt) / 1000;
      const sec = Math.min(totalSec, elapsed);
      options.drawFrameAt(sec);
      frames += 1;
      options.onProgress?.(totalSec > 0 ? sec / totalSec : 1, sec);
      if (elapsed >= totalSec) {
        resolve();
        return;
      }
      next(tick);
    };
    next(tick);
  });

  // 마지막 프레임이 인코더에 들어가도록 잠깐 기다린 뒤 멈춘다.
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (recorder.state !== 'inactive') recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();

  const mimeType = recorder.mimeType || picked.mimeType || 'video/webm';
  const blob = new Blob(chunks, { type: mimeType });
  return {
    blob,
    mimeType,
    container: mimeType.includes('mp4') ? 'mp4' : 'webm',
    label: picked.label,
    durationSec: Math.round(totalSec * 10) / 10,
    frames,
  };
}

/** 결과 파일 이름. 확장자는 실제 컨테이너를 따른다. */
export function videoFileName(baseName: string, container: RecorderContainer, now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const safe = baseName.replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'shortform';
  return `${safe}_${stamp}.${container}`;
}

/** 코덱 안내 문구 — 브라우저마다 담을 수 있는 형식이 다르다. */
export function codecNotice(isSupported: (mimeType: string) => boolean): string {
  const picked = pickRecorderMime(isSupported);
  if (picked.container === 'mp4') return `이 브라우저는 MP4(${picked.label})로 바로 저장합니다.`;
  return `이 브라우저는 WebM(${picked.label})으로 저장합니다. 인스타·쇼츠 업로드는 WebM도 받습니다.`;
}

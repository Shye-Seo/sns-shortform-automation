/**
 * 브라우저 파일 → 캔버스에 그릴 수 있는 미디어.
 *
 * 편집기와 렌더러가 같은 object URL·같은 <img>/<video> 요소를 쓰도록 여기서만
 * 파일을 연다. 원격 이미지는 fetch→blob으로 받아 object URL로 바꾼다 — 주소를
 * 그대로 <img>에 넣으면 캔버스가 오염(taint)되어 toBlob·MediaRecorder가 막힌다.
 */

export type RecorderContainer = 'mp4' | 'webm';

export interface RecorderOption {
  mimeType: string;
  container: RecorderContainer;
  label: string;
}

export const RECORDER_CANDIDATES: readonly RecorderOption[] = [
  { mimeType: 'video/mp4;codecs=avc1.42E01E', container: 'mp4', label: 'MP4 · H.264' },
  { mimeType: 'video/mp4;codecs=avc1.4D401F,mp4a.40.2', container: 'mp4', label: 'MP4 · H.264 + AAC' },
  { mimeType: 'video/mp4', container: 'mp4', label: 'MP4' },
  { mimeType: 'video/webm;codecs=vp9,opus', container: 'webm', label: 'WebM · VP9 + Opus' },
  { mimeType: 'video/webm;codecs=vp8,opus', container: 'webm', label: 'WebM · VP8 + Opus' },
  { mimeType: 'video/webm', container: 'webm', label: 'WebM' },
];

/** 브라우저가 지원하는 첫 코덱. 사파리는 MP4, 크로미움은 MP4(H.264)를 우선한다. */
export function pickRecorderMime(isSupported: (mimeType: string) => boolean): RecorderOption {
  for (const candidate of RECORDER_CANDIDATES) {
    if (isSupported(candidate.mimeType)) return candidate;
  }
  return { mimeType: '', container: 'webm', label: '브라우저 기본' };
}

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'heic', 'heif'];
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v'];

export function extensionOf(name: string): string {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? '';
}

export function fileKind(file: { type?: string; name?: string }): 'image' | 'video' | 'other' {
  const type = file.type ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  const extension = extensionOf(file.name ?? '');
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image';
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  return 'other';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export interface LoadedImage {
  url: string;
  width: number;
  height: number;
  element: HTMLImageElement;
}

export interface LoadedVideo {
  url: string;
  width: number;
  height: number;
  durationSec: number;
  element: HTMLVideoElement;
}

export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
    image.src = url;
  });
}

export async function loadImageFile(file: File): Promise<LoadedImage> {
  const url = URL.createObjectURL(file);
  try {
    const element = await loadImageFromUrl(url);
    return { url, width: element.naturalWidth || element.width, height: element.naturalHeight || element.height, element };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function loadVideoFile(file: File): Promise<LoadedVideo> {
  const url = URL.createObjectURL(file);
  const element = document.createElement('video');
  element.preload = 'auto';
  element.muted = true;
  element.loop = true;
  element.playsInline = true;
  element.setAttribute('playsinline', '');
  element.src = url;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('영상을 읽는 데 시간이 너무 걸립니다.')), 15_000);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    element.onloadedmetadata = done;
    element.onloadeddata = done;
    element.onerror = () => {
      clearTimeout(timer);
      reject(new Error('영상을 읽지 못했습니다. MP4/WebM으로 다시 시도해 주세요.'));
    };
  });

  // 일부 브라우저는 metadata 직후 duration=Infinity를 준다. 한 번 seek하면 확정된다.
  if (!Number.isFinite(element.duration) || element.duration <= 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      element.onseeked = () => {
        clearTimeout(timer);
        resolve();
      };
      element.currentTime = 0.01;
    });
  }

  const durationSec = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 3;
  return {
    url,
    width: element.videoWidth || 1080,
    height: element.videoHeight || 1920,
    durationSec,
    element,
  };
}

export type RemoteImageResult =
  | { ok: true; loaded: LoadedImage }
  | { ok: false; reason: string };

/**
 * 원격 이미지를 blob으로 받아 온다. 사진 서버가 CORS를 막으면 캔버스에 그릴 수
 * 없으므로(오염), 조용히 실패하지 않고 이유를 돌려준다.
 */
export async function loadRemoteImage(url: string): Promise<RemoteImageResult> {
  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, reason: `이미지 응답 ${response.status}` };
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const element = await loadImageFromUrl(objectUrl);
    return {
      ok: true,
      loaded: { url: objectUrl, width: element.naturalWidth, height: element.naturalHeight, element },
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.message.includes('읽지 못')
          ? '사진 형식을 읽지 못했습니다.'
          : '사진 서버가 직접 접근을 막았습니다(CORS). 파일로 올려 주세요.',
    };
  }
}

export async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), 'image/png');
  });
  if (!blob) throw new Error('PNG로 바꾸지 못했습니다.');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Uint8Array(바이트) → Blob. TS의 ArrayBufferLike와 BlobPart 사이를 여기서 정리한다. */
export function blobFromBytes(bytes: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer as ArrayBuffer], { type });
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function canUseCanvas(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext && canvas.getContext('2d'));
  } catch {
    return false;
  }
}

/**
 * 영상 컷의 현재 프레임 시각. 컷이 영상보다 길면 처음으로 돌아가 반복한다.
 * elapsedSec는 컷 안에서 흐른 시간(초)이다.
 */
export function videoFrameTime(trimStartSec: number, elapsedSec: number, videoDurationSec: number): number {
  if (!Number.isFinite(videoDurationSec) || videoDurationSec <= 0) return Math.max(0, trimStartSec);
  const absolute = Math.max(0, trimStartSec) + Math.max(0, elapsedSec);
  return absolute % videoDurationSec;
}

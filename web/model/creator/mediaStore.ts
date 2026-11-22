/**
 * 컷 id → 실제 <img>/<video> 요소.
 *
 * React state에 DOM 요소를 넣으면 다시 그릴 때마다 비교·복사가 일어나고,
 * object URL을 잃으면 캔버스가 빈 화면이 된다. 그래서 요소와 URL은 여기 보관하고
 * 화면은 "무엇이 준비됐는지"만 본다.
 */
export class MediaStore {
  private elements = new Map<string, HTMLImageElement | HTMLVideoElement>();
  private urls = new Set<string>();

  set(cutId: string, element: HTMLImageElement | HTMLVideoElement): void {
    this.elements.set(cutId, element);
  }

  get(cutId: string): HTMLImageElement | HTMLVideoElement | null {
    return this.elements.get(cutId) ?? null;
  }

  getVideo(cutId: string): HTMLVideoElement | null {
    const element = this.elements.get(cutId);
    return element instanceof HTMLVideoElement ? element : null;
  }

  getImage(cutId: string): HTMLImageElement | null {
    const element = this.elements.get(cutId);
    return element instanceof HTMLImageElement ? element : null;
  }

  /** object URL을 추적해 두었다가 한 번에 해제한다. */
  track(url: string): void {
    if (url.startsWith('blob:')) this.urls.add(url);
  }

  delete(cutId: string): void {
    const element = this.elements.get(cutId);
    if (element instanceof HTMLVideoElement) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
    this.elements.delete(cutId);
  }

  clear(): void {
    for (const cutId of [...this.elements.keys()]) this.delete(cutId);
    for (const url of this.urls) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // 이미 해제된 URL은 무시한다.
      }
    }
    this.urls.clear();
  }
}

/** 영상의 첫 프레임을 data URL로. 목록 썸네일과 카드뉴스 미리보기에 쓴다. */
export function capturePoster(video: HTMLVideoElement, width = 216): string | null {
  try {
    const ratio = video.videoHeight > 0 ? video.videoHeight / video.videoWidth : 16 / 9;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.max(1, Math.round(width * ratio));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

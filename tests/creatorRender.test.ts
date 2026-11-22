import { describe, expect, it } from 'vitest';
import {
  FRAME,
  captionMaxWidth,
  captionTopFor,
  coverFit,
  drawGuides,
  drawFrame,
  kenBurnsRect,
  layoutCaption,
  wrapLines,
  type FrameSpec,
  type Paint2D,
} from '../web/model/creator/render';
import { kenBurnsAt } from '../web/model/creator/timeline';
import { disclosureOf, makeCut } from '../web/model/creator/types';

/**
 * 렌더러 테스트.
 *
 * Canvas를 실제로 띄우지 않고 호출을 기록하는 가짜 ctx로 확인한다. 브라우저와
 * Node가 같은 함수를 쓰기 때문에, 여기서 고정한 줄바꿈·안전영역·가이드 규칙이
 * 그대로 MP4와 카드뉴스에 적용된다.
 */

class RecordingPaint implements Paint2D {
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  strokeStyle: string | CanvasGradient | CanvasPattern = '';
  lineWidth = 1;
  lineJoin: CanvasLineJoin = 'round';
  font = '700 16px sans-serif';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  globalAlpha = 1;
  texts: Array<{ text: string; x: number; y: number; font: string; alpha: number }> = [];
  rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  images: Array<{ x: number; y: number; w: number; h: number }> = [];
  gradients = 0;

  save(): void {}
  restore(): void {}
  beginPath(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  rect(): void {}
  fill(): void {}
  stroke(): void {}
  clip(): void {}
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rects.push({ x, y, w, h });
  }
  strokeRect(): void {}
  fillText(text: string, x: number, y: number): void {
    this.texts.push({ text, x, y, font: this.font, alpha: this.globalAlpha });
  }
  strokeText(): void {}
  measureText(text: string): { width: number } {
    const match = this.font.match(/([\d.]+)px/);
    const size = match ? Number(match[1]) : 16;
    return { width: text.length * size * 0.95 };
  }
  drawImage(_image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void {
    this.images.push({ x: dx, y: dy, w: dw, h: dh });
  }
  createLinearGradient(): CanvasGradient {
    this.gradients += 1;
    return { addColorStop: () => undefined } as unknown as CanvasGradient;
  }
}

function spec(overrides: Partial<FrameSpec> = {}): FrameSpec {
  const cut = overrides.cut ?? makeCut({ kind: 'placeholder', caption: '문틈 10cm를 씁니다', note: '설명' });
  return {
    cut,
    index: 0,
    total: 3,
    progress: 0.4,
    previous: null,
    transition: 1,
    media: null,
    handle: '@shye',
    badge: '주방 수납',
    disclosure: disclosureOf('none'),
    isLast: false,
    showGuides: false,
    showProgress: false,
    ...overrides,
  };
}

describe('creator render — 배치', () => {
  it('cover 배치는 9:16을 꽉 채우고 남는 쪽을 자른다', () => {
    const wide = coverFit(1600, 1200, FRAME.width, FRAME.height);
    expect(wide.height).toBeCloseTo(FRAME.height, 0);
    expect(wide.width).toBeGreaterThan(FRAME.width);
    expect(wide.dx).toBeLessThan(0);

    const tall = coverFit(1080, 1920, FRAME.width, FRAME.height);
    expect(tall.width).toBeCloseTo(FRAME.width, 0);
    expect(tall.height).toBeCloseTo(FRAME.height, 0);
    expect(tall.dx).toBeCloseTo(0, 0);
  });

  it('켄 번스 확대·이동은 가장자리에 빈 배경을 남기지 않는다', () => {
    const fit = coverFit(1600, 1200, FRAME.width, FRAME.height);
    for (const kind of ['in', 'out', 'left', 'right', 'none'] as const) {
      for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
        const rect = kenBurnsRect(fit, kenBurnsAt(kind, progress));
        expect(rect.x).toBeLessThanOrEqual(0.01);
        expect(rect.y).toBeLessThanOrEqual(0.01);
        expect(rect.x + rect.width).toBeGreaterThanOrEqual(FRAME.width - 0.01);
        expect(rect.y + rect.height).toBeGreaterThanOrEqual(FRAME.height - 0.01);
      }
    }
  });

  it('자막 줄바꿈은 누적되지 않고, 각 줄이 폭 안에 들어온다', () => {
    const measure = (line: string): number => line.length * 74 * 0.95;
    const lines = wrapLines('문틈 10cm에 냄비 뚜껑을 세워 두었더니 정리 끝', 800, measure, 3);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(800.01);
    // 두 번째 줄이 첫 줄을 다시 포함하면(누적 버그) 길이가 급증한다.
    if (lines.length > 1) expect(lines[1]!.length).toBeLessThanOrEqual(14);
  });

  it('한 단어가 폭보다 길면 글자 단위로 자른다', () => {
    const measure = (line: string): number => line.length * 50;
    const lines = wrapLines('아주아주아주아주아주긴단어입니다', 200, measure, 4);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(200);
  });

  it('줄 수를 넘기면 말줄임표를 붙인다', () => {
    const measure = (line: string): number => line.length * 74 * 0.95;
    const lines = wrapLines('가'.repeat(200), 800, measure, 2);
    expect(lines.length).toBe(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
  });

  it('긴 자막은 글자 크기를 줄여 3줄 안에 담는다', () => {
    const measure = (text: string, size: number): number => text.length * size * 0.95;
    const layout = layoutCaption(
      measure,
      '문틈 10cm에 냄비 뚜껑을 세워 두었더니 정리 끝, 이제 같은 크기 용기만 남았습니다',
      800,
      3,
    );
    expect(layout.fontSize).toBeLessThan(74);
    expect(layout.lines.length).toBeLessThanOrEqual(3);
    for (const line of layout.lines) expect(measure(line, layout.fontSize)).toBeLessThanOrEqual(800.01);
  });

  it('자막 위치는 9:16 안전영역 안에 머문다', () => {
    const height = 260;
    expect(captionTopFor('top', height)).toBeGreaterThanOrEqual(150);
    expect(captionTopFor('middle', height)).toBeGreaterThan(600);
    expect(captionTopFor('bottom', height) + height).toBeLessThanOrEqual(1500);
    expect(captionMaxWidth('bottom')).toBeLessThan(captionMaxWidth('top'));
  });
});

describe('creator render — 프레임', () => {
  it('사진이 있으면 cover 사각형으로 그리고, 없으면 자리 표시를 그린다', () => {
    const photo = new RecordingPaint();
    drawFrame(photo, spec({ media: { width: 1200, height: 1600 } as unknown as CanvasImageSource }));
    expect(photo.images).toHaveLength(1);
    expect(photo.images[0]!.w).toBeGreaterThanOrEqual(FRAME.width - 0.5);
    expect(photo.images[0]!.h).toBeGreaterThanOrEqual(FRAME.height - 0.5);

    const empty = new RecordingPaint();
    drawFrame(empty, spec());
    expect(empty.images).toHaveLength(0);
    expect(empty.texts.some((item) => item.text.includes('사진이나 영상을 올려'))).toBe(true);
  });

  it('자막·배지·핸들이 프레임에 들어간다', () => {
    const paint = new RecordingPaint();
    drawFrame(paint, spec());
    const texts = paint.texts.map((item) => item.text);
    // 자막은 폭에 맞춰 여러 줄로 나뉘어 그려진다.
    expect(texts.join(' ')).toContain('문틈 10cm를');
    expect(texts.join(' ')).toContain('씁니다');
    expect(texts).toContain('주방 수납');
    expect(texts).toContain('@shye');
    expect(texts).toContain('1 / 3');
  });

  it('마지막 컷에는 공정위 문장이 함께 그려진다', () => {
    const paint = new RecordingPaint();
    drawFrame(paint, spec({ isLast: true, disclosure: disclosureOf('sponsored') }));
    const joined = paint.texts.map((item) => item.text).join(' ');
    expect(joined).toContain('업체로부터 제품을 제공받아');
    expect(joined).toContain('#제품협찬');
  });

  it('가이드와 진행 바는 미리보기에서만 그려진다', () => {
    const preview = new RecordingPaint();
    drawFrame(preview, spec({ showGuides: true, showProgress: true }));
    const guideLabels = preview.texts.map((item) => item.text);
    expect(guideLabels).toContain('상단 바');
    expect(guideLabels).toContain('캡션·버튼 영역');
    expect(preview.rects.some((rect) => rect.w === FRAME.width && rect.h === 8)).toBe(true);

    const exportFrame = new RecordingPaint();
    drawFrame(exportFrame, spec({ showGuides: false, showProgress: false }));
    expect(exportFrame.texts.map((item) => item.text)).not.toContain('상단 바');
    expect(exportFrame.rects.some((rect) => rect.w === FRAME.width && rect.h === 8)).toBe(false);
  });

  it('안전영역 가이드는 플랫폼이 가리는 세 영역을 모두 표시한다', () => {
    const paint = new RecordingPaint();
    drawGuides(paint);
    const labels = paint.texts.map((item) => item.text);
    expect(labels).toContain('상단 바');
    expect(labels).toContain('캡션·버튼 영역');
    expect(labels).toContain('좋아요·댓글 버튼');
    expect(labels).toContain('안전 영역');
  });

  it('전환 중에는 이전 화면을 먼저 그리고 현재 컷을 겹친다', () => {
    const previous = { width: FRAME.width, height: FRAME.height } as unknown as CanvasImageSource;
    const paint = new RecordingPaint();
    drawFrame(paint, spec({ previous, transition: 0.5, index: 2, media: previous }));
    // 이전 화면 + 현재 컷 = drawImage 2회
    expect(paint.images.length).toBe(2);
  });
});

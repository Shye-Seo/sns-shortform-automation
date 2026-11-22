import type { RefObject } from 'react';
import { Button, Toggle } from '../../ui';

/**
 * 9:16 캔버스 미리보기.
 *
 * 이 화면이 곧 결과물이다 — 녹화할 때도 같은 캔버스를 그리므로 "미리보기와
 * 실제 영상이 다르다"는 일이 없다. 안전영역 가이드와 진행 바는 미리보기에만
 * 그려지고 파일에는 들어가지 않는다.
 */

export interface PreviewCardProps {
  canvasRef: RefObject<HTMLCanvasElement>;
  playing: boolean;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  t: number;
  totalSec: number;
  onSeek: (sec: number) => void;
  guides: boolean;
  onGuides: (value: boolean) => void;
  activeIndex: number;
  cutCount: number;
  rendering: boolean;
  renderRatio: number;
  canvasAvailable: boolean;
}

export function PreviewCard(props: PreviewCardProps) {
  const {
    canvasRef,
    playing,
    onTogglePlay,
    onPrev,
    onNext,
    t,
    totalSec,
    onSeek,
    guides,
    onGuides,
    activeIndex,
    cutCount,
    rendering,
    renderRatio,
    canvasAvailable,
  } = props;

  return (
    <div className="phone-wrap creator-preview">
      <div className="phone creator-phone">
        {canvasAvailable ? (
          <canvas ref={canvasRef} width={1080} height={1920} className="creator-canvas" data-testid="creator-canvas" />
        ) : (
          <div className="creator-canvas-fallback">
            이 브라우저에서는 캔버스 미리보기를 그릴 수 없습니다. Chrome·Edge·Safari 최신 버전에서 열어 주세요.
          </div>
        )}
        <span className="creator-hud">
          {t.toFixed(1)}s / {totalSec.toFixed(1)}s · 컷 {activeIndex + 1}/{Math.max(1, cutCount)}
        </span>
        {rendering ? (
          <span className="creator-rec">
            <span className="dot" /> REC {Math.round(renderRatio * 100)}%
          </span>
        ) : null}
      </div>

      <div className="controls">
        <Button small onClick={onPrev} title="이전 컷">
          ◀
        </Button>
        <Button small primary onClick={onTogglePlay} testId="creator-play">
          {playing ? '일시정지' : t >= totalSec - 0.01 ? '다시 재생' : '재생'}
        </Button>
        <Button small onClick={onNext} title="다음 컷">
          ▶
        </Button>
        <input
          className="seek"
          type="range"
          min={0}
          max={Math.max(0.1, totalSec)}
          step={0.05}
          value={Math.min(t, totalSec)}
          aria-label="재생 위치"
          onChange={(event) => onSeek(Number(event.target.value))}
          data-testid="creator-seek"
        />
      </div>

      <div className="row between creator-toggles">
        <Toggle checked={guides} onChange={onGuides} label="9:16 세이프존 가이드" />
        <span className="small muted">가이드·진행 바는 파일에 들어가지 않습니다</span>
      </div>
    </div>
  );
}

import { Button, Pill } from '../../ui';
import { formatBytes } from '../../model/creator/media';

/**
 * 4단계: 내보내기.
 *
 * 영상은 실시간으로 녹화되므로 진행률이 곧 남은 시간이다. 끝나면 파일 크기와
 * 코덱을 적고, 결과를 <video>로 바로 재생해 "진짜 영상인지" 확인하게 한다.
 * 카드뉴스는 4:5 PNG 미리보기와 ZIP을 함께 준다.
 */

export type RenderState = 'idle' | 'rendering' | 'done' | 'error';
export type CardState = 'idle' | 'working' | 'done';

export interface ExportCardProps {
  totalSec: number;
  cutCount: number;
  codecText: string | null;
  renderState: RenderState;
  renderProgress: number;
  renderError: string;
  video: { url: string; name: string; bytes: number; mime: string; label: string } | null;
  onRender: () => void;
  onDownloadVideo: () => void;
  cardState: CardState;
  cards: Array<{ name: string; url: string; bytes: number }>;
  onGenerateCards: () => void;
  onDownloadCards: () => void;
  onDownloadCard: (index: number) => void;
  caption: string;
  onCopyCaption: () => void;
  copied: boolean;
}

export function ExportCard(props: ExportCardProps) {
  const {
    totalSec,
    cutCount,
    codecText,
    renderState,
    renderProgress,
    renderError,
    video,
    onRender,
    onDownloadVideo,
    cardState,
    cards,
    onGenerateCards,
    onDownloadCards,
    onDownloadCard,
    caption,
    onCopyCaption,
    copied,
  } = props;
  const rendering = renderState === 'rendering';

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <div className="section-title">
          숏폼 영상 (9:16)
          <span className="section-note">
            {cutCount}컷 · {totalSec.toFixed(1)}초 · 실시간 녹화
          </span>
        </div>
        <div className="row between" style={{ marginBottom: 10 }}>
          <span className="small muted">{codecText ?? '코덱 확인 중…'}</span>
          <Button primary onClick={onRender} disabled={rendering || cutCount === 0} testId="creator-render">
            {rendering ? `렌더링 ${Math.round(renderProgress * 100)}%` : renderState === 'done' ? '다시 렌더링' : '영상 렌더링'}
          </Button>
        </div>

        {rendering ? (
          <div className="render-progress" role="progressbar" aria-valuenow={Math.round(renderProgress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.round(renderProgress * 100)}%` }} />
          </div>
        ) : null}

        {renderState === 'error' ? (
          <p className="notice bad" role="alert">
            {renderError}
          </p>
        ) : null}

        {video ? (
          <div className="render-result" data-testid="creator-render-result">
            <video src={video.url} className="render-video" controls playsInline preload="metadata" />
            <div className="render-meta">
              <strong>{video.name}</strong>
              <span className="small muted">
                {formatBytes(video.bytes)} · {video.mime} · {video.label}
              </span>
              <Button small onClick={onDownloadVideo}>
                다운로드
              </Button>
            </div>
          </div>
        ) : (
          <p className="note" style={{ marginBottom: 0 }}>
            브라우저가 캔버스를 그리는 동안 MediaRecorder로 담습니다. 녹화 중에는 미리보기 화면이 실제 렌더 화면이 됩니다.
          </p>
        )}
      </div>

      <div className="divider" />

      <div>
        <div className="section-title">
          인스타 카드뉴스 (4:5)
          <span className="section-note">1080 × 1350 · 컷마다 한 장</span>
        </div>
        <div className="row between" style={{ marginBottom: 10 }}>
          <span className="small muted">
            {cards.length > 0 ? `${cards.length}장 · ${formatBytes(cards.reduce((sum, card) => sum + card.bytes, 0))}` : '사진과 한 줄 카피로 카드 세트를 만듭니다'}
          </span>
          <div className="row" style={{ gap: 8 }}>
            <Button small onClick={onGenerateCards} disabled={cardState === 'working' || cutCount === 0} testId="creator-cards">
              {cardState === 'working' ? '만드는 중…' : cards.length > 0 ? '다시 만들기' : '카드뉴스 만들기'}
            </Button>
            <Button small primary onClick={onDownloadCards} disabled={cards.length === 0}>
              ZIP 다운로드
            </Button>
          </div>
        </div>

        {cards.length > 0 ? (
          <div className="card-gallery" data-testid="creator-card-gallery">
            {cards.map((card, index) => (
              <button key={card.name} type="button" className="card-item" onClick={() => onDownloadCard(index)} title={`${card.name} 내려받기`}>
                <img src={card.url} alt={`카드뉴스 ${index + 1}`} />
                <span>{formatBytes(card.bytes)}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="divider" />

      <div>
        <div className="section-title">
          게시물 캡션
          <span className="section-note">
            {caption.includes('쿠팡파트너스') || caption.includes('제공받아') || caption.includes('원고료') || caption.includes('직접 구매')
              ? '공정위 문구 포함'
              : '공정위 문구는 위에서 고르면 자동으로 들어갑니다'}
          </span>
        </div>
        <textarea className="caption-out" readOnly value={caption} rows={5} data-testid="creator-caption" />
        <div className="row between" style={{ marginTop: 8 }}>
          <span className="small muted">{caption.length}자 / 2,200자</span>
          <Button small onClick={onCopyCaption} data-testid="creator-copy-caption">
            {copied ? '복사했습니다' : '캡션 복사'}
          </Button>
        </div>
      </div>

      <div className="row between">
        <Pill tone="ok">파일은 이 브라우저에서만 만들어집니다</Pill>
        <span className="small muted">업로드·녹화·압축 모두 로컬</span>
      </div>
    </div>
  );
}

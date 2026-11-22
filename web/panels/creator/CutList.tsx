import { useState } from 'react';
import type { CreatorCut, CaptionBackground, CaptionPosition, KenBurns, Transition } from '../../model/creator/types';
import {
  CAPTION_BACKGROUND_LABEL,
  CAPTION_POSITION_LABEL,
  KEN_BURNS_LABEL,
  TRANSITION_LABEL,
} from '../../model/creator/types';
import { Button } from '../../ui';

/**
 * 2단계: 컷 편집.
 *
 * 한 줄이 컷 하나다. 순서(위/아래), 길이(초), 켄 번스, 자막 위치·배경, 전환을
 * 그 자리에서 바꾼다. 썸네일을 누르면 미리보기가 그 컷으로 이동한다.
 */

export interface CutListProps {
  cuts: CreatorCut[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onChange: (id: string, patch: Partial<CreatorCut>) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onAddBlank: () => void;
  onResetSamples: () => void;
  onClear: () => void;
}

export function CutList(props: CutListProps) {
  const { cuts, activeIndex, onSelect, onChange, onMove, onRemove, onDuplicate, onAddBlank, onResetSamples, onClear } = props;
  const [confirmClear, setConfirmClear] = useState(false);

  return (
    <div>
      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="small muted">컷 {cuts.length}개 · 위에서부터 재생 순서입니다</span>
        <div className="row" style={{ gap: 8 }}>
          <Button small ghost onClick={onResetSamples}>
            샘플로 되돌리기
          </Button>
          <Button small onClick={onAddBlank}>
            빈 컷 추가
          </Button>
          <Button
            small
            ghost
            onClick={() => {
              // 컷을 모두 지우면 되돌릴 수 없으므로 한 번 더 확인한다.
              if (confirmClear) {
                onClear();
                setConfirmClear(false);
              } else {
                setConfirmClear(true);
                setTimeout(() => setConfirmClear(false), 4000);
              }
            }}
            testId="creator-clear"
          >
            {confirmClear ? '정말 비울까요?' : '전체 비우기'}
          </Button>
        </div>
      </div>

      <div className="stack" style={{ gap: 12 }}>
        {cuts.map((cut, index) => (
          <div key={cut.id} className="cut-row" data-active={index === activeIndex} data-testid={`creator-cut-${index}`}>
            <button type="button" className="cut-thumb" onClick={() => onSelect(index)} title="이 컷으로 이동">
              {cut.kind === 'image' && cut.src !== '' ? (
                <img src={cut.src} alt="" />
              ) : cut.kind === 'video' && cut.poster ? (
                <img src={cut.poster} alt="" />
              ) : cut.kind === 'video' ? (
                <span className="cut-thumb-video">영상</span>
              ) : (
                <span style={{ background: `linear-gradient(160deg, ${cut.accent}, #0b1220)` }} />
              )}
              <span className="cut-no">{index + 1}</span>
            </button>

            <div className="cut-body">
              <div className="cut-line">
                <input
                  type="text"
                  className="cut-caption"
                  value={cut.caption}
                  placeholder="화면에 올라갈 한 줄"
                  onChange={(event) => onChange(cut.id, { caption: event.target.value })}
                  aria-label={`${index + 1}번 컷 자막`}
                />
                <label className="cut-duration">
                  <span>초</span>
                  <input
                    type="number"
                    min={0.5}
                    max={15}
                    step={0.5}
                    value={cut.durationSec}
                    onChange={(event) => onChange(cut.id, { durationSec: Number(event.target.value) })}
                    aria-label={`${index + 1}번 컷 길이`}
                  />
                </label>
                <div className="cut-actions">
                  <button type="button" onClick={() => onMove(index, -1)} disabled={index === 0} title="위로">
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(index, 1)}
                    disabled={index === cuts.length - 1}
                    title="아래로"
                  >
                    ↓
                  </button>
                  <button type="button" onClick={() => onDuplicate(cut.id)} title="복제">
                    ⧉
                  </button>
                  <button type="button" className="danger" onClick={() => onRemove(cut.id)} title="삭제">
                    ✕
                  </button>
                </div>
              </div>

              <input
                type="text"
                className="cut-note"
                value={cut.note}
                placeholder="카드뉴스 본문·설명 (선택)"
                onChange={(event) => onChange(cut.id, { note: event.target.value })}
                aria-label={`${index + 1}번 컷 설명`}
              />

              <div className="cut-options">
                <label>
                  <span>길이 효과</span>
                  <select
                    value={cut.kenBurns}
                    onChange={(event) => onChange(cut.id, { kenBurns: event.target.value as KenBurns })}
                    disabled={cut.kind === 'video'}
                  >
                    {(Object.keys(KEN_BURNS_LABEL) as KenBurns[]).map((key) => (
                      <option key={key} value={key}>
                        {KEN_BURNS_LABEL[key]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>자막 위치</span>
                  <select
                    value={cut.captionPosition}
                    onChange={(event) => onChange(cut.id, { captionPosition: event.target.value as CaptionPosition })}
                  >
                    {(Object.keys(CAPTION_POSITION_LABEL) as CaptionPosition[]).map((key) => (
                      <option key={key} value={key}>
                        {CAPTION_POSITION_LABEL[key]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>자막 배경</span>
                  <select
                    value={cut.captionBackground}
                    onChange={(event) => onChange(cut.id, { captionBackground: event.target.value as CaptionBackground })}
                  >
                    {(Object.keys(CAPTION_BACKGROUND_LABEL) as CaptionBackground[]).map((key) => (
                      <option key={key} value={key}>
                        {CAPTION_BACKGROUND_LABEL[key]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>전환</span>
                  <select
                    value={cut.transition}
                    onChange={(event) => onChange(cut.id, { transition: event.target.value as Transition })}
                  >
                    {(Object.keys(TRANSITION_LABEL) as Transition[]).map((key) => (
                      <option key={key} value={key}>
                        {TRANSITION_LABEL[key]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          </div>
        ))}

        {cuts.length === 0 ? (
          <p className="note" style={{ margin: 0 }}>
            컷이 없습니다. 위에서 사진·영상을 올리거나 &lsquo;빈 컷 추가&rsquo;로 시작하세요.
          </p>
        ) : null}
      </div>
    </div>
  );
}

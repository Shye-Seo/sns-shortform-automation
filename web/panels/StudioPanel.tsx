import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { wrapCueWords } from '../../src/services/audioEngine';
import type { SceneDraft } from '../../src/services/scriptEngine';
import { PLATFORM_UI_ZONES } from '../../src/services/videoCompositor';
import type { Cue, WordTiming } from '../../src/types/audio';
import { CANVAS } from '../../src/types/render';
import type { Language } from '../../src/types/script';
import { Button, Card, Kpi, Pill, Toggle, clock, pct, sec } from '../ui';
import { BEAT_HINT, BEAT_LABEL, buildStudioModel, cueAt, draftBeatScene, gainAt, sceneAt, type StudioModel } from '../model/studio';

const FONT_CQW = (px: number): string => `${((px / CANVAS.width) * 100).toFixed(3)}cqw`;
const pctX = (value: number): string => `${((value / CANVAS.width) * 100).toFixed(3)}%`;
const pctY = (value: number): string => `${((value / CANVAS.height) * 100).toFixed(3)}%`;

export interface StudioPanelProps {
  topic: string;
  onTopic: (value: string) => void;
  durationSec: number;
  onDuration: (value: number) => void;
  speed: number;
  onSpeed: (value: number) => void;
  drafts: SceneDraft[];
  onDrafts: (drafts: SceneDraft[]) => void;
  compress: boolean;
  onCompress: (value: boolean) => void;
  language: Language;
}

export function StudioPanel(props: StudioPanelProps) {
  const { topic, onTopic, durationSec, onDuration, speed, onSpeed, drafts, onDrafts, compress, onCompress } = props;
  const [safeArea, setSafeArea] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const tRef = useRef(0);

  const model = useMemo(
    () => buildStudioModel({ topic, durationSec, speed, language: 'ko', drafts, compress }),
    [topic, durationSec, speed, drafts, compress],
  );

  const setPlayhead = (value: number): void => {
    const clamped = Math.max(0, Math.min(model.totalDurationSec, value));
    tRef.current = clamped;
    setT(clamped);
  };

  useEffect(() => {
    if (!playing) return undefined;
    let raf = 0;
    let last = performance.now();
    const step = (now: number): void => {
      const dt = (now - last) / 1000;
      last = now;
      const next = tRef.current + dt;
      if (next >= model.totalDurationSec) {
        tRef.current = model.totalDurationSec;
        setT(model.totalDurationSec);
        setPlaying(false);
        return;
      }
      tRef.current = next;
      setT(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, model.totalDurationSec]);

  const resetKey = `${model.totalDurationSec}|${model.cues.length}|${model.scenes.length}`;
  const lastReset = useRef(resetKey);
  useEffect(() => {
    if (lastReset.current === resetKey) return;
    lastReset.current = resetKey;
    setPlaying(false);
    tRef.current = 0;
    setT(0);
  }, [resetKey]);

  const cue = cueAt(model, t);
  const scene = sceneAt(model, t);
  const gain = gainAt(model, t);
  const ducked = gain < 0.3;

  const updateScene = (index: number, narration: string): void => {
    onDrafts(drafts.map((draft, i) => (i === index ? { ...draft, narration } : draft)));
  };

  return (
    <div className="grid sidebar">
      <div className="stack">
        <Card eyebrow="9:16 프리뷰" title="렌더 결과 미리보기" hint="엔진의 타임라인·자막·더킹 값을 그대로 그립니다">
          <div className="phone-wrap">
            <div className="phone" style={{ containerType: 'inline-size' } as CSSProperties}>
              <div className="bg" />
              <div className="hud">{`${t.toFixed(1)}s / ${model.totalDurationSec.toFixed(1)}s`}</div>

              {safeArea ? (
                <div className="zones">
                  {PLATFORM_UI_ZONES['instagram-reels'].map((zone) => (
                    <div
                      key={zone.name}
                      className="zone"
                      style={{
                        left: pctX(zone.rect.x),
                        top: pctY(zone.rect.y),
                        width: pctX(zone.rect.w),
                        height: pctY(zone.rect.h),
                      }}
                    >
                      {zone.name}
                    </div>
                  ))}
                  <div
                    className="content-box"
                    style={{
                      left: pctX(model.layout.contentBox.x),
                      top: pctY(model.layout.contentBox.y),
                      width: pctX(model.layout.contentBox.w),
                      height: pctY(model.layout.contentBox.h),
                    }}
                  />
                </div>
              ) : null}

              {model.layout.badge ? (
                <div
                  className="badge"
                  style={{
                    left: pctX(model.layout.badge.x),
                    top: pctY(model.layout.badge.y),
                    fontSize: FONT_CQW(34),
                  }}
                >
                  KITCHEN 3평
                </div>
              ) : null}

              {scene ? (
                <div className="chapter" style={{ left: pctX(model.layout.contentBox.x), top: pctY(210) }}>
                  {BEAT_LABEL[scene.beat]} · {scene.index + 1}/{model.scenes.length}
                </div>
              ) : null}

              <Caption cue={cue} model={model} t={t} />

              <div
                className="progress"
                style={{
                  left: pctX(model.layout.progress.x),
                  top: pctY(model.layout.progress.y),
                  width: pctX(model.layout.progress.w),
                  height: pctY(model.layout.progress.h),
                }}
              >
                <span style={{ width: `${model.totalDurationSec > 0 ? (t / model.totalDurationSec) * 100 : 0}%` }} />
              </div>

              <div className="duck">
                <span className="dot" style={{ background: ducked ? '#ffd166' : '#7ce0b4' }} />
                BGM {Math.round(gain * 100)}% {ducked ? '· 발화 중' : '· 쉼'}
              </div>
            </div>

            <div className="controls">
              <Button onClick={() => setPlaying((value) => !value)} primary small>
                {playing ? '일시정지' : t >= model.totalDurationSec - 0.01 ? '다시 재생' : '재생'}
              </Button>
              <input
                className="seek"
                type="range"
                min={0}
                max={model.totalDurationSec}
                step={0.05}
                value={t}
                onChange={(event) => setPlayhead(Number(event.target.value))}
                aria-label="재생 위치"
              />
              <span className="mono small muted">{clock(t * 1000)}</span>
            </div>
            <Toggle checked={safeArea} onChange={setSafeArea} label="9:16 안전영역 가이드" />
          </div>
        </Card>

        <Card title="오디오 더킹" hint="발화 구간 BGM 15%, 쉼 55% — 어택·릴리즈 램프까지 엔진 값">
          <EnvelopeChart model={model} t={t} />
          <div className="row between" style={{ marginTop: 8 }}>
            <span className="small muted">
              발화 비중 <strong className="mono">{pct(model.envelope.duckedRatio * 100, 0)}</strong> · 구간{' '}
              {model.envelope.mergedVoiceSegments}개(병합 전 {model.envelope.rawVoiceSegments}개)
            </span>
            <span className={ducked ? 'pill warn' : 'pill ok'}>{`${Math.round(gain * 100)}%`}</span>
          </div>
        </Card>
      </div>

      <div className="stack">
        <div className="grid kpi">
          <Kpi label="목표 길이" value={sec(durationSec)} sub={`발화 예산 ${(durationSec - 0.3).toFixed(1)}s`} />
          <Kpi
            label="타임라인 합계"
            value={sec(model.totalDurationSec)}
            sub={`발화 ${sec(model.speechSec)} · 여백 ${sec(model.pauseSec)}`}
            tone={model.overrunSec > 0.01 ? 'bad' : undefined}
          />
          <Kpi
            label="훅 길이"
            value={sec(model.scenes[0]?.durationSec ?? 0)}
            sub="3.5초 상한"
            tone={(model.scenes[0]?.durationSec ?? 0) > 3.5 ? 'bad' : 'ok'}
          />
          <Kpi
            label="자막 카드"
            value={`${model.cues.length}장`}
            sub={`가장 긴 줄 ${model.widestCueWidthPx}px / 박스 ${Math.round(model.layout.caption.w)}px`}
            tone={model.widestCueWidthPx > model.layout.caption.w ? 'warn' : undefined}
          />
        </div>

        <Card
          title="4비트 대본"
          hint="훅 → 문제 → 해결 → CTA. 문장을 고치면 아래 타임라인이 즉시 다시 계산됩니다."
          actions={
            <Button small onClick={() => onDrafts(draftBeatScene(topic, durationSec))} title="엔진 휴리스틱으로 대본을 다시 뽑습니다">
              대본 다시 생성
            </Button>
          }
        >
          <div className="row" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '2 1 240px' }}>
              <span>주제</span>
              <input type="text" value={topic} onChange={(event) => onTopic(event.target.value)} />
            </div>
            <div className="field" style={{ flex: '0 0 104px' }}>
              <span>길이</span>
              <select value={durationSec} onChange={(event) => onDuration(Number(event.target.value))}>
                {[30, 45, 60].map((value) => (
                  <option key={value} value={value}>
                    {value}초
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: '0 0 124px' }}>
              <span>발화 속도 {speed.toFixed(2)}x</span>
              <input
                className="seek"
                type="range"
                min={0.8}
                max={1.3}
                step={0.05}
                value={speed}
                onChange={(event) => onSpeed(Number(event.target.value))}
                aria-label="발화 속도"
              />
            </div>
            <Toggle checked={compress} onChange={onCompress} label="예산 초과 시 압축" />
          </div>

          {model.compression.applied ? (
            <p className="note" style={{ marginBottom: 10 }}>
              <strong>압축 {model.compression.passes.length}회 적용</strong> — 요청 {sec(model.compression.requestedSec)} →{' '}
              {sec(model.compression.requestedSec - model.compression.savedSec)} (한도 {sec(model.compression.capacitySec)}).
              삭제 유형: {model.compression.passes.slice(0, 3).map((pass) => pass.pass).join(' · ')}
              {model.compression.passes.length > 3 ? ' …' : ''}
            </p>
          ) : null}
          {model.overrunSec > 0.01 ? (
            <p className="note" style={{ marginBottom: 10 }}>
              <strong>예산 초과 {sec(model.overrunSec)}</strong> — 압축을 켜거나 문장을 줄여야 렌더가 60초 상한을 넘지 않습니다.
            </p>
          ) : null}

          <div className="stack" style={{ gap: 10 }}>
            {model.scenes.map((item, index) => {
              const draft = drafts[index];
              if (!draft) return null;
              const over = item.beat === 'hook' && item.durationSec > 3.5;
              return (
                <div
                  key={item.id}
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    padding: 12,
                    background: scene?.id === item.id ? '#fbfcfe' : '#fff',
                    borderColor: scene?.id === item.id ? '#c9d7e8' : 'var(--line)',
                  }}
                >
                  <div className="row between" style={{ marginBottom: 6 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span
                        className={`pill ${
                          item.beat === 'hook' ? 'warn' : item.beat === 'cta' ? 'bad' : item.beat === 'problem' ? 'ghost' : 'ok'
                        }`}
                      >
                        {BEAT_LABEL[item.beat]}
                      </span>
                      <span className="small muted">{BEAT_HINT[item.beat]}</span>
                    </div>
                    <span className="small muted mono">
                      {item.startSec.toFixed(2)}–{(item.startSec + item.durationSec).toFixed(2)}s · {item.syllables}음절
                    </span>
                  </div>
                  <textarea
                    rows={2}
                    value={draft.narration}
                    onChange={(event) => updateScene(index, event.target.value)}
                    style={{ borderColor: over ? 'var(--bad)' : undefined }}
                  />
                  <div className="row between" style={{ marginTop: 5 }}>
                    <span className="small muted">
                      화면 자막 <span className="mono">{item.onScreenText ?? '-'}</span>
                    </span>
                    <span className={over ? 'pill bad' : 'pill ghost'}>
                      {item.beat === 'hook'
                        ? `${item.durationSec.toFixed(2)}s · 상한 3.50s`
                        : `${item.durationSec.toFixed(2)}s · 예산 ${(budgetShare(item.beat, model)).toFixed(1)}s`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="타임라인" hint="비트 순서와 길이는 타임라인 빌더가 정합니다">
          <BeatStrip model={model} t={t} onSeek={setPlayhead} />
          {durationSec - model.totalDurationSec > 0.5 ? (
            <p className="note" style={{ marginTop: 10 }}>
              남는 {(durationSec - model.totalDurationSec).toFixed(1)}초는 쓰지 않습니다. 홀드 시간은 씬당 0.6초로 막혀 있어서,
              늘어난 시간을 프레임 정지로 채우는 대신 짧게 끝냅니다.
            </p>
          ) : null}
          <div className="scroll" style={{ marginTop: 10 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>비트</th>
                  <th className="num">시작</th>
                  <th className="num">길이</th>
                  <th className="num">발화</th>
                  <th className="num">단어</th>
                  <th>화면 텍스트</th>
                </tr>
              </thead>
              <tbody>
                {model.scenes.map((item) => (
                  <tr key={item.id}>
                    <td>{item.index + 1}</td>
                    <td>{BEAT_LABEL[item.beat]}</td>
                    <td className="num">{item.startSec.toFixed(2)}s</td>
                    <td className="num">{item.durationSec.toFixed(2)}s</td>
                    <td className="num">{item.estimatedSpeechSec.toFixed(2)}s</td>
                    <td className="num">{model.words.filter((word) => word.sceneId === item.id).length}</td>
                    <td>{item.onScreenText ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="grid two">
          <Card title="키네틱 자막" hint="읽기 속도 22자/초, 최대 2줄 — 엔진의 큐 분할 결과">
            <div className="scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th className="num">구간</th>
                    <th>카드</th>
                  </tr>
                </thead>
                <tbody>
                  {model.cues.map((item) => (
                    <tr key={item.index} style={{ background: cue?.index === item.index ? '#f4f8fd' : undefined }}>
                      <td>{item.index}</td>
                      <td className="num mono">
                        {item.startSec.toFixed(2)}–{item.endSec.toFixed(2)}
                      </td>
                      <td>{item.lines.join(' / ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="안전영역 검증" hint="플랫폼 UI(상단 바·캡션 시트·액션 레일)와의 충돌 검사">
            <div className="row" style={{ marginBottom: 10 }}>
              <Pill tone={model.collisions.ok ? 'ok' : 'bad'}>
                {model.collisions.ok ? '충돌 없음' : `충돌 ${model.collisions.violations.length}건`}
              </Pill>
              <span className="small muted">
                콘텐츠 박스 {Math.round(model.layout.contentBox.w)}×{Math.round(model.layout.contentBox.h)}px
              </span>
            </div>
            <div className="bars">
              {[
                { name: '자막', rect: model.layout.caption },
                { name: '프로그레스', rect: model.layout.progress },
                { name: '뱃지', rect: model.layout.badge },
                { name: '워터마크', rect: model.layout.watermark },
              ].map((item) =>
                item.rect ? (
                  <div key={item.name} className="bar-line">
                    <span className="muted">{item.name}</span>
                    <span className="meter ok">
                      <span style={{ width: `${Math.min(100, (item.rect.w / CANVAS.width) * 100)}%` }} />
                    </span>
                    <span className="num">
                      y {Math.round(item.rect.y)} · {Math.round(item.rect.h)}px
                    </span>
                  </div>
                ) : null,
              )}
            </div>
            {model.collisions.violations.length > 0 ? (
              <ul className="small" style={{ margin: '10px 0 0 16px', padding: 0, color: 'var(--bad)' }}>
                {model.collisions.violations.map((violation, index) => (
                  <li key={`${violation.layer}-${index}`}>
                    {violation.layer} × {violation.zone} ({violation.overlapPx}px²)
                  </li>
                ))}
              </ul>
            ) : (
              <p className="note" style={{ marginTop: 10, marginBottom: 0 }}>
                모든 오버레이가 1080×1920 캔버스의 콘텐츠 박스 안에 있습니다. 가이드를 끄면 실제 영상처럼 보입니다.
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/** Per-beat speech budget from the engine's time-budget planner. */
function budgetShare(beat: 'hook' | 'problem' | 'solution' | 'cta', model: StudioModel): number {
  return model.budget.perBeatSec[beat];
}

function Caption({ cue, model, t }: { cue: Cue | null; model: StudioModel; t: number }) {
  if (!cue) return null;
  const fontSize = model.layout.subtitleStyle.fontSizePx;
  const wrapped = wrapCueWords(cue.words, model.layout.caption.w, fontSize, 2);
  const lines: WordTiming[][] = [[], []];

  cue.words.forEach((word, index) => {
    const lineIndex = Math.max(0, Math.min(1, wrapped.wordLine[index] ?? 0));
    (lines[lineIndex] as WordTiming[]).push(word);
  });

  return (
    <div
      className="caption"
      style={{
        left: pctX(model.layout.caption.x),
        top: pctY(model.layout.caption.y),
        width: pctX(model.layout.caption.w),
        height: pctY(model.layout.caption.h),
        fontSize: FONT_CQW(fontSize),
      }}
    >
      {lines
        .filter((line) => line.length > 0)
        .map((line, lineIndex) => (
          <div key={lineIndex} style={{ display: 'flex', gap: '0.3em', justifyContent: 'center' }}>
            {line.map((word) => {
              const active = t >= word.startSec && t < word.endSec;
              const spoken = word.endSec <= t;
              return (
                <span key={`${word.index}-${word.text}`} className={active ? 'w active' : spoken ? 'w spoken' : 'w'}>
                  {word.text}
                </span>
              );
            })}
          </div>
        ))}
    </div>
  );
}

function EnvelopeChart({ model, t }: { model: StudioModel; t: number }) {
  const duration = Math.max(0.001, model.totalDurationSec);
  const points = model.envelope.keyframes
    .map((key) => `${((key.tSec / duration) * 100).toFixed(2)},${((1 - key.gain) * 100).toFixed(2)}`)
    .join(' ');
  const playheadX = (t / duration) * 100;

  return (
    <svg className="envelope" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="BGM 게인 곡선">
      <defs>
        <linearGradient id="envFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2f6fa8" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#2f6fa8" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <line x1="0" y1={15} x2="100" y2={15} stroke="#e6ebf2" strokeWidth="0.4" />
      <line x1="0" y1={85} x2="100" y2={85} stroke="#e6ebf2" strokeWidth="0.4" />
      <polygon points={`0,100 ${points} 100,100`} fill="url(#envFill)" />
      <polyline points={points} fill="none" stroke="#2f6fa8" strokeWidth="1.1" vectorEffect="non-scaling-stroke" />
      <line x1={playheadX} y1="0" x2={playheadX} y2="100" stroke="#b03a3a" strokeWidth="0.7" vectorEffect="non-scaling-stroke" />
      <text x="1.5" y="12" fontSize="5" fill="#8b98a8">
        55%
      </text>
      <text x="1.5" y="98" fontSize="5" fill="#8b98a8">
        15%
      </text>
    </svg>
  );
}

function BeatStrip({ model, t, onSeek }: { model: StudioModel; t: number; onSeek: (value: number) => void }) {
  const active = sceneAt(model, t);
  return (
    <div className="beat-strip">
      {model.scenes.map((scene) => (
        <button
          key={scene.id}
          type="button"
          className={`beat-block ${scene.beat}`}
          data-active={active?.id === scene.id}
          style={{ flexGrow: Math.max(1, scene.durationSec) }}
          onClick={() => onSeek(scene.startSec + 0.01)}
          title={`${BEAT_LABEL[scene.beat]} · ${scene.durationSec.toFixed(2)}s`}
        >
          {BEAT_LABEL[scene.beat]} {scene.durationSec.toFixed(1)}s
        </button>
      ))}
    </div>
  );
}

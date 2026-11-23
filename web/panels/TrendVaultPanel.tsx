import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Button, Card, Kpi, Pill } from '../ui';
import { HOOK_PATTERN_LABEL, PLAN_GOAL_LABEL, type BorrowedStructure, type TrendItem } from '../../src/services/sonder/types';
import { viralVerdict } from '../../src/services/sonder/viral';
import type { SonderMode, SonderStore } from '../model/sonder/repo';
import { RatioBar, count, sec } from './sonder/BeatBars';

/**
 * 트렌드 보관함 — 참고 영상이 평소보다 몇 배 터졌는지 재고, 그 영상이 쓴 구조를
 * 남긴다. 배수는 조회수 ÷ 그 계정의 평소 조회수 중간값이다.
 */

interface FormState {
  url: string;
  title: string;
  transcript: string;
  views: string;
  medianViews: string;
  durationSec: string;
  note: string;
}

const EMPTY: FormState = {
  url: '',
  title: '',
  transcript: '',
  views: '',
  medianViews: '',
  durationSec: '',
  note: '',
};

const toNumber = (value: string): number => {
  const parsed = Number(value.replace(/[, ]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const LEVEL_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'ghost'> = {
  viral: 'ok',
  above: 'ok',
  near: 'ghost',
  below: 'bad',
  unknown: 'ghost',
};

const BASIS_LABEL: Record<string, string> = {
  title: '제목',
  transcript: '자막',
  duration: '길이',
};

export interface TrendVaultPanelProps {
  store: SonderStore | null;
  mode: SonderMode;
  onUseTrend: (item: TrendItem) => void;
}

export function TrendVaultPanel({ store, mode, onUseTrend }: TrendVaultPanelProps) {
  const [items, setItems] = useState<TrendItem[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [structure, setStructure] = useState<BorrowedStructure | null>(null);
  const [analyzedTitle, setAnalyzedTitle] = useState('');
  const [busy, setBusy] = useState<'analyze' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = async (): Promise<void> => {
    if (!store) return;
    try {
      setItems(await store.listTrends());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '보관함을 불러오지 못했습니다');
    }
  };

  useEffect(() => {
    if (!store) return;
    let alive = true;
    store
      .listTrends()
      .then((next) => {
        if (alive) setItems(next);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : '보관함을 불러오지 못했습니다');
      });
    return () => {
      alive = false;
    };
  }, [store]);

  const verdict = useMemo(() => viralVerdict(toNumber(form.views), toNumber(form.medianViews)), [form.views, form.medianViews]);
  const viralCount = items.filter((item) => item.level === 'viral').length;
  const withMultiplier = items.filter((item) => typeof item.multiplier === 'number');
  const avgMultiplier =
    withMultiplier.length > 0
      ? withMultiplier.reduce((sum, item) => sum + (item.multiplier as number), 0) / withMultiplier.length
      : null;
  const topPattern = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.structure.hookPattern, (counts.get(item.structure.hookPattern) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] as keyof typeof HOOK_PATTERN_LABEL | undefined;
  }, [items]);

  const update = (key: keyof FormState) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
    setStructure(null);
    setNotice('');
    setError('');
  };

  const analyze = async (): Promise<void> => {
    if (!store) return;
    setBusy('analyze');
    setError('');
    setNotice('');
    try {
      const result = await store.analyze({
        url: form.url,
        title: form.title || undefined,
        transcript: form.transcript || undefined,
        durationSec: toNumber(form.durationSec) || undefined,
      });
      setStructure(result.structure);
      setAnalyzedTitle(result.title);
      if (!form.title && result.title) setForm((prev) => ({ ...prev, title: result.title }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '구조를 읽지 못했습니다');
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    if (!store) return;
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const item = await store.addTrend({
        url: form.url,
        title: form.title,
        transcript: form.transcript,
        views: toNumber(form.views),
        medianViews: toNumber(form.medianViews),
        durationSec: toNumber(form.durationSec) || undefined,
        note: form.note,
      });
      setStructure(item.structure);
      setAnalyzedTitle(item.title);
      setForm((prev) => ({ ...prev, title: item.title, url: form.url }));
      await refresh();
      setNotice(
        `보관함에 저장했습니다. ${item.multiplier ? `평소의 ${item.multiplier.toFixed(1)}배` : '배수는 중간값을 넣으면 계산됩니다'}.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '저장하지 못했습니다');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string): Promise<void> => {
    if (!store) return;
    try {
      await store.removeTrend(id);
      await refresh();
      setNotice('보관함에서 지웠습니다.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '지우지 못했습니다');
    }
  };

  return (
    <div className="stack">
      <div className="grid kpi">
        <Kpi label="보관한 참고 영상" value={`${items.length}건`} sub={mode === 'cloud' ? '클라우드 저장' : '이 브라우저 저장'} />
        <Kpi label="바이럴 신호" value={`${viralCount}건`} sub="평소의 3배 이상" tone={viralCount > 0 ? 'ok' : undefined} />
        <Kpi label="평균 배수" value={avgMultiplier ? `${avgMultiplier.toFixed(2)}배` : '—'} sub="배수를 계산한 항목만" />
        <Kpi
          label="가장 많이 빌린 훅"
          value={topPattern ? HOOK_PATTERN_LABEL[topPattern] : '—'}
          sub={items.length > 0 ? `${items.length}건 기준` : '아직 비어 있습니다'}
        />
      </div>

      <div className="grid sidebar">
        <Card
          eyebrow="참고 영상"
          title="넣기"
          hint="링크·제목·자막 중 있는 것만 넣어도 됩니다. 자막이 있으면 박자까지 읽습니다."
        >
          <div className="form-block">
            <label className="field">
              <span>영상 링크</span>
              <input type="text" value={form.url} onChange={update('url')} placeholder="https://www.youtube.com/shorts/…" />
            </label>
            <label className="field">
              <span>제목</span>
              <input type="text" value={form.title} onChange={update('title')} placeholder="3평 주방 수납, 문 안쪽 10cm" />
            </label>
            <label className="field">
              <span>자막·대본 (붙여넣기)</span>
              <textarea
                value={form.transcript}
                onChange={update('transcript')}
                rows={5}
                placeholder={'한 줄에 한 문장씩 붙여넣으면 박자를 나눕니다.\n3평 주방에서 매번 냄비를 꺼내다 부딪혔습니다.'}
              />
            </label>
            <div className="field-row">
              <label className="field">
                <span>이 영상 조회수</span>
                <input type="text" inputMode="numeric" value={form.views} onChange={update('views')} placeholder="82000" />
              </label>
              <label className="field">
                <span>그 계정 평소 조회수 중간값</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.medianViews}
                  onChange={update('medianViews')}
                  placeholder="19000"
                />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>영상 길이(초)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.durationSec}
                  onChange={update('durationSec')}
                  placeholder="32"
                />
              </label>
              <label className="field">
                <span>메모</span>
                <input type="text" value={form.note} onChange={update('note')} placeholder="훅이 세게 들어옴" />
              </label>
            </div>

            <div className={verdict.level === 'viral' ? 'multiplier-box viral' : 'multiplier-box'}>
              <div className="row between">
                <span className="small muted">배수</span>
                <Pill tone={LEVEL_TONE[verdict.level]}>{verdict.label}</Pill>
              </div>
              <div className="value mono" data-testid="multiplier">
                {verdict.multiplier === null ? '—' : `${verdict.multiplier.toFixed(2)}배`}
              </div>
              <p className="small muted" style={{ margin: 0 }}>
                {verdict.note}
              </p>
            </div>

            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Button primary onClick={() => void save()} disabled={busy !== null || !store}>
                {busy === 'save' ? '저장 중…' : '보관함에 저장'}
              </Button>
              <Button onClick={() => void analyze()} disabled={busy !== null || !store}>
                {busy === 'analyze' ? '읽는 중…' : '구조만 읽어보기'}
              </Button>
            </div>
            {error ? <p className="notice bad">{error}</p> : null}
            {notice ? <p className="notice ok">{notice}</p> : null}
          </div>
        </Card>

        <Card
          eyebrow="빌린 구조"
          title={structure ? analyzedTitle || '읽은 구조' : '아직 읽지 않았습니다'}
          hint="베끼는 것은 문장이 아니라 순서입니다. 첫 문장·전환 시점·마무리를 숫자로 남깁니다."
          actions={structure ? <Pill tone="ok">{HOOK_PATTERN_LABEL[structure.hookPattern]}</Pill> : null}
        >
          {structure ? (
            <div className="stack" style={{ gap: 16 }}>
              <div className="meta-line">
                <span className="meta-item">{sec(structure.durationSec)}</span>
                <span className="sep" aria-hidden="true" />
                <span className="meta-item">초당 {structure.pace}음절</span>
                <span className="sep" aria-hidden="true" />
                <span className="meta-item">
                  {structure.basis.map((basis) => BASIS_LABEL[basis] ?? basis).join(' · ') || '제목'}으로 계산
                </span>
              </div>

              <div>
                <p className="eyebrow">첫 문장</p>
                <p className="quote">{structure.hookLine}</p>
              </div>

              <div className="bar-stack">
                {structure.beats.map((beat) => (
                  <RatioBar
                    key={beat.beat}
                    label={beat.label}
                    ratio={beat.ratio}
                    readout={`${sec(beat.startSec)}–${sec(beat.endSec)}`}
                    tone={beat.beat === 'hook' ? 'ok' : undefined}
                  />
                ))}
              </div>

              <div className="meta-line">
                <span className="small muted">전환 시점</span>
                {structure.transitions.map((at, index) => (
                  <span key={index} className="meta-item mono">
                    {sec(at)}
                  </span>
                ))}
              </div>

              <div>
                <p className="eyebrow">마무리</p>
                <p style={{ margin: 0, fontSize: 15 }}>
                  {structure.cta || '읽지 못했습니다'}
                  {structure.goal ? <span className="small muted"> — {PLAN_GOAL_LABEL[structure.goal]} 요구</span> : null}
                </p>
              </div>

              <ul className="evidence">
                {structure.signals.map((signal, index) => (
                  <li key={index}>{signal}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              왼쪽에 제목이나 자막을 넣고 <strong>구조만 읽어보기</strong>를 누르면, 첫 문장 패턴과 네 박자의 시간이
              여기에 나옵니다. 저장하면 이 구조가 기획안의 재료가 됩니다.
            </p>
          )}
        </Card>
      </div>

      <Card
        title="보관함"
        hint="3배 이상은 초록으로 표시합니다. 구조를 기획안으로 바로 넘길 수 있습니다."
        actions={<span className="small muted">{items.length}건</span>}
      >
        {items.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>
            아직 저장한 참고 영상이 없습니다. 첫 영상을 넣고 배수를 계산해 보세요.
          </p>
        ) : (
          <div className="scroll" style={{ maxHeight: 'none' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>참고 영상</th>
                  <th className="num">조회수</th>
                  <th className="num">평소 중간값</th>
                  <th className="num">배수</th>
                  <th>판정</th>
                  <th>훅</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.title}</strong>
                      <div className="small muted">
                        {item.url ? (
                          <a href={item.url} target="_blank" rel="noreferrer noopener">
                            원본 열기
                          </a>
                        ) : (
                          '링크 없음'
                        )}
                        {item.note ? ` · ${item.note}` : ''}
                      </div>
                    </td>
                    <td className="num">{count(item.views)}</td>
                    <td className="num">{count(item.medianViews)}</td>
                    <td className="num">{item.multiplier === null ? '—' : `${item.multiplier.toFixed(2)}배`}</td>
                    <td>
                      <Pill tone={LEVEL_TONE[item.level]}>{item.level === 'viral' ? '바이럴' : item.level === 'above' ? '높음' : item.level === 'near' ? '평소' : item.level === 'below' ? '낮음' : '계산 전'}</Pill>
                    </td>
                    <td className="small">{HOOK_PATTERN_LABEL[item.structure.hookPattern]}</td>
                    <td>
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        <Button small primary onClick={() => onUseTrend(item)}>
                          기획안으로
                        </Button>
                        <Button small ghost onClick={() => void remove(item.id)}>
                          삭제
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

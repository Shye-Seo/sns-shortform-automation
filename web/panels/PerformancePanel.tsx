import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Button, Card, Kpi, Pill } from '../ui';
import { summarizeLogs } from '../../src/services/sonder/performance';
import {
  HOOK_PATTERN_LABEL,
  type ContentPlan,
  type HookPattern,
  type PerformanceLog,
} from '../../src/services/sonder/types';
import type { SonderMode, SonderStore } from '../model/sonder/repo';
import { RatioBar, count } from './sonder/BeatBars';

/**
 * 성과 로그 — 올린 영상의 숫자를 남기고, 그 요약이 다음 기획안의 추천에 들어간다.
 * 저장률(저장 ÷ 조회수)을 먼저 보는 이유는 조회수가 계정 크기에 끌려가기 때문이다.
 */

const PATTERNS: HookPattern[] = ['question', 'numbers', 'howto', 'contrarian', 'story'];

interface FormState {
  planId: string;
  title: string;
  hookPattern: HookPattern;
  postedAt: string;
  views: string;
  saves: string;
  shares: string;
  follows: string;
  medianViews: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

const EMPTY: FormState = {
  planId: '',
  title: '',
  hookPattern: 'question',
  postedAt: today(),
  views: '',
  saves: '',
  shares: '',
  follows: '',
  medianViews: '',
};

const toNumber = (value: string): number => {
  const parsed = Number(value.replace(/[, ]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

export interface PerformancePanelProps {
  store: SonderStore | null;
  mode: SonderMode;
  initialPlan: ContentPlan | null;
}

export function PerformancePanel({ store, mode, initialPlan }: PerformancePanelProps) {
  const [logs, setLogs] = useState<PerformanceLog[]>([]);
  const [plans, setPlans] = useState<ContentPlan[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!store) return;
    let alive = true;
    Promise.all([store.listLogs(), store.listPlans()])
      .then(([nextLogs, nextPlans]) => {
        if (!alive) return;
        setLogs(nextLogs);
        setPlans(nextPlans);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : '성과 기록을 불러오지 못했습니다');
      });
    return () => {
      alive = false;
    };
  }, [store]);

  useEffect(() => {
    if (!initialPlan) return;
    setPlans((prev) => (prev.some((plan) => plan.id === initialPlan.id) ? prev : [initialPlan, ...prev]));
    setForm((prev) => ({
      ...prev,
      planId: initialPlan.id,
      title: initialPlan.topic,
      hookPattern: initialPlan.hooks.find((hook) => hook.id === initialPlan.chosenHook)?.pattern ?? prev.hookPattern,
    }));
  }, [initialPlan]);

  const summary = useMemo(() => summarizeLogs(logs), [logs]);

  const update = (key: keyof FormState) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
    setNotice('');
    setError('');
  };

  const add = async (): Promise<void> => {
    if (!store) return;
    if (form.title.trim().length === 0) {
      setError('영상 제목을 넣어 주세요');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await store.addLog({
        planId: form.planId || undefined,
        title: form.title,
        hookPattern: form.hookPattern,
        postedAt: form.postedAt || today(),
        views: toNumber(form.views),
        saves: toNumber(form.saves),
        shares: toNumber(form.shares),
        follows: toNumber(form.follows),
        medianViews: toNumber(form.medianViews),
      });
      setLogs(await store.listLogs());
      setNotice('기록했습니다. 다음 기획안의 추천에 반영됩니다.');
      setForm((prev) => ({ ...prev, views: '', saves: '', shares: '', follows: '' }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '기록하지 못했습니다');
    } finally {
      setBusy(false);
    }
  };

  const saveRate = (log: PerformanceLog): number => (log.views > 0 ? log.saves / log.views : 0);

  return (
    <div className="stack">
      <div className="grid kpi">
        <Kpi label="기록한 영상" value={`${summary.count}건`} sub={mode === 'cloud' ? '클라우드 저장' : '이 브라우저 저장'} />
        <Kpi label="평균 배수" value={summary.avgMultiplier ? `${summary.avgMultiplier.toFixed(2)}배` : '—'} sub="그때의 중간값 기준" />
        <Kpi
          label="저장률"
          value={`${(summary.saveRate * 100).toFixed(1)}%`}
          sub={`저장 ${count(summary.saves)} / 조회 ${count(summary.views)}`}
          tone={summary.saveRate >= 0.01 ? 'ok' : undefined}
        />
        <Kpi
          label="가장 잘 된 훅"
          value={summary.bestPattern ? HOOK_PATTERN_LABEL[summary.bestPattern] : '—'}
          sub={summary.bestPattern ? '같은 훅 2건 이상 기준' : '표본이 더 쌓여야 합니다'}
        />
      </div>

      <div className="grid sidebar">
        <Card
          eyebrow="기록"
          title="올린 영상 숫자"
          hint="조회수·저장·공유만 있으면 됩니다. 기획안과 연결하면 훅 패턴이 자동으로 들어갑니다."
        >
          <div className="form-block">
            <label className="field">
              <span>기획안 (선택)</span>
              <select
                value={form.planId}
                onChange={(event) => {
                  const next = plans.find((plan) => plan.id === event.target.value) ?? null;
                  setForm((prev) => ({
                    ...prev,
                    planId: event.target.value,
                    title: next ? next.topic : prev.title,
                    hookPattern:
                      next?.hooks.find((hook) => hook.id === next.chosenHook)?.pattern ?? prev.hookPattern,
                  }));
                }}
              >
                <option value="">연결하지 않음</option>
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.topic} · {plan.createdAt.slice(0, 10)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>영상 제목</span>
              <input type="text" value={form.title} onChange={update('title')} placeholder="3평 주방 수납 정리법" />
            </label>
            <div className="field-row">
              <label className="field">
                <span>훅 패턴</span>
                <select value={form.hookPattern} onChange={update('hookPattern')}>
                  {PATTERNS.map((pattern) => (
                    <option key={pattern} value={pattern}>
                      {HOOK_PATTERN_LABEL[pattern]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>올린 날</span>
                <input type="date" value={form.postedAt} onChange={update('postedAt')} />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>조회수</span>
                <input type="text" inputMode="numeric" value={form.views} onChange={update('views')} placeholder="82000" />
              </label>
              <label className="field">
                <span>저장</span>
                <input type="text" inputMode="numeric" value={form.saves} onChange={update('saves')} placeholder="2100" />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>공유</span>
                <input type="text" inputMode="numeric" value={form.shares} onChange={update('shares')} placeholder="320" />
              </label>
              <label className="field">
                <span>팔로우</span>
                <input type="text" inputMode="numeric" value={form.follows} onChange={update('follows')} placeholder="45" />
              </label>
            </div>
            <label className="field">
              <span>그때 평소 조회수 중간값</span>
              <input
                type="text"
                inputMode="numeric"
                value={form.medianViews}
                onChange={update('medianViews')}
                placeholder="19000"
              />
            </label>
            <Button primary onClick={() => void add()} disabled={busy || !store}>
              {busy ? '기록 중…' : '기록하기'}
            </Button>
            {error ? <p className="notice bad">{error}</p> : null}
            {notice ? <p className="notice ok">{notice}</p> : null}
          </div>
        </Card>

        <Card title="다음 기획안에 반영할 것" hint="이 문장들은 기획안 화면에서 추천 안을 고를 때 쓰입니다.">
          <ul className="plain-list">
            {summary.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
          {summary.patternRows.length > 0 ? (
            <div className="bar-stack" style={{ marginTop: 16 }}>
              {summary.patternRows.map((row) => (
                <RatioBar
                  key={row.pattern}
                  label={HOOK_PATTERN_LABEL[row.pattern]}
                  ratio={row.saveRate}
                  readout={`${(row.saveRate * 100).toFixed(1)}% · ${row.count}건`}
                  tone={row.pattern === summary.bestPattern ? 'ok' : undefined}
                />
              ))}
            </div>
          ) : null}
        </Card>
      </div>

      <Card
        title="성과 기록"
        hint="저장률은 조회수 대비 저장 비율입니다. 배수는 기록할 때의 평소 중간값으로 계산해 둡니다."
        actions={<span className="small muted">{logs.length}건</span>}
      >
        {logs.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>
            아직 기록이 없습니다. 한 편을 올린 뒤 숫자를 넣으면, 다음 기획안이 그 값을 참고합니다.
          </p>
        ) : (
          <div className="scroll" style={{ maxHeight: 'none' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>올린 날</th>
                  <th>영상</th>
                  <th>훅</th>
                  <th className="num">조회</th>
                  <th className="num">저장</th>
                  <th>저장률</th>
                  <th className="num">배수</th>
                  <th>판정</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td className="mono small">{log.postedAt}</td>
                    <td>
                      <strong>{log.title}</strong>
                      {log.planId ? <div className="small muted">기획안 연결됨</div> : null}
                    </td>
                    <td className="small">{HOOK_PATTERN_LABEL[log.hookPattern]}</td>
                    <td className="num">{count(log.views)}</td>
                    <td className="num">{count(log.saves)}</td>
                    <td>
                      <span className="bar-track" style={{ width: 110 }}>
                        <span className="bar-fill" style={{ width: `${Math.min(100, saveRate(log) * 1000)}%` }} />
                      </span>{' '}
                      <span className="small mono">{(saveRate(log) * 100).toFixed(2)}%</span>
                    </td>
                    <td className="num">{log.multiplier === null ? '—' : `${log.multiplier.toFixed(2)}배`}</td>
                    <td>
                      {log.multiplier !== null && log.multiplier >= 3 ? (
                        <Pill tone="ok">바이럴</Pill>
                      ) : log.multiplier !== null && log.multiplier >= 1.8 ? (
                        <Pill tone="ok">높음</Pill>
                      ) : (
                        <Pill tone="ghost">평소</Pill>
                      )}
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

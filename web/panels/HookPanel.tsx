import { useEffect, useMemo, useReducer, useState } from 'react';
import { Button, Card, Kpi, Pill, num, pct } from '../ui';
import { AbTest, DEFAULT_SCENARIO, SCENARIOS, type ArmId, type MetricRow } from '../model/abtest';
import { METRIC_LABEL, STAT_COLUMN } from '../model/labels';
import { HookPatternBoard } from './HookPatternBoard';

export interface HookPanelProps {
  topic: string;
  onAdopt: (text: string) => void;
}

const ANGLE_LABEL: Record<string, string> = {
  question: '질문형',
  numbers: '숫자형',
  shock: '충격형',
  howto: '방법형',
  contrarian: '역발상형',
};

/** 수집 주기는 실제 서비스에서 통계 API를 부르는 주기다. 이 화면은 수집 결과만 재현한다. */
const COLLECT_EVERY = [
  { id: 'hour', label: '1시간마다' },
  { id: 'six', label: '6시간마다' },
  { id: 'day', label: '하루 1번' },
] as const;

export function HookPanel({ topic, onAdopt }: HookPanelProps) {
  const test = useMemo(() => {
    const instance = new AbTest(topic);
    instance.loadScenario(DEFAULT_SCENARIO, topic);
    return instance;
  }, [topic]);
  // `test` is a mutable instance: state changes re-read its current numbers.
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const [scenarioId, setScenarioId] = useState(DEFAULT_SCENARIO);
  const [collectEvery, setCollectEvery] = useState<string>('six');
  const [adopted, setAdopted] = useState<ArmId | null>(null);

  // 주제가 바뀌면 새 인스턴스가 선택된 기간의 데이터를 다시 채운다. `test`는 이 화면이
  // 소유한 가변 객체라 의존성은 그것 하나면 충분하다.
  useEffect(() => {
    test.loadScenario(scenarioId, topic);
    setAdopted(null);
    bump();
  }, [test, scenarioId, topic]);

  const result = test.evaluate();
  const [a, b] = test.arms;
  const scenario = test.scenario ?? SCENARIOS[0]!;
  const periodLabel = test.window === '7d' ? '7일' : '24시간';

  const switchScenario = (id: string): void => {
    test.loadScenario(id, topic);
    setScenarioId(id);
    setAdopted(null);
    bump();
  };

  const verdict = result.winner
    ? `${result.winner}안이 낫습니다`
    : result.ready
      ? '아직 결론을 못 냅니다'
      : '표본이 부족합니다';

  return (
    <div className="stack">
      <div className="grid kpi">
        <Kpi label="비교 기간" value={periodLabel} sub={scenario.label} />
        <Kpi label="모은 표본" value={num(test.totalImpressions)} sub={`훅마다 ${num(a.impressions)}명`} />
        <Kpi
          label="판정"
          value={verdict}
          sub={result.winner ? `믿을 수 있는 정도 ${pct(result.confidence * 100, 0)}` : '표본이 더 필요합니다'}
          tone={result.winner ? 'ok' : undefined}
        />
        <Kpi label="필요한 표본" value={`${num(result.requiredSample)}/안`} sub="끝까지 본 비율 5% 차이를 가릴 때" />
      </div>

      <Card
        eyebrow="채널 통계"
        title="자동 수집과 기간"
        hint="실제 서비스는 인스타그램·유튜브 통계를 주기적으로 읽어 표본을 채웁니다. 이 화면은 수집이 끝난 상태를 예시로 재현합니다."
        actions={
          <div className="row" style={{ gap: 4 }}>
            <span className="small muted">자동 수집</span>
            {COLLECT_EVERY.map((option) => (
              <Button key={option.id} small ghost={collectEvery !== option.id} onClick={() => setCollectEvery(option.id)}>
                {option.label}
              </Button>
            ))}
          </div>
        }
      >
        <div className="grid two" style={{ gap: 14 }}>
          <div>
            <div className="meta-line" style={{ marginBottom: 12 }}>
              <span>인스타그램 통계 <strong>미연결</strong></span>
              <span className="sep" aria-hidden="true" />
              <span>유튜브 통계 <strong>미연결</strong></span>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              연결하면 위 주기로 조회수·끝까지 본 비율·댓글이 자동으로 쌓입니다. 지금은 아래에서 기간을 골라
              그 상태의 데이터를 불러옵니다.
            </p>
            <p className="note" style={{ marginTop: 10 }}>
              마지막 수집: <strong>예시 데이터</strong> · {scenario.label} · {scenario.note}
            </p>
          </div>
          <div className="preset-list">
            {SCENARIOS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === scenarioId ? 'preset active' : 'preset'}
                onClick={() => switchScenario(item.id)}
                aria-pressed={item.id === scenarioId}
              >
                <span className="preset-label">{item.label}</span>
                <span className="small muted">
                  {item.period === '7d' ? '7일' : '24시간'} · 훅마다 {num(item.perArm)}명
                </span>
              </button>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid two">
        <Card title="A/B 비교" hint={`같은 영상, 앞 3초만 다릅니다 · ${periodLabel} 집계`}>
          <div className="stack" style={{ gap: 10 }}>
            {test.arms.map((arm) => {
              const view = result.rows.find((item) => item.key === 'viewRate3s');
              const retention = result.rows.find((item) => item.key === 'retention');
              const viewCell = arm.id === 'A' ? view?.a : view?.b;
              const retentionCell = arm.id === 'A' ? retention?.a : retention?.b;
              return (
                <div
                  key={arm.id}
                  className="arm-card"
                  style={{
                    borderLeft: `3px solid ${arm.id === 'A' ? '#6d7b8c' : '#2f6fa8'}`,
                  }}
                >
                  <div className="row between" style={{ marginBottom: 4 }}>
                    <div className="row" style={{ gap: 7 }}>
                      <strong>{arm.id}안</strong>
                      <Pill tone="ghost">{ANGLE_LABEL[arm.angle ?? ''] ?? arm.angle ?? '-'}</Pill>
                      <span className="small muted">훅 {arm.hookSeconds.toFixed(2)}초</span>
                    </div>
                    <span className="small muted">{num(arm.impressions)}명에게 노출</span>
                  </div>
                  <p style={{ margin: '0 0 10px', fontSize: 15, lineHeight: 1.6, color: 'var(--ink)' }}>{arm.text}</p>
                  <div className="row" style={{ gap: 14 }}>
                    <span className="small muted">
                      3초 유지{' '}
                      <strong className="mono">{viewCell && viewCell.trials > 0 ? pct(viewCell.rate * 100, 1) : '—'}</strong>
                    </span>
                    <span className="small muted">
                      끝까지 본 비율{' '}
                      <strong className="mono">
                        {retentionCell && retentionCell.trials > 0 ? pct(retentionCell.rate * 100, 1) : '—'}
                      </strong>
                    </span>
                    <span className="small muted">
                      쿠폰 사용 <strong className="mono">{num(arm.couponClaims)}</strong>건
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card
          title="이번 판정"
          hint="끝까지 본 비율이 통계적으로 유의하고, 차이가 5% 이상일 때만 승자를 부릅니다."
          actions={
            result.winner ? (
              <Button
                primary
                small
                onClick={() => {
                  onAdopt(test.textOf(result.winner as ArmId));
                  setAdopted(result.winner);
                }}
              >
                {result.winner}안을 대본에 넣기
              </Button>
            ) : null
          }
        >
          {result.winner ? (
            <div>
              <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                <Pill tone="ok">{result.winner}안 우세</Pill>
                <span className="small muted">믿을 수 있는 정도 {pct(result.confidence * 100, 0)}</span>
              </div>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.5 }}>{test.textOf(result.winner as ArmId)}</p>
              {adopted ? (
                <p className="note" style={{ marginTop: 10 }}>
                  {adopted}안을 9:16 스튜디오의 첫 문장으로 넣었습니다. 타임라인과 자막이 다시 계산됩니다.
                </p>
              ) : (
                <p className="note" style={{ marginTop: 10 }}>
                  넣으면 스튜디오 대본의 첫 문장이 이 문장으로 바뀌고, 길이에 맞춰 자막과 장면 시간이 다시 잡힙니다.
                </p>
              )}
            </div>
          ) : (
            <div>
              <p style={{ margin: 0, fontSize: 13.5 }}>
                {result.ready ? '아직 승자를 부를 수 없습니다.' : '표본이 부족해 승자를 부르지 않습니다.'}
              </p>
              <p className="note" style={{ marginTop: 8 }}>
                {result.ready
                  ? '차이가 우연일 수 있거나 차이 자체가 작습니다. 이럴 때 “결론 없음”이 정답입니다. 대시보드가 매번 승자를 만들면 그건 통계가 아닙니다.'
                  : `훅마다 최소 200명의 노출이 필요합니다 (지금 A ${num(a.impressions)} · B ${num(b.impressions)}).`}
              </p>
            </div>
          )}
          {result.ready && result.notes.length > 0 ? (
            <ul className="small muted" style={{ margin: '12px 0 0 16px', padding: 0 }}>
              {result.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>

      <Card title="지표별 비교" hint={`${periodLabel} 집계 · 비율은 양쪽을 함께 비교해 우연일 확률을 계산합니다`}>
        <div className="scroll" style={{ maxHeight: 'none' }}>
          <table className="data">
            <thead>
              <tr>
                <th>지표</th>
                <th className="num">A안</th>
                <th className="num">B안</th>
                <th className="num">{STAT_COLUMN.lift}</th>
                <th className="num">{STAT_COLUMN.pValue}</th>
                <th>{STAT_COLUMN.interval}</th>
                <th>{STAT_COLUMN.verdict}</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <strong>{METRIC_LABEL[row.key]}</strong>
                    <div className="small muted">{row.hint}</div>
                  </td>
                  <td className="num">{row.a.trials === 0 ? '—' : pct(row.a.rate * 100, 1)}</td>
                  <td className="num">{row.b.trials === 0 ? '—' : pct(row.b.rate * 100, 1)}</td>
                  <td className="num" style={{ color: row.lift >= 0 ? 'var(--ok)' : 'var(--bad)' }}>
                    {row.a.trials === 0 || row.b.trials === 0 ? '—' : `${row.lift >= 0 ? '+' : ''}${pct(row.lift * 100, 1)}`}
                  </td>
                  <td className="num mono">{row.pValue < 0.001 ? '0.1% 미만' : pct(row.pValue * 100, 1)}</td>
                  <td>
                    <ConfidenceBar row={row} />
                  </td>
                  <td>
                    {row.a.trials === 0 || row.b.trials === 0 ? (
                      <Pill tone="ghost">자료 없음</Pill>
                    ) : row.leader === null ? (
                      <Pill tone="ghost">차이 없음</Pill>
                    ) : row.significant ? (
                      <Pill tone="ok">{row.leader}안 우세</Pill>
                    ) : (
                      <Pill tone="ghost">차이 확인 안 됨</Pill>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note" style={{ marginTop: 10 }}>
          ‘우연일 확률’이 5%보다 작아야 차이라고 부릅니다. 쿠폰 전환율은 3초 본 사람 중 쿠폰을 사용한 비율이라
          끝까지 본 비율과 따로 봅니다.
        </p>
      </Card>

      <HookPatternBoard topic={topic} />
    </div>
  );
}

function ConfidenceBar({ row }: { row: MetricRow }) {
  const max = Math.max(row.a.upper, row.b.upper, 0.01);
  const scale = (value: number): number => Math.max(0, Math.min(100, (value / max) * 100));

  return (
    <div style={{ width: 148 }}>
      <div className="ci">
        <div className="track" />
        <div
          className="range"
          style={{ left: `${scale(row.a.lower)}%`, width: `${Math.max(1, scale(row.a.upper) - scale(row.a.lower))}%`, background: 'rgba(109,123,140,0.35)' }}
        />
        <div className="point" style={{ left: `${scale(row.a.rate)}%`, background: '#6d7b8c' }} />
      </div>
      <div className="ci">
        <div className="track" />
        <div
          className="range"
          style={{ left: `${scale(row.b.lower)}%`, width: `${Math.max(1, scale(row.b.upper) - scale(row.b.lower))}%` }}
        />
        <div className="point" style={{ left: `${scale(row.b.rate)}%` }} />
      </div>
      <div className="ci-label">
        <span>{pct(row.a.lower * 100, 1)}</span>
        <span>{pct(Math.max(row.a.upper, row.b.upper) * 100, 1)}</span>
      </div>
    </div>
  );
}

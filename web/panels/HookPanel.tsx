import { useMemo, useReducer, useState } from 'react';
import { Button, Card, Kpi, Pill, num, pct } from '../ui';
import { AbTest, type ArmId, type MetricRow } from '../model/abtest';

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

export function HookPanel({ topic, onAdopt }: HookPanelProps) {
  const test = useMemo(() => new AbTest(topic), [topic]);
  // `test` is a mutable instance: any state change re-reads its current numbers.
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const [adopted, setAdopted] = useState<ArmId | null>(null);

  const result = test.evaluate();
  const [a, b] = test.arms;

  const collect = (perArm: number): void => {
    test.collect(perArm);
    bump();
  };

  return (
    <div className="stack">
      <div className="grid kpi">
        <Kpi label="실험 표본" value={num(test.totalImpressions)} sub={`훅마다 ${num(a.impressions)} 노출`} />
        <Kpi
          label="판정"
          value={
            result.winner ? (
              <span className={result.winner === 'A' ? '' : 'ok'}>{result.winner}안 우세</span>
            ) : result.ready ? (
              '결론 유보'
            ) : (
              '표본 부족'
            )
          }
          sub={`신뢰도 ${pct(result.confidence * 100, 1)} · α=0.05`}
          tone={result.winner ? 'ok' : undefined}
        />
        <Kpi label="필요 표본" value={`${num(result.requiredSample)}/안`} sub="완시율 기준 +5%p 검출" />
        <Kpi
          label="쿠폰 전환 차이"
          value={`p=${result.coupon.pValue.toFixed(3)}`}
          sub={result.coupon.pValue < 0.05 ? '유의' : '아직 구분 안 됨'}
          tone={result.coupon.pValue < 0.05 ? 'ok' : undefined}
        />
      </div>

      <div className="grid two">
        <Card
          title="훅 A/B"
          hint="같은 영상, 앞 3초만 다릅니다"
          actions={
            <>
              <Button small onClick={() => collect(500)}>
                +500
              </Button>
              <Button small onClick={() => collect(2_000)}>
                +2,000
              </Button>
              <Button
                small
                ghost
                onClick={() => {
                  test.reset(topic);
                  setAdopted(null);
                  bump();
                }}
              >
                초기화
              </Button>
            </>
          }
        >
          <div className="stack" style={{ gap: 10 }}>
            {test.arms.map((arm) => {
              const row = result.rows.find((item) => item.key === 'retention');
              const armRow = arm.id === 'A' ? row?.a : row?.b;
              return (
                <div
                  key={arm.id}
                  style={{
                    border: '1px solid var(--line)',
                    borderLeft: `3px solid ${arm.id === 'A' ? '#6d7b8c' : '#2f6fa8'}`,
                    borderRadius: 10,
                    padding: 12,
                  }}
                >
                  <div className="row between" style={{ marginBottom: 4 }}>
                    <div className="row" style={{ gap: 7 }}>
                      <strong style={{ fontSize: 13 }}>{arm.id}안</strong>
                      <Pill tone="ghost">{ANGLE_LABEL[arm.angle ?? ''] ?? arm.angle ?? '-'}</Pill>
                      <span className="small muted">훅 {arm.hookSeconds.toFixed(2)}s</span>
                    </div>
                    <span className="small muted mono">{num(arm.impressions)} 노출</span>
                  </div>
                  <p style={{ margin: '0 0 8px', fontSize: 13.5, lineHeight: 1.5 }}>{arm.text}</p>
                  <div className="row" style={{ gap: 14 }}>
                    <span className="small muted">
                      3초 유지 <strong className="mono">{pct(((armRow?.rate ?? 0) * 100), 1)}</strong>
                    </span>
                    <span className="small muted">
                      완시 {arm.completions ? num(arm.completions) : 0}건
                    </span>
                    <span className="small muted">
                      쿠폰 {num(arm.couponClaims)}건
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="divider" />
          <p className="note">
            표본을 모을수록 판정이 안정됩니다. 최소 표본(훅마다 {num(200)} 노출)에 못 미치면 엔진은 승자를 부르지
            않습니다 — 첫 100회 노출은 훅이 아니라 알고리즘 배분입니다.
          </p>
        </Card>

        <Card
          title="승자 훅"
          hint="주 지표(완시율)에서 유의하고, 상승폭이 5%p 이상일 때만 채택합니다"
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
                {result.winner}안 대본에 적용
              </Button>
            ) : null
          }
        >
          {result.winner ? (
            <div>
              <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                <Pill tone="ok">{result.winner}안 승자</Pill>
                <span className="small muted">
                  신뢰도 {pct(result.confidence * 100, 1)} · 완시율 상승 {pct((result.rows[1]?.lift ?? 0) * 100, 1)}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.5 }}>{test.textOf(result.winner as ArmId)}</p>
              {adopted ? (
                <p className="note" style={{ marginTop: 10 }}>
                  {adopted}안을 9:16 스튜디오의 훅 문장으로 넣었습니다. 탭을 옮기면 타임라인이 다시 계산되어 있습니다.
                </p>
              ) : (
                <p className="note" style={{ marginTop: 10 }}>
                  채택하면 스튜디오 대본의 훅이 이 문장으로 바뀌고, 훅 길이·자막·타임라인이 자동으로 다시 계산됩니다.
                </p>
              )}
            </div>
          ) : (
            <div>
              <p style={{ margin: 0, fontSize: 13.5 }}>
                {result.ready
                  ? '아직 승자를 부를 수 없습니다.'
                  : `훅마다 최소 200 노출이 필요합니다 (현재 A ${num(a.impressions)} · B ${num(b.impressions)}).`}
              </p>
              <p className="note" style={{ marginTop: 8 }}>
                표본이 부족하거나, 차이가 유의하지 않거나, 상승폭이 5%p에 못 미치면 “결론 유보”가 정답입니다. 대시보드가
                매번 승자를 만들면 그건 통계가 아닙니다.
              </p>
            </div>
          )}
          {result.notes.length > 0 ? (
            <ul className="small muted" style={{ margin: '12px 0 0 16px', padding: 0 }}>
              {result.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>

      <Card title="지표별 비교" hint="비율 지표는 양측 z-검정 + Wilson 95% 구간">
        <div className="scroll" style={{ maxHeight: 'none' }}>
          <table className="data">
            <thead>
              <tr>
                <th>지표</th>
                <th className="num">A안</th>
                <th className="num">B안</th>
                <th className="num">차이</th>
                <th className="num">p-value</th>
                <th>95% 구간 (A / B)</th>
                <th>판정</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <strong style={{ fontSize: 12.5 }}>{row.label}</strong>
                    <div className="small muted">{row.hint}</div>
                  </td>
                  <td className="num">{pct(row.a.rate * 100, 1)}</td>
                  <td className="num">{pct(row.b.rate * 100, 1)}</td>
                  <td className="num" style={{ color: row.lift >= 0 ? 'var(--ok)' : 'var(--bad)' }}>
                    {row.lift >= 0 ? '+' : ''}
                    {pct(row.lift * 100, 1)}
                  </td>
                  <td className="num mono">{row.pValue < 0.001 ? '<0.001' : row.pValue.toFixed(3)}</td>
                  <td>
                    <ConfidenceBar row={row} />
                  </td>
                  <td>
                    {row.leader === null ? (
                      <Pill tone="ghost">동일</Pill>
                    ) : row.significant ? (
                      <Pill tone="ok">{row.leader}안 우세</Pill>
                    ) : (
                      <Pill tone="ghost">차이 미확인</Pill>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note" style={{ marginTop: 10 }}>
          쿠폰 전환율은 <strong>3초 시청 대비 댓글 쿠폰 수령</strong>입니다. 완시율이 좋아도 전환이 따라오지 않으면
          수익은 늘지 않으므로 두 지표를 따로 봅니다.
        </p>
      </Card>
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

import { useMemo } from 'react';
import { Card, Pill, pct } from '../ui';
import { estimateHookPatterns } from '../../src/services/hookPatternSim';
import { ANGLE_BY_ID } from '../../src/services/patternLibrary';

/**
 * 훅 유형별 비교 — A/B 판정과 별개 카드.
 *
 * 여기 숫자는 실측이 아니라 휴리스틱 추정이다. 저장·공유 확률을 "측정했다"고 말하지
 * 않기 위해 카드 제목과 설명에 그대로 적고, 실제 판정은 위의 A/B(표본이 쌓인 뒤)가
 * 한다.
 */
export function HookPatternBoard({ topic }: { topic: string }) {
  const patterns = useMemo(() => estimateHookPatterns({ topic, durationSec: 45 }), [topic]);
  const maxSave = Math.max(...patterns.rows.map((row) => row.saveRate), 0.001);
  const maxShare = Math.max(...patterns.rows.map((row) => row.shareRate), 0.001);

  return (
    <Card
      title="훅 유형별 예상 저장·공유"
      hint="같은 주제로 앵글만 바꿔 쓴 훅 4종 · 경험 규칙으로 계산한 추정치이며 실측이 아닙니다."
      actions={<span className="small muted">실제 성과는 위 A/B로 확인</span>}
    >
      <div className="scroll" style={{ maxHeight: 'none' }}>
        <table className="data">
          <thead>
            <tr>
              <th>유형</th>
              <th>훅 문장</th>
              <th className="num">길이</th>
              <th className="num">3초 유지</th>
              <th>저장 전환</th>
              <th>공유 전환</th>
              <th>판단</th>
            </tr>
          </thead>
          <tbody>
            {patterns.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.label}</strong>
                  <div className="small muted">{ANGLE_BY_ID[row.angle].label}</div>
                </td>
                <td style={{ maxWidth: 280 }}>{row.example}</td>
                <td className="num mono">{row.hookSeconds.toFixed(1)}초</td>
                <td className="num mono">{pct(row.holdRate3s * 100, 1)}</td>
                <td>
                  <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                    <span className="meter" style={{ width: 72 }}>
                      <span
                        style={{
                          width: `${Math.min(100, (row.saveRate / maxSave) * 100).toFixed(0)}%`,
                          background: row.id === patterns.bestSave ? 'var(--ok)' : '#6d7b8c',
                        }}
                      />
                    </span>
                    <span className="num mono">
                      {pct(row.saveRate * 100, 2)}
                    </span>
                  </div>
                </td>
                <td>
                  <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                    <span className="meter" style={{ width: 72 }}>
                      <span
                        style={{
                          width: `${Math.min(100, (row.shareRate / maxShare) * 100).toFixed(0)}%`,
                          background: row.id === patterns.bestShare ? 'var(--ok)' : '#6d7b8c',
                        }}
                      />
                    </span>
                    <span className="num mono">
                      {pct(row.shareRate * 100, 2)}
                    </span>
                  </div>
                </td>
                <td>
                  {row.verdict.includes('우세') ? <Pill tone="ok">{row.verdict}</Pill> : <Pill tone="ghost">{row.verdict}</Pill>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="divider" />
      <div className="grid two" style={{ gap: 12 }}>
        <div>
          <h3>적용한 가중치</h3>
          <ul className="small muted" style={{ margin: '0 0 0 16px', padding: 0, lineHeight: 1.7 }}>
            {patterns.rows.map((row) => (
              <li key={row.id}>
                <strong>{row.label}</strong> — {row.factors.length > 0 ? row.factors.join(' · ') : '주제 보정 없음(기본값)'}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>읽는 법</h3>
          <ul className="small muted" style={{ margin: '0 0 0 16px', padding: 0, lineHeight: 1.7 }}>
            {patterns.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
          <p className="note" style={{ marginTop: 8 }}>
            {patterns.method} · 주제 분류 «{patterns.profile.categoryLabel}» 기준
          </p>
        </div>
      </div>
    </Card>
  );
}

import type { ReactNode } from 'react';

/**
 * 박자 비율 막대. 참고 영상의 박자와 이 기획안의 박자를 같은 자로 보여 준다.
 * 0과 1 사이의 값을 받고, 아주 작은 값도 보이도록 최소 폭을 준다.
 */
export function RatioBar({
  label,
  ratio,
  readout,
  tone,
}: {
  label: ReactNode;
  ratio: number;
  readout: ReactNode;
  tone?: 'ok' | 'warn' | 'muted';
}) {
  const width = Math.max(2, Math.min(100, ratio * 100));
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <span className={tone ? `bar-track ${tone}` : 'bar-track'}>
        <span className="bar-fill" style={{ width: `${width}%` }} />
      </span>
      <span className="bar-value mono">{readout}</span>
    </div>
  );
}

export function sec(value: number): string {
  return `${value.toFixed(1)}초`;
}

export function count(value: number): string {
  return Math.round(value).toLocaleString('ko-KR');
}
